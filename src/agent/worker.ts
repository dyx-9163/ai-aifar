import type { Approval, Item } from '../shared/domain.js';
import { isDesktopRequest, type AgentEvent, type DesktopRequest } from '../shared/protocol.js';
import { openDatabase, type AppDatabase } from './database.js';
import { runDemoTurn } from './demoAgent.js';

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
    return database.createThread(message.title);
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
    void runDemoTurn(
      {
        threadId: message.threadId,
        turnId,
        text: message.text,
      },
      (event) => {
        if (event.type === 'message.delta') {
          database?.appendItem(assistantMessage(event.threadId, event.turnId, event.sequence, event.text));
        }
        if (event.type === 'approval.required') {
          database?.upsertApproval(approvalFromEvent(event));
        }
        workerPort?.postMessage(event);
      },
      controller.signal,
    ).finally(() => activeTurns.delete(turnId));
    return { turnId };
  }

  return undefined;
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
