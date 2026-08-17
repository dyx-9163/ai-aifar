import { randomUUID } from 'node:crypto';
import type {
  Approval,
  Item,
  MessageItem,
  ModelProfileInput,
  ModelRunMetrics,
  ReasoningItem,
  TurnRecord,
} from '../shared/domain.js';
import {
  isDesktopRequest,
  type DesktopRequest,
  type SequencedAgentEvent,
} from '../shared/protocol.js';
import { openDatabase, type AppDatabase, type RuntimeModelProfile } from './database.js';
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
  type ChatMessage,
  type ModelStreamHandlers,
} from './modelProvider.js';
import {
  normalizeMaxConcurrency,
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
      onCancelled: async (turn) => {
        const context = active.get(turn.turnId);
        if (!context) return;
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
    history: ChatMessage[],
    approvalResponse: Promise<boolean> | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const context = active.get(turn.turnId);
    if (!context) return;

    try {
      let outcome: 'completed' | 'awaiting-approval' = 'completed';
      if (profile) {
        await context.next({
          type: 'tool.started',
          toolId: `tool-${turn.turnId}-model`,
          title: `Call ${profile.name}`,
        });
        const handlers: ModelStreamHandlers = {
          onAnswerDelta: (delta) => context.next({ type: 'answer.delta', text: delta }),
          onRawReasoningDelta: (delta) => context.next({ type: 'reasoning.raw.delta', text: delta }),
          onReasoningSummaryDelta: (delta) => context.next({ type: 'reasoning.summary.delta', text: delta }),
          onPhase: (phase) => context.next({ type: 'model.progress', phase }),
        };
        const metrics = await runModel(
          profile,
          [
            {
              role: 'system',
              content: 'You are a helpful private AI assistant. Keep answers clear, practical, and concise.',
            },
            ...history,
          ],
          handlers,
          signal,
        );
        throwIfAborted(signal);
        await context.next({ type: 'model.metrics', metrics });
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
      database.completeTurn(turn.turnId, now());
      await context.next({ type: 'turn.completed' });
      approvalResolvers.delete(`approval-${turn.turnId}`);
      active.delete(turn.turnId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = safeErrorMessage(error, profile?.apiKey ? [profile.apiKey] : []);
      database.updateTurn(turn.turnId, {
        status: 'failed',
        completedAt: now(),
        error: message,
        incomplete: true,
      });
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
      const profile = selectedProfile && !requiresApproval(message.text) ? selectedProfile : undefined;
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
      database.appendItem(userMessage(message.threadId, turnId, message.text, createdAt));
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
        run: (signal) => execute(scheduled, message.text, profile, history, approvalResponse, signal),
      };
      scheduler.enqueue(scheduled);
      return { turnId };
    },
    cancelTurn(turnId) {
      return scheduler.cancel(turnId);
    },
    respondApproval(approvalId, approved) {
      const resolve = approvalResolvers.get(approvalId);
      if (!resolve) return false;
      approvalResolvers.delete(approvalId);
      resolve(approved);
      return true;
    },
    updateLimit(modelProfileId) {
      scheduler.updateLimit(modelProfileId);
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
  if (message.type === 'thread.create') return database.createThread(message.title, message.groupId);
  if (message.type === 'thread.delete') return database.deleteThread(message.threadId);
  if (message.type === 'group.create') return database.createGroup(message.name);
  if (message.type === 'group.delete') return database.deleteGroup(message.groupId);
  if (message.type === 'thread.setModel') return database.setThreadModel(message.threadId, message.modelProfileId || undefined);
  if (message.type === 'modelProfile.save') {
    const profile = database.saveModelProfile(message.profile);
    turnRuntime.updateLimit(profile.id);
    return profile;
  }
  if (message.type === 'modelProfile.delete') return database.deleteModelProfile(message.id);
  if (message.type === 'modelProfile.test') return testModelProfile(runtimeProfileFromInput(message.profile, database));
  if (message.type === 'language.set') return database.setLanguage(message.language);
  if (message.type === 'settings.update') return database.updateSettings(message.settings);
  if (message.type === 'approval.respond') {
    const snapshot = database.getSnapshot();
    const existing = snapshot.approvals.find((approval) => approval.id === message.approvalId);
    if (existing) {
      database.upsertApproval({
        ...existing,
        status: message.approved ? 'approved' : 'rejected',
        respondedAt: new Date().toISOString(),
      });
      turnRuntime.respondApproval(message.approvalId, message.approved);
    }
    return undefined;
  }
  if (message.type === 'turn.cancel') return turnRuntime.cancelTurn(message.turnId);
  if (message.type === 'turn.start') return turnRuntime.startTurn(message);
  return undefined;
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
    baseUrl: input.baseUrl.trim().replace(/\/$/, ''),
    model: input.model.trim(),
    apiKey: input.apiKey?.trim() || existing?.apiKey,
    apiKeyConfigured: Boolean(input.apiKey?.trim() || existing?.apiKey),
    capabilities,
    reasoning,
    maxConcurrency: normalizeMaxConcurrency(
      input.maxConcurrency ?? existing?.maxConcurrency ?? capabilities.concurrency.defaultLimit,
      capabilities,
    ),
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

function userMessage(threadId: string, turnId: string, text: string, createdAt: string): Item {
  return {
    id: `item-${turnId}-user`,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    createdAt,
  };
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
    status: 'pending',
    createdAt,
  };
}

function isTerminalPayload(payload: SequencedEventPayload): boolean {
  return payload.type === 'turn.completed'
    || payload.type === 'turn.failed'
    || payload.type === 'turn.cancelled';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Turn was cancelled.', 'AbortError');
}

function safeErrorMessage(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : 'Agent request failed.';
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  message = message
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '[REDACTED]')
    .replace(/bearer\s+[^\s,;]+/gi, '[REDACTED]')
    .trim();
  return (message || 'Agent request failed.').slice(0, 500);
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
