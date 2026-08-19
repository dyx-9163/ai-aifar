import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  Approval,
  FileChangePreview,
  Item,
  MessageItem,
  ModelConnectionResult,
  ModelProfileInput,
  ModelRunMetrics,
  ReasoningItem,
  TurnRecord,
  TurnAttachment,
  WorkspaceRecord,
  WorkspaceTrustLevel,
} from '../shared/domain.js';
import {
  isDesktopRequest,
  type DesktopRequest,
  type SequencedAgentEvent,
} from '../shared/protocol.js';
import { ACTIVE_THREAD_DELETE_ERROR } from '../shared/operationErrors.js';
import { isLocalQwenServiceProfile } from '../shared/localQwenIdentity.js';
import { normalizeModelBaseUrl } from '../shared/modelProfileUrl.js';
import { safeErrorText } from '../shared/redaction.js';
import { openDatabase, type AppDatabase, type RuntimeModelProfile } from './database.js';
import { normalizeWorkspacePath } from './workspace/pathSecurity.js';
import { rollbackTurnFileChanges } from './workspace/fileCheckpoints.js';
import { runAgentLoop } from './agentLoop.js';
import { buildChatMessages } from './chatContext.js';
import {
  demoTurnTitle,
  requiresApproval,
  runDemoTurn,
  type DemoTurnInput,
  type DemoTurnOutcome,
  type EmitDemoEvent,
} from './demoAgent.js';
import {
  streamChatCompletion,
  testModelProfile,
  type ChatContentPart,
  type ChatMessage,
  type ModelStreamHandlers,
} from './modelProvider.js';
import {
  normalizeMaxConcurrency,
  normalizeMaxOutputTokens,
  normalizeProfileCapabilities,
  normalizeReasoningSettings,
} from './modelCapabilities.js';
import { ModelTurnScheduler, type ScheduledTurn } from './turnScheduler.js';

type ParentPort = {
  postMessage(message: unknown): void;
  on(eventName: 'message', listener: (message: unknown) => void): void;
  start?(): void;
};

type WorkerPort = {
  postMessage(message: unknown): void;
  on(eventName: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
};

export type SequencedEvent = SequencedAgentEvent;
type StripEnvelope<T> = T extends unknown
  ? Omit<T, 'threadId' | 'turnId' | 'modelProfileId' | 'sequence'>
  : never;
export type SequencedEventPayload = StripEnvelope<SequencedEvent>;

type StreamModel = (
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
) => Promise<ModelRunMetrics>;

type RunDemo = (
  input: DemoTurnInput,
  emit: EmitDemoEvent,
  signal: AbortSignal,
) => Promise<DemoTurnOutcome>;

export interface WorkerTurnRuntimeOptions {
  database: AppDatabase;
  postEvent(event: SequencedEvent): Promise<void> | void;
  streamModel?: StreamModel;
  runDemo?: RunDemo;
  createTurnId?: () => string;
  now?: () => string;
}

export interface WorkerTurnRuntime {
  startTurn(message: Extract<DesktopRequest, { type: 'turn.start' }>): { turnId: string };
  cancelTurn(turnId: string): boolean;
  respondApproval(approvalId: string, approved: boolean): boolean;
  updateLimit(modelProfileId: string): void;
  deleteThread(threadId: string): void;
}

type ActiveTurnContext = {
  next: ReturnType<typeof createTurnEventEmitter>;
  lastQueuePosition?: number;
};

const DEMO_PROFILE_ID = '__demo__';

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
let database: AppDatabase | undefined;
let workerPort: WorkerPort | undefined;
let turnRuntime: WorkerTurnRuntime | undefined;

parentPort?.on('message', (message) => {
  const envelope = unwrapParentMessage(message);
  if (isPortMessageData(envelope.data) && envelope.ports[0]) {
    workerPort = envelope.ports[0];
    database = openDatabase(envelope.data.databasePath);
    turnRuntime = createWorkerTurnRuntime({
      database,
      postEvent: (event) => workerPort?.postMessage(event),
    });
    workerPort.on('message', (event) => void handlePortMessage(event.data));
    workerPort.start?.();
    workerPort.postMessage({ type: 'agent.ready' });
  }
});

parentPort?.start?.();

export function createTurnEventEmitter(
  threadId: string,
  turnId: string,
  modelProfileId: string,
  sink: (event: SequencedEvent) => Promise<void>,
): (payload: SequencedEventPayload) => Promise<void> {
  let sequence = 1;
  let terminalQueued = false;
  let tail = Promise.resolve();

  return (payload) => {
    if (terminalQueued) return tail;
    if (isTerminalPayload(payload)) terminalQueued = true;

    const event = {
      ...payload,
      threadId,
      turnId,
      modelProfileId,
      sequence: sequence++,
    } as SequencedEvent;
    const delivery = tail.then(() => sink(event), () => sink(event));
    tail = delivery.catch(() => undefined);
    return delivery;
  };
}

export function createWorkerTurnRuntime(options: WorkerTurnRuntimeOptions): WorkerTurnRuntime {
  const database = options.database;
  const postEvent = options.postEvent;
  const runModel = options.streamModel ?? streamChatCompletion;
  const executeDemo = options.runDemo ?? runDemoTurn;
  const createTurnId = options.createTurnId ?? (() => `turn-${randomUUID()}`);
  const now = options.now ?? (() => new Date().toISOString());
  const active = new Map<string, ActiveTurnContext>();
  const approvalResolvers = new Map<string, (approved: boolean) => void>();

  const persistAndPost = async (event: SequencedEvent): Promise<void> => {
    persistStreamEvent(database, event, now());
    await postEvent(event);
  };

  const scheduler = new ModelTurnScheduler(
    (modelProfileId) => modelProfileId === DEMO_PROFILE_ID
      ? 1
      : database.getModelProfileForRuntime(modelProfileId)?.maxConcurrency ?? 1,
    {
      onQueued: async (turn, position) => {
        const context = active.get(turn.turnId);
        if (!context) return;
        database.updateTurn(turn.turnId, { status: 'queued' });
        context.lastQueuePosition = position;
        await context.next({ type: 'turn.queued', queuePosition: position });
      },
      onStarted: async (turn) => {
        const context = active.get(turn.turnId);
        if (!context) return;
        database.updateTurn(turn.turnId, { status: 'running', startedAt: now() });
        context.lastQueuePosition = undefined;
        await context.next({ type: 'turn.started', title: turn.title });
      },
      onCancelling: async (turn) => {
        const context = active.get(turn.turnId);
        if (!context) return;
        database.updateTurn(turn.turnId, { status: 'cancelling', incomplete: true });
        await context.next({ type: 'turn.cancelling' });
      },
      onCancelled: async (turn) => {
        const context = active.get(turn.turnId);
        if (!context) return;
        settlePendingApproval(database, turn.turnId, 'rejected', now());
        database.updateTurn(turn.turnId, {
          status: 'cancelled',
          completedAt: now(),
          incomplete: true,
        });
        try {
          await context.next({ type: 'turn.cancelled' });
        } finally {
          approvalResolvers.delete(`approval-${turn.turnId}`);
          active.delete(turn.turnId);
        }
      },
      onQueuePositions: async (_modelProfileId, positions) => {
        for (const [turnId, position] of positions) {
          const context = active.get(turnId);
          if (!context || context.lastQueuePosition === position) continue;
          database.updateTurn(turnId, { status: 'queued' });
          context.lastQueuePosition = position;
          await context.next({ type: 'turn.queued', queuePosition: position });
        }
      },
    },
  );

  const execute = async (
    turn: ScheduledTurn,
    text: string,
    profile: RuntimeModelProfile | undefined,
    workspace: WorkspaceRecord | undefined,
    history: ChatMessage[],
    attachments: TurnAttachment[],
    approvalResponse: Promise<boolean> | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const context = active.get(turn.turnId);
    if (!context) return;

    let finalMetrics: ModelRunMetrics | undefined;
    let budgetExhausted = false;
    let fileChangesRecorded = 0;
    try {
      let outcome: 'completed' | 'awaiting-approval' = 'completed';
      if (profile) {
        await context.next({
          type: 'tool.started',
          toolId: `tool-${turn.turnId}-model`,
          title: `Call ${profile.name}`,
        });
        if (workspace) {
          const requestApproval = async (request: { title: string; description: string; fileChanges?: FileChangePreview[] }): Promise<boolean> => {
            const approvalId = `approval-${turn.turnId}`;
            const response = new Promise<boolean>((resolve) => {
              approvalResolvers.set(approvalId, resolve);
            });
            await context.next({
              type: 'approval.required',
              approvalId,
              title: request.title,
              description: request.description,
              ...(request.fileChanges ? { fileChanges: request.fileChanges } : {}),
            });
            return raceWithAbort(response, signal);
          };
          const loopOutcome = await runAgentLoop({
            profile,
            toolContext: {
              canonicalRootPath: workspace.canonicalRootPath,
              trustLevel: workspace.trustLevel,
              recordFileChange: (change) => {
                fileChangesRecorded += 1;
                database.recordFileCheckpoint({
                  workspaceId: workspace.id,
                  turnId: turn.turnId,
                  relativePath: change.relativePath,
                  previousAction: change.previousAction,
                  previousContent: change.previousContent,
                  previousContentHash: change.previousContentHash,
                  latestContentHash: change.newContentHash,
                });
              },
            },
            workspaceDisplayName: workspace.displayName,
            initialMessages: withVisionAttachments(history, attachments),
            runModel,
            emit: (payload) => context.next(payload),
            signal,
            turnId: turn.turnId,
            requestApproval,
            reasoningHandlers: {
              onRawReasoningDelta: (delta) => context.next({ type: 'reasoning.raw.delta', text: delta }),
              onReasoningSummaryDelta: (delta) => context.next({ type: 'reasoning.summary.delta', text: delta }),
              onPhase: (phase) => context.next({ type: 'model.progress', phase }),
            },
          });
          finalMetrics = loopOutcome.metrics;
          budgetExhausted = loopOutcome.budgetExhausted;
        } else {
          const handlers: ModelStreamHandlers = {
            onAnswerDelta: (delta) => context.next({ type: 'answer.delta', text: delta }),
            onRawReasoningDelta: (delta) => context.next({ type: 'reasoning.raw.delta', text: delta }),
            onReasoningSummaryDelta: (delta) => context.next({ type: 'reasoning.summary.delta', text: delta }),
            onPhase: (phase) => context.next({ type: 'model.progress', phase }),
          };
          finalMetrics = await runModel(
            profile,
            [
              {
                role: 'system',
                content: 'You are a helpful private AI assistant. Keep answers clear, practical, and concise.',
              },
              ...withVisionAttachments(history, attachments),
            ],
            handlers,
            signal,
          );
        }
        throwIfAborted(signal);
        if (finalMetrics) {
          await context.next({ type: 'model.metrics', metrics: finalMetrics });
          throwIfAborted(signal);
        }
      } else {
        outcome = await executeDemo(
          {
            threadId: turn.threadId,
            turnId: turn.turnId,
            modelProfileId: DEMO_PROFILE_ID,
            text,
            approvalResponse,
          },
          context.next,
          signal,
        );
        throwIfAborted(signal);
      }

      if (outcome === 'awaiting-approval') return;
      throwIfAborted(signal);
      if (budgetExhausted) {
        // The loop never reached a natural final answer; reporting completion
        // would claim success for work that may not have happened.
        const message = fileChangesRecorded > 0
          ? `Iteration budget exhausted before the task finished; ${fileChangesRecorded} file change(s) were applied before the budget ran out. Review the answer above and send a follow-up to continue.`
          : 'Iteration budget exhausted before the task finished and no files were changed. Review the answer above and send a follow-up to continue.';
        database.failTurn(turn.turnId, now(), message);
        try {
          await context.next({ type: 'turn.failed', error: message });
        } finally {
          approvalResolvers.delete(`approval-${turn.turnId}`);
          active.delete(turn.turnId);
        }
        return;
      }
      if (!database.completeTurn(turn.turnId, now(), finalMetrics)) {
        if (signal.aborted) throw abortReason(signal);
        throw new Error(`Turn "${turn.turnId}" is no longer running.`);
      }
      try {
        await context.next({ type: 'turn.completed' });
      } catch {
        // Completion is already durable and can be reconstructed from the next snapshot.
      }
      approvalResolvers.delete(`approval-${turn.turnId}`);
      active.delete(turn.turnId);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      const message = safeErrorMessage(error, profile?.apiKey ? [profile.apiKey] : []);
      database.failTurn(turn.turnId, now(), message);
      try {
        await context.next({ type: 'turn.failed', error: message });
      } finally {
        approvalResolvers.delete(`approval-${turn.turnId}`);
        active.delete(turn.turnId);
      }
    }
  };

  return {
    startTurn(message) {
      if (scheduler.hasActiveThread(message.threadId)) {
        throw new Error(`Thread "${message.threadId}" already has an active turn`);
      }

      const selectedProfile = database.getModelProfileForRuntime(message.modelProfileId);
      const thread = database.getSnapshot().threads.find((candidate) => candidate.id === message.threadId);
      if (!thread) {
        throw new Error(`Thread "${message.threadId}" does not exist.`);
      }
      // A bound workspace is authoritative; the request payload only binds an
      // unbound thread on its first turn.
      let workspace = thread.workspaceId ? database.getWorkspace(thread.workspaceId) : undefined;
      if (thread.workspaceId && !workspace) {
        throw new Error(`Workspace "${thread.workspaceId}" is not registered.`);
      }
      if (!workspace && message.workspaceId) {
        workspace = database.getWorkspace(message.workspaceId);
        if (!workspace) {
          throw new Error(`Workspace "${message.workspaceId}" is not registered.`);
        }
        database.bindThreadWorkspace(thread.id, workspace.id);
      }
      const attachments = message.attachments ?? [];
      const selectedSupportsVision = Boolean(
        selectedProfile?.capabilities.vision ||
        (selectedProfile && isLocalQwenServiceProfile(selectedProfile)),
      );
      if (attachments.length > 0 && !selectedSupportsVision) {
        throw new Error('The selected model does not support image inputs.');
      }
      const profile = selectedProfile;
      const modelProfileId = profile?.id ?? DEMO_PROFILE_ID;
      const turnId = createTurnId();
      const createdAt = now();
      const next = createTurnEventEmitter(message.threadId, turnId, modelProfileId, persistAndPost);
      active.set(turnId, { next });
      let approvalResponse: Promise<boolean> | undefined;
      if (!profile && requiresApproval(message.text)) {
        approvalResponse = new Promise<boolean>((resolve) => {
          approvalResolvers.set(`approval-${turnId}`, resolve);
        });
      }

      const record: TurnRecord = {
        id: turnId,
        threadId: message.threadId,
        modelProfileId,
        status: 'queued',
        createdAt,
        incomplete: true,
      };
      database.createTurn(record);
      database.appendItem(userMessage(message.threadId, turnId, userDisplayText(message.text, attachments), createdAt, attachments));
      const settings = database.getSnapshot().settings;
      const history = buildChatMessages(
        database.getThreadMessages(message.threadId, settings.contextMessageLimit),
        settings.contextMessageLimit,
      );
      const scheduled: ScheduledTurn = {
        turnId,
        threadId: message.threadId,
        modelProfileId,
        title: profile ? `Chat with ${profile.name}` : demoTurnTitle(message.text),
        run: (signal) => execute(scheduled, message.text, profile, workspace, history, attachments, approvalResponse, signal),
      };
      scheduler.enqueue(scheduled);
      return { turnId };
    },
    cancelTurn(turnId) {
      const turn = database.getSnapshot().turns.find((candidate) => candidate.id === turnId);
      if (!turn || !['queued', 'running', 'cancelling'].includes(turn.status)) return false;
      const cancelled = scheduler.cancel(turnId);
      if (cancelled) {
        if (turn.status === 'running') {
          database.updateTurn(turnId, { status: 'cancelling', incomplete: true });
        }
        approvalResolvers.delete(`approval-${turnId}`);
      }
      return cancelled;
    },
    respondApproval(approvalId, approved) {
      const resolve = approvalResolvers.get(approvalId);
      if (!resolve) return false;
      const approval = database.getSnapshot().approvals.find((candidate) => candidate.id === approvalId);
      if (!approval || approval.status !== 'pending') return false;
      database.upsertApproval({
        ...approval,
        status: approved ? 'approved' : 'rejected',
        respondedAt: now(),
      });
      approvalResolvers.delete(approvalId);
      resolve(approved);
      return true;
    },
    updateLimit(modelProfileId) {
      scheduler.updateLimit(modelProfileId);
    },
    deleteThread(threadId) {
      if (scheduler.hasActiveThread(threadId)) {
        throw new Error(ACTIVE_THREAD_DELETE_ERROR);
      }
      database.deleteThread(threadId);
    },
  };
}

async function handlePortMessage(message: unknown): Promise<void> {
  if (!isAgentRequest(message) || !isDesktopRequest(message.request)) return;
  try {
    const data = await handleDesktopRequest(message.request);
    postReply(message.requestId, true, data);
  } catch (error) {
    postReply(message.requestId, false, undefined, safeErrorMessage(error));
  }
}

async function handleDesktopRequest(message: DesktopRequest): Promise<unknown> {
  if (!database || !turnRuntime) throw new Error('Database is not ready.');

  if (message.type === 'snapshot.get') return database.getSnapshot();
  if (message.type === 'thread.create') return database.createThread(message.title, message.workspaceId);
  if (message.type === 'thread.delete') return turnRuntime.deleteThread(message.threadId);
  if (message.type === 'thread.pin') return database.setThreadPinned(message.threadId, message.pinned);
  if (message.type === 'thread.setModel') return database.setThreadModel(message.threadId, message.modelProfileId || undefined);
  if (message.type === 'modelProfile.save') {
    const profile = database.saveModelProfile(message.profile);
    turnRuntime.updateLimit(profile.id);
    return profile;
  }
  if (message.type === 'modelProfile.delete') return database.deleteModelProfile(message.id);
  if (message.type === 'modelProfile.test') return testRuntimeModelProfileConnection(message.profile, database);
  if (message.type === 'language.set') return database.setLanguage(message.language);
  if (message.type === 'settings.update') return database.updateSettings(message.settings);
  if (message.type === 'approval.respond') {
    requireAcceptedApprovalResponse(turnRuntime, message.approvalId, message.approved);
    return undefined;
  }
  if (message.type === 'turn.cancel') return turnRuntime.cancelTurn(message.turnId);
  if (message.type === 'turn.undo') {
    const turn = database.getSnapshot().turns.find((candidate) => candidate.id === message.turnId);
    if (turn && ['queued', 'running', 'cancelling'].includes(turn.status)) {
      throw new Error(`Turn "${message.turnId}" is still active.`);
    }
    return rollbackTurnFileChanges(database, message.turnId);
  }
  if (message.type === 'turn.start') return turnRuntime.startTurn(message);
  if (message.type === 'workspace.register') {
    return registerWorkspaceFromPath(database, { path: message.path, trustLevel: message.trustLevel });
  }
  if (message.type === 'workspace.delete') return database.deleteWorkspace(message.workspaceId);
  if (message.type === 'workspace.setTrust') return database.setWorkspaceTrust(message.workspaceId, message.trustLevel);
  return undefined;
}

/**
 * Canonicalizes a user-selected directory through the workspace path security
 * rules before persisting it, so the stored `canonicalRootPath` is the exact
 * value every later containment check compares against.
 */
export function registerWorkspaceFromPath(
  db: Pick<AppDatabase, 'registerWorkspace'>,
  input: { path: string; trustLevel: WorkspaceTrustLevel },
  normalize: (value: string) => string = normalizeWorkspacePath,
): WorkspaceRecord {
  const canonicalRootPath = normalize(input.path);
  return db.registerWorkspace({
    displayName: basename(canonicalRootPath) || canonicalRootPath,
    rootPath: input.path.trim(),
    canonicalRootPath,
    trustLevel: input.trustLevel,
  });
}

export function requireAcceptedApprovalResponse(
  runtime: Pick<WorkerTurnRuntime, 'respondApproval'>,
  approvalId: string,
  approved: boolean,
): void {
  if (!runtime.respondApproval(approvalId, approved)) {
    throw new Error(`Approval "${approvalId}" is no longer pending.`);
  }
}

function persistStreamEvent(database: AppDatabase, event: SequencedEvent, createdAt: string): void {
  if (event.type === 'message.delta' || event.type === 'answer.delta') {
    database.appendItem(assistantMessage(event.threadId, event.turnId, event.text, createdAt));
  } else if (event.type === 'reasoning.raw.delta') {
    database.appendItem(reasoningItem(event.threadId, event.turnId, 'raw', event.text, createdAt));
  } else if (event.type === 'reasoning.summary.delta') {
    database.appendItem(reasoningItem(event.threadId, event.turnId, 'summary', event.text, createdAt));
  } else if (event.type === 'approval.required') {
    database.upsertApproval(approvalFromEvent(event, createdAt));
  }
}

export function testRuntimeModelProfileConnection(
  input: ModelProfileInput,
  db: AppDatabase,
  connectionTest: (profile: RuntimeModelProfile) => Promise<ModelConnectionResult> = testModelProfile,
): Promise<ModelConnectionResult> {
  return connectionTest(runtimeProfileFromInput(input, db));
}

function runtimeProfileFromInput(input: ModelProfileInput, db: AppDatabase): RuntimeModelProfile {
  const existing = input.id ? db.getModelProfileForRuntime(input.id) : undefined;
  const reasoningInput = { ...existing?.reasoning, ...input.reasoning };
  const capabilities = normalizeProfileCapabilities(
    input.capabilities,
    existing?.capabilities,
    reasoningInput.protocol ?? 'none',
  );
  const reasoning = normalizeReasoningSettings(reasoningInput, capabilities);
  return {
    id: input.id ?? 'unsaved-test-profile',
    name: input.name.trim(),
    provider: input.provider,
    baseUrl: normalizeModelBaseUrl(input.baseUrl),
    model: input.model.trim(),
    apiKey: input.apiKey?.trim() || existing?.apiKey,
    apiKeyConfigured: Boolean(input.apiKey?.trim() || existing?.apiKey),
    capabilities,
    reasoning,
    maxConcurrency: normalizeMaxConcurrency(
      input.maxConcurrency ?? existing?.maxConcurrency ?? capabilities.concurrency.defaultLimit,
      capabilities,
    ),
    maxOutputTokens: normalizeMaxOutputTokens(input.maxOutputTokens ?? existing?.maxOutputTokens),
    responseSpeed: input.responseSpeed ?? existing?.responseSpeed ?? 'standard',
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function postReply(requestId: string, ok: boolean, data?: unknown, error?: string): void {
  workerPort?.postMessage(ok
    ? { type: 'agent.reply', requestId, ok, data }
    : { type: 'agent.reply', requestId, ok, error });
}

function userMessage(
  threadId: string,
  turnId: string,
  text: string,
  createdAt: string,
  attachments: TurnAttachment[] = [],
): Item {
  return {
    id: `item-${turnId}-user`,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt,
  };
}

function userDisplayText(text: string, attachments: TurnAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const names = attachments.map((attachment) => attachment.name).join(', ');
  return `${text}\n\n[已上传图片: ${names}]`;
}

function withVisionAttachments(history: ChatMessage[], attachments: TurnAttachment[]): ChatMessage[] {
  if (attachments.length === 0) {
    return history;
  }
  const next = [...history];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message?.role !== 'user') {
      continue;
    }
    const text = typeof message.content === 'string'
      ? message.content.replace(/\n\n\[已上传图片: .+\]$/, '')
      : '';
    const content: ChatContentPart[] = [
      { type: 'text', text },
      ...attachments.map((attachment) => ({
        type: 'image_url' as const,
        image_url: { url: attachment.dataUrl },
      })),
    ];
    next[index] = { ...message, content };
    return next;
  }
  return [
    ...next,
    {
      role: 'user',
      content: [
        { type: 'text', text: '请识别并描述上传的图片。' },
        ...attachments.map((attachment) => ({
          type: 'image_url' as const,
          image_url: { url: attachment.dataUrl },
        })),
      ],
    },
  ];
}

function assistantMessage(threadId: string, turnId: string, text: string, createdAt: string): MessageItem {
  return {
    id: `item-${turnId}-assistant`,
    threadId,
    turnId,
    kind: 'message',
    role: 'assistant',
    text,
    incomplete: true,
    createdAt,
  };
}

function reasoningItem(
  threadId: string,
  turnId: string,
  mode: ReasoningItem['mode'],
  text: string,
  createdAt: string,
): ReasoningItem {
  return {
    id: `item-${turnId}-reasoning-${mode}`,
    threadId,
    turnId,
    kind: 'reasoning',
    mode,
    text,
    incomplete: true,
    createdAt,
  };
}

function approvalFromEvent(
  event: Extract<SequencedEvent, { type: 'approval.required' }>,
  createdAt: string,
): Approval {
  return {
    id: event.approvalId,
    threadId: event.threadId,
    turnId: event.turnId,
    title: event.title,
    description: event.description,
    ...(event.fileChanges ? { fileChanges: event.fileChanges } : {}),
    status: 'pending',
    createdAt,
  };
}

function settlePendingApproval(
  database: AppDatabase,
  turnId: string,
  status: 'approved' | 'rejected',
  respondedAt: string,
): void {
  const approval = database.getSnapshot().approvals.find(
    (candidate) => candidate.turnId === turnId && candidate.status === 'pending',
  );
  if (!approval) return;
  database.upsertApproval({ ...approval, status, respondedAt });
}

function isTerminalPayload(payload: SequencedEventPayload): boolean {
  return payload.type === 'turn.completed'
    || payload.type === 'turn.failed'
    || payload.type === 'turn.cancelled';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Rejects a pending promise with the abort reason when the turn is cancelled. */
function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
    pending.then(resolve, reject);
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Turn was cancelled.', 'AbortError');
}

function safeErrorMessage(error: unknown, secrets: string[] = []): string {
  return safeErrorText(error, secrets, 500);
}

function unwrapParentMessage(value: unknown): { data: unknown; ports: WorkerPort[] } {
  if (
    typeof value === 'object'
    && value !== null
    && 'data' in value
    && 'ports' in value
    && Array.isArray(value.ports)
  ) {
    return { data: value.data, ports: value.ports as WorkerPort[] };
  }
  return { data: value, ports: [] };
}

function isPortMessageData(value: unknown): value is { type: 'agent.port'; databasePath: string } {
  return (
    typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'agent.port'
    && 'databasePath' in value
    && typeof value.databasePath === 'string'
  );
}

function isAgentRequest(value: unknown): value is { type: 'agent.request'; requestId: string; request: unknown } {
  return (
    typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'agent.request'
    && 'requestId' in value
    && typeof value.requestId === 'string'
    && 'request' in value
  );
}
