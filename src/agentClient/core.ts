import type {
  Approval,
  AppSnapshot,
  Item,
  MessageItem,
  ReasoningItem,
  ReasoningOutputMode,
  ThreadRuntimeState,
  TurnAttachment,
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
  currentTurnByThread: Record<string, string>;
  supersededTurns: Record<string, true>;
  snapshotTerminalStatusByTurn: Record<string, TerminalStatus>;
  optimisticThreads: Record<string, true>;
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
      workspaces: [],
      undoableTurns: [],
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
    currentTurnByThread: {},
    supersededTurns: {},
    snapshotTerminalStatusByTurn: {},
    optimisticThreads: {},
  };
}

export function reduceAgentEvent(state: AgentClientState, event: AgentEvent): AgentClientState {
  if (event.type === 'snapshot') {
    const activeThreadId = event.snapshot.threads.some((thread) => thread.id === state.activeThreadId)
      ? state.activeThreadId
      : event.snapshot.threads[0]?.id;
    const activeThread = event.snapshot.threads.find((thread) => thread.id === activeThreadId);
    const runtimeProjection = reconcileSnapshotRuntimes(state, event.snapshot.turns ?? []);
    const turns = reconcileTurns(state.snapshot.turns ?? [], event.snapshot.turns ?? []);
    const snapshotTerminalStatusByTurn = mergeTerminalStatusIndexes(
      state.snapshotTerminalStatusByTurn,
      indexSnapshotTerminalStatuses(turns),
    );
    const snapshot = reconcileSnapshot(
      state.snapshot,
      { ...event.snapshot, turns },
      turnStatuses(turns, state.events, runtimeProjection.runtimeByThread),
    );
    return {
      ...state,
      snapshot,
      ...runtimeProjection,
      snapshotTerminalStatusByTurn,
      activeThreadId,
      activeGroupId: activeThread?.groupId ?? state.activeGroupId ?? event.snapshot.groups[0]?.id,
      pendingApproval: snapshot.approvals.find(
        (approval) => approval.status === 'pending' && approval.threadId === activeThreadId,
      ),
    };
  }

  const turnKey = `${event.threadId}:${event.turnId}`;
  if (event.sequence <= (state.lastSequenceByTurn[turnKey] ?? -1)) {
    return state;
  }

  const runtimeProjection = reduceCurrentRuntime(state, event);
  const snapshotTerminalStatusByTurn = indexTerminalEvent(state, event, turnKey);
  let nextState: AgentClientState = {
    ...state,
    events: [...state.events, event],
    lastSequenceByTurn: { ...state.lastSequenceByTurn, [turnKey]: event.sequence },
    ...runtimeProjection,
    snapshotTerminalStatusByTurn,
  };

  if (event.type === 'message.delta' || event.type === 'answer.delta') {
    nextState = applyAssistantDeltaToSnapshot(nextState, event.threadId, event.turnId, event.text);
  } else if (event.type === 'reasoning.raw.delta') {
    nextState = applyReasoningDeltaToSnapshot(nextState, event.threadId, event.turnId, 'raw', event.text);
  } else if (event.type === 'reasoning.summary.delta') {
    nextState = applyReasoningDeltaToSnapshot(nextState, event.threadId, event.turnId, 'summary', event.text);
  }

  if (
    event.type === 'message.delta' ||
    event.type === 'answer.delta' ||
    event.type === 'reasoning.raw.delta' ||
    event.type === 'reasoning.summary.delta'
  ) {
    const terminalStatus = knownTerminalStatus(nextState, event.threadId, event.turnId);
    if (terminalStatus) {
      nextState = {
        ...nextState,
        snapshot: markTurnContentIncomplete(
          nextState.snapshot,
          event.threadId,
          event.turnId,
          terminalStatus !== 'completed',
        ),
      };
    }
  }

  if (event.type === 'approval.required') {
    const approval: Approval = {
      id: event.approvalId,
      threadId: event.threadId,
      turnId: event.turnId,
      title: event.title,
      description: event.description,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    nextState = {
      ...nextState,
      snapshot: {
        ...nextState.snapshot,
        approvals: upsertApproval(nextState.snapshot.approvals, approval),
      },
      pendingApproval: event.threadId === nextState.activeThreadId ? approval : nextState.pendingApproval,
    };
  }

  if (isTerminalEvent(event)) {
    const terminalStatus = knownTerminalStatus(nextState, event.threadId, event.turnId) ?? eventStatus(event);
    const snapshot = markTurnContentIncomplete(
      nextState.snapshot,
      event.threadId,
      event.turnId,
      terminalStatus !== 'completed',
    );
    nextState = {
      ...nextState,
      snapshot: {
        ...snapshot,
        approvals: snapshot.approvals.map((approval) =>
          approval.threadId === event.threadId && approval.turnId === event.turnId && approval.status === 'pending'
            ? { ...approval, status: 'rejected' as const, respondedAt: new Date().toISOString() }
            : approval,
        ),
      },
      pendingApproval:
        nextState.pendingApproval?.threadId === event.threadId && nextState.pendingApproval.turnId === event.turnId
          ? undefined
          : nextState.pendingApproval,
    };
  }

  return nextState;
}

function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  const index = approvals.findIndex((candidate) => candidate.id === approval.id);
  if (index < 0) return [...approvals, approval];
  return approvals.map((candidate, candidateIndex) => candidateIndex === index ? approval : candidate);
}

export function appendOptimisticUserMessage(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  text: string,
  attachments: TurnAttachment[] = [],
): AgentClientState {
  const item: Item = {
    id: `item-${turnId}-user`,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
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

type RuntimeProjection = Pick<
  AgentClientState,
  'runtimeByThread' | 'currentTurnByThread' | 'supersededTurns' | 'optimisticThreads'
>;

function reduceCurrentRuntime(state: AgentClientState, event: SequencedAgentEvent): RuntimeProjection {
  const threadId = event.threadId;
  const eventKey = turnKey(threadId, event.turnId);
  const currentTurnId = state.currentTurnByThread[threadId] ?? state.runtimeByThread[threadId]?.turnId;
  const currentRuntime = state.runtimeByThread[threadId];
  const optimistic = Boolean(state.optimisticThreads[threadId]);
  if (state.supersededTurns[eventKey]) {
    return runtimeProjection(state);
  }

  const sameTurn = currentTurnId === event.turnId;
  const claimsOptimistic = optimistic && (!currentTurnId || !sameTurn);
  const opensAfterTerminal =
    !optimistic &&
    Boolean(currentTurnId) &&
    currentTurnId !== event.turnId &&
    isTerminalStatus(currentRuntime?.status) &&
    isTurnOpeningEvent(event);
  const claimsEmpty = !optimistic && !currentTurnId;
  const shouldApply = sameTurn && !optimistic || claimsOptimistic || opensAfterTerminal || claimsEmpty;
  if (!shouldApply) {
    return runtimeProjection(state);
  }

  const currentTurnByThread = { ...state.currentTurnByThread, [threadId]: event.turnId };
  const supersededTurns = { ...state.supersededTurns };
  if (currentTurnId && currentTurnId !== event.turnId) {
    supersededTurns[turnKey(threadId, currentTurnId)] = true;
  }
  const optimisticThreads = { ...state.optimisticThreads };
  delete optimisticThreads[threadId];
  const base = sameTurn ? currentRuntime : undefined;
  return {
    runtimeByThread: {
      ...state.runtimeByThread,
      [threadId]: applyRuntimeEvent(base, event),
    },
    currentTurnByThread,
    supersededTurns,
    optimisticThreads,
  };
}

function applyRuntimeEvent(current: ThreadRuntimeState | undefined, event: SequencedAgentEvent): ThreadRuntimeState {
  const now = Date.now();
  const base: ThreadRuntimeState = current
    ? { ...current, modelProfileId: event.modelProfileId }
    : {
        threadId: event.threadId,
        turnId: event.turnId,
        modelProfileId: event.modelProfileId,
        status: event.type === 'turn.queued' ? 'queued' : 'running',
      };
  const terminal = isTerminalStatus(base.status);

  switch (event.type) {
    case 'turn.queued':
      return terminal || base.status === 'running' || base.status === 'cancelling'
        ? base
        : { ...base, status: 'queued', queuePosition: event.queuePosition, error: undefined };
    case 'turn.started':
      return terminal || base.status === 'cancelling'
        ? base
        : { ...base, status: 'running', queuePosition: undefined, startedAt: base.startedAt ?? now, error: undefined };
    case 'turn.cancelling':
      return terminal ? base : { ...base, status: 'cancelling', queuePosition: undefined, error: undefined };
    case 'turn.completed':
      return terminal ? base : { ...base, status: 'completed', queuePosition: undefined, completedAt: now, error: undefined };
    case 'turn.failed':
      return terminal ? base : { ...base, status: 'failed', queuePosition: undefined, completedAt: now, error: event.error };
    case 'turn.cancelled':
      return terminal ? base : { ...base, status: 'cancelled', queuePosition: undefined, completedAt: now, error: undefined };
    case 'model.metrics':
      return { ...base, tokensPerSecond: event.metrics.tokensPerSecond ?? base.tokensPerSecond };
    case 'message.delta':
    case 'answer.delta':
    case 'reasoning.raw.delta':
    case 'reasoning.summary.delta':
      return {
        ...base,
        status: terminal || base.status === 'cancelling' ? base.status : 'running',
        queuePosition: terminal || base.status === 'cancelling' ? base.queuePosition : undefined,
        firstTokenAt: base.firstTokenAt ?? now,
      };
    default:
      return base;
  }
}

function reconcileSnapshotRuntimes(state: AgentClientState, incomingTurns: TurnRecord[]): RuntimeProjection {
  const newestIncoming = newestTurnsByThread(incomingTurns);
  const incomingById = new Map(incomingTurns.map((turn) => [turn.id, turn]));
  const runtimeByThread = { ...state.runtimeByThread };
  const currentTurnByThread = { ...state.currentTurnByThread };
  const supersededTurns = { ...state.supersededTurns };
  const optimisticThreads = { ...state.optimisticThreads };
  const threadIds = new Set([
    ...Object.keys(runtimeByThread),
    ...Object.keys(currentTurnByThread),
    ...newestIncoming.keys(),
  ]);

  for (const threadId of threadIds) {
    const candidate = newestIncoming.get(threadId);
    const current = runtimeByThread[threadId];
    const currentTurnId = currentTurnByThread[threadId] ?? current?.turnId;
    const optimistic = Boolean(optimisticThreads[threadId]);

    if (!candidate) {
      if (!optimistic && (!currentTurnId || state.lastSequenceByTurn[turnKey(threadId, currentTurnId)] === undefined)) {
        delete runtimeByThread[threadId];
        delete currentTurnByThread[threadId];
      }
      continue;
    }

    const currentIncoming = currentTurnId ? incomingById.get(currentTurnId) : undefined;
    const currentKnown = currentTurnId
      ? currentIncoming ?? state.snapshot.turns.find((turn) => turn.id === currentTurnId)
      : undefined;
    const claimsOptimisticPlaceholder =
      optimistic &&
      !current?.turnId &&
      !isTerminalStatus(candidate.status) &&
      (
        !currentTurnId ||
        (
          candidate.id !== currentTurnId &&
          !supersededTurns[turnKey(threadId, candidate.id)] &&
          (!currentKnown || compareTurns(currentKnown, candidate) < 0)
        )
      );
    if (claimsOptimisticPlaceholder) {
      if (currentTurnId && currentTurnId !== candidate.id) {
        supersededTurns[turnKey(threadId, currentTurnId)] = true;
      }
      runtimeByThread[threadId] = runtimeFromTurn(candidate);
      currentTurnByThread[threadId] = candidate.id;
      delete optimisticThreads[threadId];
      continue;
    }

    if (optimistic && (!currentTurnId || candidate.id === currentTurnId || supersededTurns[turnKey(threadId, candidate.id)])) {
      continue;
    }

    if (candidate.id === currentTurnId) {
      runtimeByThread[threadId] = mergeRuntime(current, runtimeFromTurn(candidate));
      continue;
    }

    if (supersededTurns[turnKey(threadId, candidate.id)]) {
      continue;
    }

    const currentHasLiveSequence = Boolean(
      currentTurnId && state.lastSequenceByTurn[turnKey(threadId, currentTurnId)] !== undefined,
    );
    const candidateIsNewer = !currentKnown || compareTurns(currentKnown, candidate) < 0;
    const canReplaceCurrent =
      !currentTurnId ||
      (candidateIsNewer && Boolean(currentIncoming) && (!currentHasLiveSequence || isTerminalStatus(current?.status)));
    if (!canReplaceCurrent) {
      continue;
    }

    if (currentTurnId) {
      supersededTurns[turnKey(threadId, currentTurnId)] = true;
    }
    runtimeByThread[threadId] = runtimeFromTurn(candidate);
    currentTurnByThread[threadId] = candidate.id;
    delete optimisticThreads[threadId];
  }

  indexSnapshotHistory(
    state,
    incomingTurns,
    incomingById,
    currentTurnByThread,
    runtimeByThread,
    optimisticThreads,
    supersededTurns,
  );

  return { runtimeByThread, currentTurnByThread, supersededTurns, optimisticThreads };
}

function indexSnapshotHistory(
  state: AgentClientState,
  incomingTurns: TurnRecord[],
  incomingById: Map<string, TurnRecord>,
  currentTurnByThread: Record<string, string>,
  runtimeByThread: Record<string, ThreadRuntimeState>,
  optimisticThreads: Record<string, true>,
  supersededTurns: Record<string, true>,
): void {
  for (const turn of incomingTurns) {
    const currentTurnId = currentTurnByThread[turn.threadId] ?? runtimeByThread[turn.threadId]?.turnId;
    if (!currentTurnId) {
      if (optimisticThreads[turn.threadId]) {
        supersededTurns[turnKey(turn.threadId, turn.id)] = true;
      }
      continue;
    }
    if (turn.id === currentTurnId) continue;
    const currentTurn = incomingById.get(currentTurnId)
      ?? state.snapshot.turns.find((candidate) => candidate.threadId === turn.threadId && candidate.id === currentTurnId);
    if (currentTurn && compareTurns(turn, currentTurn) < 0) {
      supersededTurns[turnKey(turn.threadId, turn.id)] = true;
    } else if (!currentTurn && state.lastSequenceByTurn[turnKey(turn.threadId, currentTurnId)] !== undefined) {
      supersededTurns[turnKey(turn.threadId, turn.id)] = true;
    }
  }
}

function newestTurnsByThread(turns: TurnRecord[]): Map<string, TurnRecord> {
  const newest = new Map<string, TurnRecord>();
  for (const turn of turns) {
    const previous = newest.get(turn.threadId);
    if (!previous || compareTurns(previous, turn) < 0) {
      newest.set(turn.threadId, turn);
    }
  }
  return newest;
}

function runtimeFromTurn(turn: TurnRecord): ThreadRuntimeState {
  return {
    threadId: turn.threadId,
    turnId: turn.id,
    modelProfileId: turn.modelProfileId,
    status: turn.status,
    startedAt: timestamp(turn.startedAt),
    completedAt: timestamp(turn.completedAt),
    error: turn.error,
  };
}

function mergeRuntime(current: ThreadRuntimeState | undefined, incoming: ThreadRuntimeState): ThreadRuntimeState {
  if (!current || current.turnId !== incoming.turnId) return incoming;
  const status = monotonicStatus(current.status, incoming.status);
  return {
    ...incoming,
    ...current,
    modelProfileId: incoming.modelProfileId ?? current.modelProfileId,
    status,
    queuePosition: status === 'queued' ? current.queuePosition ?? incoming.queuePosition : undefined,
    startedAt: current.startedAt ?? incoming.startedAt,
    completedAt: current.completedAt ?? incoming.completedAt,
    error: status === 'failed' ? current.error ?? incoming.error : undefined,
  };
}

function monotonicStatus(current: ThreadRuntimeState['status'], incoming: ThreadRuntimeState['status']): ThreadRuntimeState['status'] {
  if (isTerminalStatus(current)) return current;
  if (isTerminalStatus(incoming)) return incoming;
  const rank: Record<ThreadRuntimeState['status'], number> = {
    idle: 0,
    queued: 1,
    running: 2,
    cancelling: 3,
    completed: 4,
    failed: 4,
    cancelled: 4,
    interrupted: 4,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

function compareTurns(left: TurnRecord, right: TurnRecord): number {
  for (const field of ['createdAt', 'startedAt', 'completedAt'] as const) {
    const compared = timestampForOrder(left[field]) - timestampForOrder(right[field]);
    if (compared !== 0) return compared;
  }
  return left.id.localeCompare(right.id);
}

function timestampForOrder(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function timestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isTerminalStatus(
  status: ThreadRuntimeState['status'] | undefined,
): status is Extract<ThreadRuntimeState['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted'> {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

type TerminalStatus = Extract<
  ThreadRuntimeState['status'],
  'completed' | 'failed' | 'cancelled' | 'interrupted'
>;

function isTurnOpeningEvent(event: SequencedAgentEvent): boolean {
  return event.type === 'turn.queued' || event.type === 'turn.started';
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function runtimeProjection(state: AgentClientState): RuntimeProjection {
  return {
    runtimeByThread: state.runtimeByThread,
    currentTurnByThread: state.currentTurnByThread,
    supersededTurns: state.supersededTurns,
    optimisticThreads: state.optimisticThreads,
  };
}

function isTerminalEvent(event: SequencedAgentEvent): event is Extract<SequencedAgentEvent, {
  type: 'turn.completed' | 'turn.failed' | 'turn.cancelled';
}> {
  return event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled';
}

function eventStatus(
  event: Extract<SequencedAgentEvent, { type: 'turn.completed' | 'turn.failed' | 'turn.cancelled' }>,
): Extract<ThreadRuntimeState['status'], 'completed' | 'failed' | 'cancelled'> {
  if (event.type === 'turn.completed') return 'completed';
  if (event.type === 'turn.failed') return 'failed';
  return 'cancelled';
}

function firstTerminalStatus(
  events: AgentEvent[],
  threadId: string,
  turnId: string,
): Extract<ThreadRuntimeState['status'], 'completed' | 'failed' | 'cancelled'> | undefined {
  for (const candidate of events) {
    if (
      candidate.type !== 'snapshot' &&
      candidate.threadId === threadId &&
      candidate.turnId === turnId &&
      isTerminalEvent(candidate)
    ) {
      return eventStatus(candidate);
    }
  }
  return undefined;
}

function knownTerminalStatus(
  state: AgentClientState,
  threadId: string,
  turnId: string,
): Extract<ThreadRuntimeState['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted'> | undefined {
  const runtime = state.runtimeByThread[threadId];
  if (runtime?.turnId === turnId && isTerminalStatus(runtime.status)) {
    return runtime.status;
  }
  return state.snapshotTerminalStatusByTurn[turnKey(threadId, turnId)]
    ?? firstTerminalStatus(state.events, threadId, turnId);
}

function indexSnapshotTerminalStatuses(turns: TurnRecord[]): Record<string, TerminalStatus> {
  const statuses: Record<string, TerminalStatus> = {};
  for (const turn of turns) {
    if (isTerminalStatus(turn.status)) {
      statuses[turnKey(turn.threadId, turn.id)] = turn.status;
    }
  }
  return statuses;
}

function mergeTerminalStatusIndexes(
  current: Record<string, TerminalStatus>,
  incoming: Record<string, TerminalStatus>,
): Record<string, TerminalStatus> {
  return { ...incoming, ...current };
}

function indexTerminalEvent(
  state: AgentClientState,
  event: SequencedAgentEvent,
  eventKey: string,
): Record<string, TerminalStatus> {
  if (!isTerminalEvent(event) || state.snapshotTerminalStatusByTurn[eventKey]) {
    return state.snapshotTerminalStatusByTurn;
  }
  const firstLiveStatus = firstTerminalStatus(state.events, event.threadId, event.turnId);
  return {
    ...state.snapshotTerminalStatusByTurn,
    [eventKey]: firstLiveStatus ?? eventStatus(event),
  };
}

function reconcileTurns(current: TurnRecord[], incoming: TurnRecord[]): TurnRecord[] {
  const turns = new Map(current.map((turn) => [turn.id, turn]));
  for (const turn of incoming) {
    const existing = turns.get(turn.id);
    if (!existing) {
      turns.set(turn.id, turn);
      continue;
    }
    const status = monotonicStatus(existing.status, turn.status) as TurnRecord['status'];
    turns.set(turn.id, {
      ...existing,
      ...turn,
      status,
      startedAt: turn.startedAt ?? existing.startedAt,
      completedAt: turn.completedAt ?? existing.completedAt,
      error: status === 'failed' ? turn.error ?? existing.error : undefined,
      incomplete: status !== 'completed',
      metrics: turn.metrics ?? existing.metrics,
    });
  }
  return [...turns.values()].sort(compareTurns);
}

function turnStatuses(
  turns: TurnRecord[],
  events: AgentEvent[],
  runtimes: Record<string, ThreadRuntimeState>,
): Map<string, ThreadRuntimeState['status']> {
  const statuses = new Map<string, ThreadRuntimeState['status']>(turns.map((turn) => [turn.id, turn.status]));
  const liveStatuses = new Map<string, ThreadRuntimeState['status']>();
  for (const event of events) {
    if (event.type === 'snapshot') continue;
    const previous = liveStatuses.get(event.turnId);
    const status = statusFromEvent(event);
    if (!status || isTerminalStatus(previous)) continue;
    liveStatuses.set(event.turnId, previous ? monotonicStatus(previous, status) : status);
  }
  for (const [turnId, status] of liveStatuses) {
    statuses.set(turnId, status);
  }
  for (const runtime of Object.values(runtimes)) {
    if (runtime.turnId) statuses.set(runtime.turnId, runtime.status);
  }
  return statuses;
}

function statusFromEvent(event: SequencedAgentEvent): ThreadRuntimeState['status'] | undefined {
  if (event.type === 'turn.queued') return 'queued';
  if (event.type === 'turn.cancelling') return 'cancelling';
  if (event.type === 'turn.completed') return 'completed';
  if (event.type === 'turn.failed') return 'failed';
  if (event.type === 'turn.cancelled') return 'cancelled';
  return 'running';
}

function reconcileSnapshot(
  current: AppSnapshot,
  incoming: AppSnapshot,
  statuses: Map<string, ThreadRuntimeState['status']>,
): AppSnapshot {
  const items: Record<string, Item[]> = {};
  const threadIds = new Set([...Object.keys(incoming.items), ...Object.keys(current.items)]);
  for (const threadId of threadIds) {
    items[threadId] = reconcileThreadItems(current.items[threadId] ?? [], incoming.items[threadId] ?? [], statuses);
  }
  return {
    ...incoming,
    items,
    approvals: reconcileApprovals(current.approvals, incoming.approvals, statuses, incoming.threads.map((thread) => thread.id)),
  };
}

function reconcileApprovals(
  current: Approval[],
  incoming: Approval[],
  statuses: Map<string, ThreadRuntimeState['status']>,
  incomingThreadIds: string[],
): Approval[] {
  const approvals = new Map(incoming.map((approval) => [approval.id, approval]));
  for (const approval of current) {
    const snapshotApproval = approvals.get(approval.id);
    if (!snapshotApproval) {
      approvals.set(approval.id, approval);
      continue;
    }
    approvals.set(
      approval.id,
      approval.status !== 'pending' && snapshotApproval.status === 'pending'
        ? approval
        : snapshotApproval,
    );
  }

  const knownThreads = new Set(incomingThreadIds);
  return [...approvals.values()].flatMap((approval) => {
    const terminal = isTerminalStatus(statuses.get(approval.turnId));
    if (!knownThreads.has(approval.threadId) && terminal) {
      return [];
    }
    if (approval.status === 'pending' && terminal) {
      return [{ ...approval, status: 'rejected' as const }];
    }
    return [approval];
  });
}

function reconcileThreadItems(
  current: Item[],
  incoming: Item[],
  statuses: Map<string, ThreadRuntimeState['status']>,
): Item[] {
  const next = incoming.map((item) => {
    const key = logicalStreamKey(item);
    if (!key || !isTextStreamItem(item)) return normalizeItemIncomplete(item, statuses);
    const live = current.filter((candidate) => logicalStreamKey(candidate) === key).filter(isTextStreamItem);
    const text = live.reduce((combined, candidate) => reconcileStreamText(combined, candidate.text), item.text);
    return normalizeItemIncomplete({ ...item, text }, statuses);
  });
  const representedKeys = new Set(next.map(logicalStreamKey).filter((key): key is string => Boolean(key)));
  const representedIds = new Set(next.map((item) => item.id));
  for (const item of current) {
    const key = logicalStreamKey(item);
    if (representedIds.has(item.id) || (key && representedKeys.has(key))) continue;
    next.push(normalizeItemIncomplete(item, statuses));
  }
  return next;
}

function normalizeItemIncomplete(item: Item, statuses: Map<string, ThreadRuntimeState['status']>): Item {
  if (!item.turnId || !isTextStreamItem(item)) return item;
  const status = statuses.get(item.turnId);
  if (!status) return item;
  return { ...item, incomplete: status !== 'completed' };
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

function markTurnContentIncomplete(
  snapshot: AppSnapshot,
  threadId: string,
  turnId: string,
  incomplete: boolean,
): AppSnapshot {
  const items = snapshot.items[threadId];
  if (!items) return snapshot;
  return {
    ...snapshot,
    items: {
      ...snapshot.items,
      [threadId]: items.map((item) => {
        if (item.turnId !== turnId || !isTextStreamItem(item)) return item;
        return { ...item, incomplete };
      }),
    },
  };
}
