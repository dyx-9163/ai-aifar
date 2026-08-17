import type {
  Approval,
  AppSnapshot,
  Item,
  MessageItem,
  ReasoningItem,
  ReasoningOutputMode,
  ThreadRuntimeState,
  TurnRecord,
} from '../shared/domain';
import type { AgentEvent, SequencedAgentEvent } from '../shared/protocol';

export interface AgentClientState {
  snapshot: AppSnapshot;
  activeThreadId?: string;
  activeGroupId?: string;
  events: AgentEvent[];
  lastSequenceByTurn: Record<string, number>;
  runtimeByThread: Record<string, ThreadRuntimeState>;
  pendingApproval?: Approval;
}

export function emptyAgentClientState(): AgentClientState {
  return {
    snapshot: {
      groups: [],
      threads: [],
      turns: [],
      items: {},
      approvals: [],
      modelProfiles: [],
      settings: {
        theme: 'system',
        language: 'en-US',
        showModelMetrics: true,
        contextMessageLimit: 20,
        reasoningDisplayMode: 'auto',
      },
    },
    events: [],
    lastSequenceByTurn: {},
    runtimeByThread: {},
  };
}

export function reduceAgentEvent(state: AgentClientState, event: AgentEvent): AgentClientState {
  if (event.type === 'snapshot') {
    const activeThreadId = event.snapshot.threads.some((thread) => thread.id === state.activeThreadId)
      ? state.activeThreadId
      : event.snapshot.threads[0]?.id;
    const activeThread = event.snapshot.threads.find((thread) => thread.id === activeThreadId);
    const snapshot = reconcileSnapshot(state.snapshot, event.snapshot);
    return {
      ...state,
      snapshot,
      runtimeByThread: runtimeFromTurns(snapshot.turns ?? []),
      activeThreadId,
      activeGroupId: activeThread?.groupId ?? state.activeGroupId ?? event.snapshot.groups[0]?.id,
      pendingApproval: snapshot.approvals.find((approval) => approval.status === 'pending'),
    };
  }

  const turnKey = `${event.threadId}:${event.turnId}`;
  if (event.sequence <= (state.lastSequenceByTurn[turnKey] ?? -1)) {
    return state;
  }

  let nextState: AgentClientState = {
    ...state,
    events: [...state.events, event],
    lastSequenceByTurn: { ...state.lastSequenceByTurn, [turnKey]: event.sequence },
    runtimeByThread: reduceRuntimeByThread(state.runtimeByThread, event),
  };

  if (event.type === 'message.delta' || event.type === 'answer.delta') {
    nextState = applyAssistantDeltaToSnapshot(nextState, event.threadId, event.turnId, event.text);
  } else if (event.type === 'reasoning.raw.delta') {
    nextState = applyReasoningDeltaToSnapshot(nextState, event.threadId, event.turnId, 'raw', event.text);
  } else if (event.type === 'reasoning.summary.delta') {
    nextState = applyReasoningDeltaToSnapshot(nextState, event.threadId, event.turnId, 'summary', event.text);
  }

  if (event.type === 'approval.required') {
    nextState = {
      ...nextState,
      pendingApproval: {
        id: event.approvalId,
        threadId: event.threadId,
        turnId: event.turnId,
        title: event.title,
        description: event.description,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (isTerminalEvent(event)) {
    nextState = {
      ...nextState,
      snapshot: event.type === 'turn.completed'
        ? markTurnContentComplete(nextState.snapshot, event.threadId, event.turnId)
        : nextState.snapshot,
      pendingApproval:
        nextState.pendingApproval?.threadId === event.threadId && nextState.pendingApproval.turnId === event.turnId
          ? undefined
          : nextState.pendingApproval,
    };
  }

  return nextState;
}

export function appendOptimisticUserMessage(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  text: string,
): AgentClientState {
  const item: Item = {
    id: `item-${turnId}-user`,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    createdAt: new Date().toISOString(),
  };
  const existingItems = state.snapshot.items[threadId] ?? [];
  if (existingItems.some((existing) => existing.id === item.id)) {
    return state;
  }

  return replaceThreadItems(state, threadId, [...existingItems, item]);
}

export function applyAssistantDeltaToSnapshot(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  text: string,
): AgentClientState {
  return applyTextDeltaToSnapshot(state, threadId, turnId, 'answer', text);
}

function applyReasoningDeltaToSnapshot(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  mode: ReasoningOutputMode,
  text: string,
): AgentClientState {
  return applyTextDeltaToSnapshot(state, threadId, turnId, `reasoning:${mode}`, text);
}

function applyTextDeltaToSnapshot(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  stream: 'answer' | `reasoning:${ReasoningOutputMode}`,
  text: string,
): AgentClientState {
  const existingItems = state.snapshot.items[threadId] ?? [];
  const key = `${stream}:${turnId}`;
  const matching = existingItems.filter((item) => logicalStreamKey(item) === key);
  const firstMatch = matching[0];

  if (firstMatch && isTextStreamItem(firstMatch)) {
    const combinedExisting = matching
      .filter(isTextStreamItem)
      .reduce((combined, item) => reconcileStreamText(combined, item.text), '');
    const updated: Item = { ...firstMatch, text: combinedExisting + text, incomplete: true };
    let inserted = false;
    const nextItems = existingItems.flatMap((item) => {
      if (logicalStreamKey(item) !== key) return [item];
      if (inserted) return [];
      inserted = true;
      return [updated];
    });
    return replaceThreadItems(state, threadId, nextItems);
  }

  const createdAt = new Date().toISOString();
  const item: MessageItem | ReasoningItem = stream === 'answer'
    ? {
        id: `item-${turnId}-assistant-live`,
        threadId,
        turnId,
        kind: 'message',
        role: 'assistant',
        text,
        incomplete: true,
        createdAt,
      }
    : {
        id: `item-${turnId}-reasoning-${stream.slice('reasoning:'.length)}-live`,
        threadId,
        turnId,
        kind: 'reasoning',
        mode: stream.slice('reasoning:'.length) as ReasoningOutputMode,
        text,
        incomplete: true,
        createdAt,
      };
  return replaceThreadItems(state, threadId, [...existingItems, item]);
}

function replaceThreadItems(state: AgentClientState, threadId: string, items: Item[]): AgentClientState {
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      items: { ...state.snapshot.items, [threadId]: items },
    },
  };
}

function reduceRuntimeByThread(
  runtimes: Record<string, ThreadRuntimeState>,
  event: SequencedAgentEvent,
): Record<string, ThreadRuntimeState> {
  const current = runtimes[event.threadId];
  const sameTurn = current?.turnId === event.turnId;
  if (current && !sameTurn && isActiveStatus(current.status) && isTerminalEvent(event)) {
    return runtimes;
  }

  const now = Date.now();
  const base: ThreadRuntimeState = sameTurn
    ? { ...current, modelProfileId: event.modelProfileId }
    : { threadId: event.threadId, turnId: event.turnId, modelProfileId: event.modelProfileId, status: 'running' };
  let runtime: ThreadRuntimeState;

  switch (event.type) {
    case 'turn.queued':
      runtime = { ...base, status: 'queued', queuePosition: event.queuePosition, error: undefined };
      break;
    case 'turn.started':
      runtime = { ...base, status: 'running', queuePosition: undefined, startedAt: sameTurn ? current.startedAt ?? now : now, error: undefined };
      break;
    case 'turn.completed':
      runtime = { ...base, status: 'completed', queuePosition: undefined, completedAt: now, error: undefined };
      break;
    case 'turn.failed':
      runtime = { ...base, status: 'failed', queuePosition: undefined, completedAt: now, error: event.error };
      break;
    case 'turn.cancelled':
      runtime = { ...base, status: 'cancelled', queuePosition: undefined, completedAt: now, error: undefined };
      break;
    case 'model.metrics':
      runtime = { ...base, tokensPerSecond: event.metrics.tokensPerSecond };
      break;
    case 'message.delta':
    case 'answer.delta':
    case 'reasoning.raw.delta':
    case 'reasoning.summary.delta':
      runtime = {
        ...base,
        status: base.status === 'cancelling' ? 'cancelling' : 'running',
        firstTokenAt: base.firstTokenAt ?? now,
      };
      break;
    default:
      runtime = base;
  }

  return { ...runtimes, [event.threadId]: runtime };
}

function runtimeFromTurns(turns: TurnRecord[]): Record<string, ThreadRuntimeState> {
  const newestByThread = new Map<string, TurnRecord>();
  for (const turn of turns) {
    if (!isRecoverableSnapshotStatus(turn.status)) continue;
    const previous = newestByThread.get(turn.threadId);
    if (!previous || compareTurns(previous, turn) <= 0) {
      newestByThread.set(turn.threadId, turn);
    }
  }

  return Object.fromEntries(
    [...newestByThread].map(([threadId, turn]) => [threadId, {
      threadId,
      turnId: turn.id,
      modelProfileId: turn.modelProfileId,
      status: turn.status,
      startedAt: timestamp(turn.startedAt),
      completedAt: timestamp(turn.completedAt),
      error: turn.error,
    } satisfies ThreadRuntimeState]),
  );
}

function compareTurns(left: TurnRecord, right: TurnRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function timestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecoverableSnapshotStatus(status: TurnRecord['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling' || status === 'interrupted';
}

function isActiveStatus(status: ThreadRuntimeState['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling';
}

function isTerminalEvent(event: SequencedAgentEvent): event is Extract<SequencedAgentEvent, {
  type: 'turn.completed' | 'turn.failed' | 'turn.cancelled';
}> {
  return event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled';
}

function reconcileSnapshot(current: AppSnapshot, incoming: AppSnapshot): AppSnapshot {
  const items: Record<string, Item[]> = {};
  const threadIds = new Set([...Object.keys(incoming.items), ...Object.keys(current.items)]);
  for (const threadId of threadIds) {
    items[threadId] = reconcileThreadItems(current.items[threadId] ?? [], incoming.items[threadId] ?? []);
  }
  return { ...incoming, items };
}

function reconcileThreadItems(current: Item[], incoming: Item[]): Item[] {
  const next = incoming.map((item) => {
    const key = logicalStreamKey(item);
    if (!key || !isTextStreamItem(item)) return item;
    const live = current.filter((candidate) => logicalStreamKey(candidate) === key).filter(isTextStreamItem);
    const text = live.reduce((combined, candidate) => reconcileStreamText(combined, candidate.text), item.text);
    return { ...item, text };
  });
  const representedKeys = new Set(next.map(logicalStreamKey).filter((key): key is string => Boolean(key)));
  const representedIds = new Set(next.map((item) => item.id));
  for (const item of current) {
    const key = logicalStreamKey(item);
    if (representedIds.has(item.id) || (key && representedKeys.has(key))) continue;
    next.push(item);
  }
  return next;
}

function reconcileStreamText(left: string, right: string): string {
  if (!left) return right;
  if (!right || left === right || left.startsWith(right)) return left;
  if (right.startsWith(left)) return right;
  for (let overlap = Math.min(left.length, right.length); overlap > 0; overlap -= 1) {
    if (left.endsWith(right.slice(0, overlap))) return left + right.slice(overlap);
  }
  for (let overlap = Math.min(left.length, right.length); overlap > 0; overlap -= 1) {
    if (right.endsWith(left.slice(0, overlap))) return right + left.slice(overlap);
  }
  return left + right;
}

function logicalStreamKey(item: Item): string | undefined {
  if (item.kind === 'message' && item.role === 'assistant' && item.turnId) {
    return `answer:${item.turnId}`;
  }
  if (item.kind === 'reasoning' && item.turnId) {
    return `reasoning:${item.mode}:${item.turnId}`;
  }
  return undefined;
}

function isTextStreamItem(item: Item): item is MessageItem | ReasoningItem {
  return item.kind === 'reasoning' || (item.kind === 'message' && item.role === 'assistant');
}

function markTurnContentComplete(snapshot: AppSnapshot, threadId: string, turnId: string): AppSnapshot {
  const items = snapshot.items[threadId];
  if (!items) return snapshot;
  return {
    ...snapshot,
    items: {
      ...snapshot.items,
      [threadId]: items.map((item) => {
        if (item.turnId !== turnId || !isTextStreamItem(item)) return item;
        return { ...item, incomplete: false };
      }),
    },
  };
}
