import type { Approval, Item, ModelProfileInput } from '../shared/domain.js';
import { isDesktopRequest, type AgentEvent, type DesktopRequest } from '../shared/protocol.js';
import { openDatabase, type AppDatabase, type RuntimeModelProfile } from './database.js';
import { buildChatMessages } from './chatContext.js';
import { requiresApproval, runDemoTurn } from './demoAgent.js';
import { streamChatCompletion, testModelProfile, type ChatMessage } from './modelProvider.js';
import {
  normalizeMaxConcurrency,
  normalizeModelCapabilities,
  normalizeReasoningSettings,
} from './modelCapabilities.js';

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

type SequencedEvent = Exclude<AgentEvent, { type: 'snapshot' }>;
type StripEnvelope<T> = T extends unknown ? Omit<T, 'threadId' | 'turnId' | 'modelProfileId' | 'sequence'> : never;
type SequencedEventPayload = StripEnvelope<SequencedEvent>;

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const activeTurns = new Map<string, AbortController>();
let database: AppDatabase | undefined;
let workerPort: WorkerPort | undefined;

parentPort?.on('message', (message) => {
  const envelope = unwrapParentMessage(message);
  if (isPortMessageData(envelope.data) && envelope.ports[0]) {
    workerPort = envelope.ports[0];
    database = openDatabase(envelope.data.databasePath);
    workerPort.on('message', (event) => void handlePortMessage(event.data));
    workerPort.start?.();
    workerPort.postMessage({ type: 'agent.ready' });
    return;
  }
});

parentPort?.start?.();

async function handlePortMessage(message: unknown): Promise<void> {
  if (!isAgentRequest(message) || !isDesktopRequest(message.request)) {
    return;
  }

  try {
    const data = await handleDesktopRequest(message.request);
    postReply(message.requestId, true, data);
  } catch (error) {
    postReply(message.requestId, false, undefined, error instanceof Error ? error.message : 'Agent request failed.');
  }
}

async function handleDesktopRequest(message: DesktopRequest): Promise<unknown> {
  if (!database) {
    throw new Error('Database is not ready.');
  }

  if (message.type === 'snapshot.get') {
    return database.getSnapshot();
  }

  if (message.type === 'thread.create') {
    return database.createThread(message.title, message.groupId);
  }

  if (message.type === 'thread.delete') {
    database.deleteThread(message.threadId);
    return undefined;
  }

  if (message.type === 'group.create') {
    return database.createGroup(message.name);
  }

  if (message.type === 'group.delete') {
    database.deleteGroup(message.groupId);
    return undefined;
  }

  if (message.type === 'thread.setModel') {
    database.setThreadModel(message.threadId, message.modelProfileId || undefined);
    return undefined;
  }

  if (message.type === 'modelProfile.save') {
    return database.saveModelProfile(message.profile);
  }

  if (message.type === 'modelProfile.delete') {
    database.deleteModelProfile(message.id);
    return undefined;
  }

  if (message.type === 'modelProfile.test') {
    const profile = runtimeProfileFromInput(message.profile, database);
    return testModelProfile(profile);
  }

  if (message.type === 'language.set') {
    database.setLanguage(message.language);
    return undefined;
  }

  if (message.type === 'settings.update') {
    return database.updateSettings(message.settings);
  }

  if (message.type === 'approval.respond') {
    const snapshot = database.getSnapshot();
    const existing = snapshot.approvals.find((approval) => approval.id === message.approvalId);
    if (existing) {
      database.upsertApproval({
        ...existing,
        status: message.approved ? 'approved' : 'rejected',
        respondedAt: new Date().toISOString(),
      });
    }
    return undefined;
  }

  if (message.type === 'turn.cancel') {
    activeTurns.get(message.turnId)?.abort();
    activeTurns.delete(message.turnId);
    return undefined;
  }

  if (message.type === 'turn.start') {
    const turnId = `turn-${Date.now().toString(36)}`;
    const controller = new AbortController();
    activeTurns.set(turnId, controller);
    database.appendItem(userMessage(message.threadId, turnId, message.text));

    const settings = database.getSnapshot().settings;
    const selectedProfile = database.getModelProfileForRuntime(message.modelProfileId);
    const useModelProvider = selectedProfile && !requiresApproval(message.text);
    const turn = useModelProvider
      ? runModelTurn(
          message.threadId,
          turnId,
          selectedProfile,
          buildChatMessages(database.getThreadMessages(message.threadId, settings.contextMessageLimit), settings.contextMessageLimit),
          controller.signal,
        )
      : runDemoTurn(
          {
            threadId: message.threadId,
            turnId,
            text: message.text,
          },
          persistAndPostEvent,
          controller.signal,
        );

    void turn.finally(() => activeTurns.delete(turnId));
    return { turnId };
  }

  return undefined;
}

async function runModelTurn(
  threadId: string,
  turnId: string,
  profile: RuntimeModelProfile,
  history: ChatMessage[],
  signal: AbortSignal,
): Promise<void> {
  let sequence = 1;
  const next = async (event: SequencedEventPayload) => {
    const sequenced = { ...event, threadId, turnId, modelProfileId: profile.id, sequence: sequence++ } as SequencedEvent;
    await persistAndPostEvent(sequenced);
  };

  try {
    await next({ type: 'turn.started', title: `Chat with ${profile.name}` });
    await next({ type: 'tool.started', toolId: `tool-${turnId}-model`, title: `Call ${profile.name}` });
    const metrics = await streamChatCompletion(
      profile,
      [
        {
          role: 'system',
          content: 'You are a helpful private AI assistant. Keep answers clear, practical, and concise.',
        },
        ...history,
      ],
      async (delta) => next({ type: 'message.delta', text: delta }),
      signal,
      undefined,
      undefined,
      async (phase) => next({ type: 'model.progress', phase }),
    );
    await next({ type: 'model.metrics', metrics });
    await next({ type: 'turn.completed' });
  } catch (error) {
    await next({ type: 'turn.failed', error: error instanceof Error ? error.message : 'Model request failed.' });
  }
}

async function persistAndPostEvent(event: AgentEvent): Promise<void> {
  if (event.type === 'message.delta') {
    database?.appendItem(assistantMessage(event.threadId, event.turnId, event.sequence, event.text));
  }
  if (event.type === 'approval.required') {
    database?.upsertApproval(approvalFromEvent(event));
  }
  workerPort?.postMessage(event);
}

function runtimeProfileFromInput(input: ModelProfileInput, db: AppDatabase): RuntimeModelProfile {
  const existing = input.id ? db.getModelProfileForRuntime(input.id) : undefined;
  const reasoningInput = { ...existing?.reasoning, ...input.reasoning };
  const capabilities = normalizeModelCapabilities(
    input.capabilities ?? existing?.capabilities,
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
  workerPort?.postMessage(ok ? { type: 'agent.reply', requestId, ok, data } : { type: 'agent.reply', requestId, ok, error });
}

function userMessage(threadId: string, turnId: string, text: string): Item {
  return {
    id: `item-${turnId}-user`,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    createdAt: new Date().toISOString(),
  };
}

function assistantMessage(threadId: string, turnId: string, sequence: number, text: string): Item {
  return {
    id: `item-${turnId}-assistant-${sequence}`,
    threadId,
    turnId,
    kind: 'message',
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
  };
}

function approvalFromEvent(event: Extract<AgentEvent, { type: 'approval.required' }>): Approval {
  return {
    id: event.approvalId,
    threadId: event.threadId,
    turnId: event.turnId,
    title: event.title,
    description: event.description,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function unwrapParentMessage(value: unknown): { data: unknown; ports: WorkerPort[] } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'ports' in value &&
    Array.isArray(value.ports)
  ) {
    return { data: value.data, ports: value.ports as WorkerPort[] };
  }

  return { data: value, ports: [] };
}

function isPortMessageData(value: unknown): value is { type: 'agent.port'; databasePath: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'agent.port' &&
    'databasePath' in value &&
    typeof value.databasePath === 'string'
  );
}

function isAgentRequest(value: unknown): value is { type: 'agent.request'; requestId: string; request: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'agent.request' &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'request' in value
  );
}
