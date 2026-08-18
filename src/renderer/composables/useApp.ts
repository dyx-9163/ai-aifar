import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  appendOptimisticUserMessage,
  applyAssistantDeltaToSnapshot,
  emptyAgentClientState,
  reduceAgentEvent,
  type AgentClientState,
} from '../../agentClient/core';
import type {
  AppSnapshot,
  ChatGroup,
  Item,
  LanguagePreference,
  ModelProfile,
  ModelProfileInput,
  ModelResponseSpeed,
  ReasoningEffort,
  ReasoningMode,
  ReasoningProtocol,
  RuntimeSettingsInput,
  ThreadRuntimeState,
  ThreadSummary,
} from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';

export interface ActiveModelRuntimePatch {
  reasoning?: Partial<{
    mode: ReasoningMode;
    protocol: ReasoningProtocol;
    effort: ReasoningEffort;
  }>;
  responseSpeed?: ModelResponseSpeed;
}

export type RendererState = AgentClientState;
export const emptyState = emptyAgentClientState;
export const reduceEvent = reduceAgentEvent;
export { appendOptimisticUserMessage, applyAssistantDeltaToSnapshot };

const TURN_START_ACK_TIMEOUT_MS = 10_000;
const RUNTIME_SETTINGS_TIMEOUT_MS = 10_000;

export function startInitialAgentSync(options: {
  readState(): RendererState;
  writeState(state: RendererState): void;
  getSnapshot(): Promise<AppSnapshot>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  onReady(): void;
}): { ready: Promise<void>; dispose(): void } {
  let disposed = false;
  let buffering = true;
  let unsubscribed = false;
  const bufferedEvents: AgentEvent[] = [];
  const unsubscribe = options.subscribe((event) => {
    if (disposed) return;
    if (buffering) {
      bufferedEvents.push(event);
      return;
    }
    options.writeState(reduceEvent(options.readState(), event));
  });
  const stop = () => {
    if (disposed && unsubscribed) return;
    disposed = true;
    if (!unsubscribed) {
      unsubscribed = true;
      unsubscribe();
    }
  };
  const ready = (async () => {
    try {
      const snapshot = await options.getSnapshot();
      if (disposed) return;
      let next = options.readState();
      for (const event of bufferedEvents) {
        next = reduceEvent(next, event);
      }
      next = reduceEvent(next, { type: 'snapshot', snapshot });
      if (disposed) return;
      options.writeState(next);
      buffering = false;
      options.onReady();
    } catch (error) {
      stop();
      throw error;
    }
  })();

  return {
    ready,
    dispose() {
      stop();
    },
  };
}

export function useApp() {
  const state = ref<RendererState>(emptyState());
  const loading = ref(true);
  const approvalResponseInFlightId = ref<string>();

  const activeThread = computed(() =>
    state.value.snapshot.threads.find((thread) => thread.id === state.value.activeThreadId),
  );

  const activeItems = computed<Item[]>(() => {
    const threadId = state.value.activeThreadId;
    return threadId ? (state.value.snapshot.items[threadId] ?? []) : [];
  });
  const activeTurns = computed(() => {
    const threadId = state.value.activeThreadId;
    return threadId ? state.value.snapshot.turns.filter((turn) => turn.threadId === threadId) : [];
  });

  const activeRuntime = computed<ThreadRuntimeState | undefined>(() => {
    const threadId = state.value.activeThreadId;
    return threadId
      ? state.value.runtimeByThread[threadId] ?? { threadId, status: 'idle' }
      : undefined;
  });
  const activeBusy = computed(() => ['queued', 'running', 'cancelling'].includes(activeRuntime.value?.status ?? 'idle'));
  const activeTurnId = computed(() => activeRuntime.value?.turnId);
  const activePendingApproval = computed(() => {
    const threadId = state.value.activeThreadId;
    if (!threadId) return undefined;
    return state.value.snapshot.approvals.find(
      (approval) => approval.threadId === threadId && approval.status === 'pending',
    );
  });

  const activeModelProfileId = computed(() => activeThread.value?.modelProfileId ?? state.value.snapshot.settings.activeModelProfileId);
  const activeModelProfile = computed(() =>
    state.value.snapshot.modelProfiles.find((profile) => profile.id === activeModelProfileId.value),
  );

  const visibleEvents = computed(() =>
    state.value.events.filter((event) => event.type === 'snapshot' || event.threadId === state.value.activeThreadId),
  );

  let unsubscribe: (() => void) | undefined;

  onMounted(async () => {
    const sync = startInitialAgentSync({
      readState: () => state.value,
      writeState: (next) => { state.value = next; },
      getSnapshot: () => window.desktop.getSnapshot(),
      subscribe: (listener) => window.desktop.subscribe(listener),
      onReady: () => { loading.value = false; },
    });
    unsubscribe = sync.dispose;
    try {
      await sync.ready;
    } finally {
      loading.value = false;
    }
  });

  onUnmounted(() => {
    unsubscribe?.();
  });

  async function createGroup(name: string): Promise<ChatGroup> {
    const group = await window.desktop.createGroup(name);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    state.value.activeGroupId = group.id;
    return group;
  }

  async function deleteGroup(groupId: string): Promise<void> {
    await window.desktop.deleteGroup(groupId);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  async function createThread(title: string, groupId = state.value.activeGroupId): Promise<ThreadSummary> {
    const thread = await window.desktop.createThread(title, groupId);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    state.value.activeThreadId = thread.id;
    state.value.activeGroupId = thread.groupId;
    return thread;
  }

  async function deleteThread(threadId: string): Promise<void> {
    await window.desktop.deleteThread(threadId);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  async function startTurn(text: string): Promise<void> {
    const threadId = state.value.activeThreadId ?? (await createThread('New task', state.value.activeGroupId)).id;
    const modelProfileId = activeThread.value?.modelProfileId ?? state.value.snapshot.settings.activeModelProfileId;
    const previousRuntime = state.value.runtimeByThread[threadId];
    state.value = {
      ...replaceThreadRuntime(state.value, threadId, {
        threadId,
        modelProfileId,
        status: 'queued',
      }),
      optimisticThreads: { ...state.value.optimisticThreads, [threadId]: true },
    };
    try {
      const response = await withTimeout(
        window.desktop.startTurn(threadId, text, modelProfileId),
        TURN_START_ACK_TIMEOUT_MS,
        'Agent runtime did not acknowledge the turn within 10s.',
      );
      state.value = acknowledgeThreadTurn(state.value, threadId, response.turnId, modelProfileId);
      state.value = appendOptimisticUserMessage(state.value, threadId, response.turnId, text);
    } catch (error) {
      if (state.value.optimisticThreads[threadId]) {
        const optimisticThreads = { ...state.value.optimisticThreads };
        delete optimisticThreads[threadId];
        state.value = {
          ...replaceThreadRuntime(state.value, threadId, previousRuntime),
          optimisticThreads,
        };
      }
      throw error;
    }
  }

  async function cancelTurn(): Promise<void> {
    const threadId = state.value.activeThreadId;
    const runtime = activeRuntime.value;
    const turnId = runtime?.turnId;
    if (!threadId || !turnId || !['queued', 'running', 'cancelling'].includes(runtime.status)) {
      return;
    }
    state.value = replaceThreadRuntime(state.value, threadId, { ...runtime, status: 'cancelling' });
    try {
      const accepted = await window.desktop.cancelTurn(threadId, turnId);
      if (accepted === false) {
        const snapshot = await window.desktop.getSnapshot();
        const currentRuntime = state.value.runtimeByThread[threadId];
        if (currentRuntime?.turnId === turnId && currentRuntime.status === 'cancelling') {
          state.value = replaceThreadRuntime(state.value, threadId, runtime);
        }
        state.value = reduceEvent(state.value, { type: 'snapshot', snapshot });
      }
    } catch (error) {
      const currentRuntime = state.value.runtimeByThread[threadId];
      if (currentRuntime?.turnId === turnId && currentRuntime.status === 'cancelling') {
        state.value = replaceThreadRuntime(state.value, threadId, runtime);
      }
      throw error;
    }
  }

  async function respondApproval(approvalId: string, approved: boolean): Promise<void> {
    const approval = state.value.snapshot.approvals.find((candidate) => candidate.id === approvalId)
      ?? (state.value.pendingApproval?.id === approvalId ? state.value.pendingApproval : undefined);
    if (!approval || approval.status !== 'pending') {
      throw new Error(`Approval "${approvalId}" is no longer pending.`);
    }
    approvalResponseInFlightId.value = approvalId;
    try {
      const accepted = await window.desktop.respondApproval(approvalId, approved);
      if (accepted === false) {
        throw new Error(`Approval "${approvalId}" is no longer pending.`);
      }
      const settled = {
        ...approval,
        status: approved ? 'approved' as const : 'rejected' as const,
        respondedAt: new Date().toISOString(),
      };
      state.value = {
        ...state.value,
        snapshot: {
          ...state.value.snapshot,
          approvals: state.value.snapshot.approvals.map((candidate) => candidate.id === approvalId ? settled : candidate),
        },
        pendingApproval: state.value.pendingApproval?.id === approvalId ? settled : state.value.pendingApproval,
      };
    } catch (error) {
      try {
        const snapshot = await window.desktop.getSnapshot();
        state.value = reduceEvent(state.value, { type: 'snapshot', snapshot });
        if (!snapshot.approvals.some((candidate) => candidate.id === approvalId)) {
          state.value = {
            ...state.value,
            snapshot: {
              ...state.value.snapshot,
              approvals: state.value.snapshot.approvals.filter((candidate) => candidate.id !== approvalId),
            },
            pendingApproval: state.value.pendingApproval?.id === approvalId ? undefined : state.value.pendingApproval,
          };
        }
      } catch {
        // Preserve the acknowledgement failure; a later event/snapshot can still reconcile state.
      }
      throw error;
    } finally {
      if (approvalResponseInFlightId.value === approvalId) {
        approvalResponseInFlightId.value = undefined;
      }
    }
  }

  async function saveModelProfile(profile: ModelProfileInput): Promise<ModelProfile> {
    const saved = await window.desktop.saveModelProfile(profile);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    return saved;
  }

  async function updateActiveModelRuntime(patch: ActiveModelRuntimePatch): Promise<ModelProfile | undefined> {
    const profile = activeModelProfile.value;
    if (!profile) {
      return undefined;
    }

    const optimistic: ModelProfile = {
      ...profile,
      reasoning: {
        ...profile.reasoning,
        ...patch.reasoning,
      },
      responseSpeed: patch.responseSpeed ?? profile.responseSpeed,
    };
    state.value = replaceModelProfile(state.value, optimistic);

    try {
      const saved = await withTimeout(
        window.desktop.saveModelProfile({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          model: profile.model,
          capabilities: {
            ...profile.capabilities,
            reasoning: {
              ...profile.capabilities.reasoning,
              effortOptions: [...profile.capabilities.reasoning.effortOptions],
              outputModes: [...profile.capabilities.reasoning.outputModes],
            },
            concurrency: { ...profile.capabilities.concurrency },
            usage: { ...profile.capabilities.usage },
          },
          reasoning: optimistic.reasoning,
          responseSpeed: optimistic.responseSpeed,
          isDefault: profile.isDefault,
        }),
        RUNTIME_SETTINGS_TIMEOUT_MS,
        'Model runtime setting update timed out after 10s.',
      );
      state.value = replaceModelProfile(state.value, saved);
      return saved;
    } catch (error) {
      state.value = replaceModelProfile(state.value, profile);
      throw error;
    }
  }

  async function deleteModelProfile(id: string): Promise<void> {
    await window.desktop.deleteModelProfile(id);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  async function testModelProfile(profile: ModelProfileInput): Promise<{ ok: true; message: string }> {
    return window.desktop.testModelProfile(profile);
  }

  async function setLanguage(language: LanguagePreference): Promise<void> {
    await window.desktop.setLanguage(language);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  async function updateSettings(settings: RuntimeSettingsInput): Promise<void> {
    await window.desktop.updateSettings(settings);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  async function selectModelProfile(modelProfileId?: string): Promise<void> {
    let threadId = state.value.activeThreadId;
    if (!threadId) {
      threadId = (await createThread('New task')).id;
    }
    await window.desktop.setThreadModel(threadId, modelProfileId);
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
  }

  return {
    state,
    loading,
    activeThread,
    activeItems,
    activeTurns,
    activeRuntime,
    activeBusy,
    activeTurnId,
    activePendingApproval,
    approvalResponseInFlightId,
    activeModelProfile,
    activeModelProfileId,
    visibleEvents,
    createGroup,
    deleteGroup,
    createThread,
    deleteThread,
    startTurn,
    cancelTurn,
    respondApproval,
    saveModelProfile,
    updateActiveModelRuntime,
    deleteModelProfile,
    testModelProfile,
    setLanguage,
    updateSettings,
    selectModelProfile,
  };
}

function replaceThreadRuntime(
  state: RendererState,
  threadId: string,
  runtime?: ThreadRuntimeState,
): RendererState {
  const runtimeByThread = { ...state.runtimeByThread };
  if (runtime) {
    runtimeByThread[threadId] = runtime;
  } else {
    delete runtimeByThread[threadId];
  }
  return { ...state, runtimeByThread };
}

function acknowledgeThreadTurn(
  state: RendererState,
  threadId: string,
  turnId: string,
  modelProfileId?: string,
): RendererState {
  const currentTurnId = state.currentTurnByThread[threadId];
  const currentRuntime = state.runtimeByThread[threadId];
  const supersededTurns = { ...state.supersededTurns };
  if (currentTurnId && currentTurnId !== turnId) {
    supersededTurns[`${threadId}:${currentTurnId}`] = true;
  }
  const optimisticThreads = { ...state.optimisticThreads };
  delete optimisticThreads[threadId];
  const runtime = currentRuntime?.turnId === turnId
    ? currentRuntime
    : { threadId, turnId, modelProfileId, status: 'queued' as const };
  return {
    ...replaceThreadRuntime(state, threadId, runtime),
    currentTurnByThread: { ...state.currentTurnByThread, [threadId]: turnId },
    supersededTurns,
    optimisticThreads,
  };
}

function replaceModelProfile(state: RendererState, profile: ModelProfile): RendererState {
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      modelProfiles: state.snapshot.modelProfiles.map((candidate) => (candidate.id === profile.id ? profile : candidate)),
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
