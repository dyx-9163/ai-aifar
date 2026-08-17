import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  appendOptimisticUserMessage,
  applyAssistantDeltaToSnapshot,
  emptyAgentClientState,
  reduceAgentEvent,
  type AgentClientState,
} from '../../agentClient/core';
import type {
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
  ThreadSummary,
} from '../../shared/domain';

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

  const activeModelProfileId = computed(() => activeThread.value?.modelProfileId ?? state.value.snapshot.settings.activeModelProfileId);
  const activeModelProfile = computed(() =>
    state.value.snapshot.modelProfiles.find((profile) => profile.id === activeModelProfileId.value),
  );

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
    state.value.busy = true;
    try {
      const response = await withTimeout(
        window.desktop.startTurn(threadId, text, modelProfileId),
        TURN_START_ACK_TIMEOUT_MS,
        'Agent runtime did not acknowledge the turn within 10s.',
      );
      state.value = appendOptimisticUserMessage(state.value, threadId, response.turnId, text);
    } catch (error) {
      state.value = { ...state.value, busy: false, activeTurnId: undefined };
      throw error;
    }
  }

  async function cancelTurn(): Promise<void> {
    const threadId = state.value.activeThreadId;
    const turnId = state.value.activeTurnId;
    if (!threadId || !turnId) {
      return;
    }
    await window.desktop.cancelTurn(threadId, turnId);
    state.value = { ...state.value, busy: false, activeTurnId: undefined };
  }

  async function respondApproval(approved: boolean): Promise<void> {
    const approval = state.value.pendingApproval;
    if (!approval) {
      return;
    }
    await window.desktop.respondApproval(approval.id, approved);
    state.value.pendingApproval = { ...approval, status: approved ? 'approved' : 'rejected', respondedAt: new Date().toISOString() };
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

    const saved = await window.desktop.saveModelProfile({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      capabilities: profile.capabilities,
      reasoning: {
        ...profile.reasoning,
        ...patch.reasoning,
      },
      responseSpeed: patch.responseSpeed ?? profile.responseSpeed,
      isDefault: profile.isDefault,
    });
    state.value = reduceEvent(state.value, { type: 'snapshot', snapshot: await window.desktop.getSnapshot() });
    return saved;
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
