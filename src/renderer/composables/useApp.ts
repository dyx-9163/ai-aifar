import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Approval, AppSnapshot, Item, ThreadSummary } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';

export interface RendererState {
  snapshot: AppSnapshot;
  activeThreadId?: string;
  events: AgentEvent[];
  seenSequences: Record<string, true>;
  pendingApproval?: Approval;
  busy: boolean;
}

export function emptyState(): RendererState {
  return {
    snapshot: {
      threads: [],
      items: {},
      approvals: [],
      settings: { theme: 'system' },
    },
    events: [],
    seenSequences: {},
    busy: false,
  };
}

export function reduceEvent(state: RendererState, event: AgentEvent): RendererState {
  if (event.type === 'snapshot') {
    return {
      ...state,
      snapshot: event.snapshot,
      activeThreadId: state.activeThreadId ?? event.snapshot.threads[0]?.id,
    };
  }

  const key = `${event.threadId}:${event.sequence}`;
  if (state.seenSequences[key]) {
    return state;
  }

  const nextState: RendererState = {
    ...state,
    events: [...state.events, event],
    seenSequences: { ...state.seenSequences, [key]: true },
    activeThreadId: event.threadId,
    busy: event.type !== 'turn.completed' && event.type !== 'turn.failed',
  };

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
  }

  return nextState;
}

export function useApp() {
  const state = ref<RendererState>(emptyState());
  const loading = ref(true);

  const activeThread = computed(() =>
    state.value.snapshot.threads.find((thread) => thread.id === state.value.activeThreadId),
  );

  const activeItems = computed<Item[]>(() => {
    const threadId = state.value.activeThreadId;
    return threadId ? (state.value.snapshot.items[threadId] ?? []) : [];
  });

  const visibleEvents = computed(() =>
    state.value.events.filter((event) => event.type === 'snapshot' || event.threadId === state.value.activeThreadId),
  );

  let unsubscribe: (() => void) | undefined;

  onMounted(async () => {
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    unsubscribe = window.desktop.subscribe((event) => {
      state.value = reduceEvent(state.value, event);
    });
    loading.value = false;
  });

  onUnmounted(() => {
    unsubscribe?.();
  });

  async function createThread(title: string): Promise<ThreadSummary> {
    const thread = await window.desktop.createThread(title);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    state.value.activeThreadId = thread.id;
    return thread;
  }

  async function startTurn(text: string): Promise<void> {
    const threadId = state.value.activeThreadId ?? (await createThread('New task')).id;
    state.value.busy = true;
    await window.desktop.startTurn(threadId, text);
  }

  async function respondApproval(approved: boolean): Promise<void> {
    const approval = state.value.pendingApproval;
    if (!approval) {
      return;
    }
    await window.desktop.respondApproval(approval.id, approved);
    state.value.pendingApproval = { ...approval, status: approved ? 'approved' : 'rejected', respondedAt: new Date().toISOString() };
  }

  return {
    state,
    loading,
    activeThread,
    activeItems,
    visibleEvents,
    createThread,
    startTurn,
    respondApproval,
  };
}
