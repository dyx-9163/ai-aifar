import type { Approval, AppSnapshot, Item } from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

export interface AgentClientState {
  snapshot: AppSnapshot;
  activeThreadId?: string;
  activeTurnId?: string;
  activeGroupId?: string;
  events: AgentEvent[];
  seenSequences: Record<string, true>;
  pendingApproval?: Approval;
  busy: boolean;
}

export function emptyAgentClientState(): AgentClientState {
  return {
    snapshot: {
      groups: [],
      threads: [],
      items: {},
      approvals: [],
      modelProfiles: [],
      settings: { theme: 'system', language: 'en-US', showModelMetrics: true, contextMessageLimit: 20 },
    },
    events: [],
    seenSequences: {},
    busy: false,
  };
}

export function reduceAgentEvent(state: AgentClientState, event: AgentEvent): AgentClientState {
  if (event.type === 'snapshot') {
    const activeThreadId = event.snapshot.threads.some((thread) => thread.id === state.activeThreadId)
      ? state.activeThreadId
      : event.snapshot.threads[0]?.id;
    const activeThread = event.snapshot.threads.find((thread) => thread.id === activeThreadId);
    return {
      ...state,
      snapshot: event.snapshot,
      activeThreadId,
      activeGroupId: activeThread?.groupId ?? state.activeGroupId ?? event.snapshot.groups[0]?.id,
    };
  }

  const key = `${event.threadId}:${event.turnId}:${event.sequence}`;
  if (state.seenSequences[key]) {
    return state;
  }

  const nextState: AgentClientState = {
    ...state,
    events: [...state.events, event],
    seenSequences: { ...state.seenSequences, [key]: true },
    activeThreadId: event.threadId,
    activeTurnId: event.type === 'turn.started' ? event.turnId : state.activeTurnId,
    busy: event.type !== 'turn.completed' && event.type !== 'turn.failed',
  };

  if (event.type === 'message.delta') {
    return {
      ...applyAssistantDeltaToSnapshot(nextState, event.threadId, event.turnId, event.text),
      busy: true,
    };
  }

  if (event.type === 'approval.required') {
    nextState.pendingApproval = {
      id: event.approvalId,
      threadId: event.threadId,
      turnId: event.turnId,
      title: event.title,
      description: event.description,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    nextState.busy = false;
    nextState.activeTurnId = undefined;
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

  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      items: {
        ...state.snapshot.items,
        [threadId]: [...existingItems, item],
      },
    },
  };
}

export function applyAssistantDeltaToSnapshot(
  state: AgentClientState,
  threadId: string,
  turnId: string,
  text: string,
): AgentClientState {
  const assistantId = `item-${turnId}-assistant-live`;
  const existingItems = state.snapshot.items[threadId] ?? [];
  const existingIndex = existingItems.findIndex((item) => item.id === assistantId);
  const nextItems =
    existingIndex >= 0
      ? existingItems.map((item, index) =>
          index === existingIndex && item.kind === 'message'
            ? {
                ...item,
                text: item.text + text,
              }
            : item,
        )
      : [
          ...existingItems,
          {
            id: assistantId,
            threadId,
            turnId,
            kind: 'message' as const,
            role: 'assistant' as const,
            text,
            createdAt: new Date().toISOString(),
          },
        ];

  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      items: {
        ...state.snapshot.items,
        [threadId]: nextItems,
      },
    },
  };
}
