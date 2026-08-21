<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { TurnAttachment, TurnRecord, UndoableTurnSummary } from '../shared/domain';
import Conversation from './components/Conversation.vue';
import Inspector from './components/Inspector.vue';
import SettingsView from './components/SettingsView.vue';
import Sidebar from './components/Sidebar.vue';
import WorkspaceDialog from './components/WorkspaceDialog.vue';
import { useApp } from './composables/useApp';
import { deleteFailureFeedback, type DeleteFeedback } from './deleteFeedback';
import { createTranslator } from './i18n';

const app = useApp();
const theme = ref<'light' | 'dark'>('dark');
const view = ref<'chat' | 'settings'>('chat');
const runtimeError = ref('');
const approvalError = ref('');
const deleteFeedback = ref<DeleteFeedback>();
const workspaceDialogOpen = ref(false);

const activeThreadId = computed(() => app.state.value.activeThreadId);
const t = computed(() => createTranslator(app.state.value.snapshot.settings.language));
const threadWorkspaceName = computed(() => {
  const workspaceId = app.activeThread.value?.workspaceId;
  return workspaceId
    ? app.state.value.snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.displayName
    : undefined;
});

watch(activeThreadId, () => {
  approvalError.value = '';
  deleteFeedback.value = undefined;
});

onMounted(() => {
  document.documentElement.dataset.theme = theme.value;
});

async function createThread(): Promise<void> {
  deleteFeedback.value = undefined;
  view.value = 'chat';
  await app.createThread('New task');
}

function selectThread(threadId: string): void {
  deleteFeedback.value = undefined;
  view.value = 'chat';
  app.state.value.activeThreadId = threadId;
  const thread = app.state.value.snapshot.threads.find((candidate) => candidate.id === threadId);
  if (thread?.workspaceId) {
    app.activeWorkspaceId.value = thread.workspaceId;
  }
}

function selectWorkspace(workspaceId: string): void {
  app.activeWorkspaceId.value = workspaceId;
}

async function togglePin(threadId: string, pinned: boolean): Promise<void> {
  deleteFeedback.value = undefined;
  try {
    await app.togglePin(threadId, pinned);
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : '';
  }
}

async function deleteThread(threadId: string): Promise<void> {
  if (!window.confirm(t.value('deleteChatConfirm'))) {
    return;
  }
  deleteFeedback.value = undefined;
  try {
    await app.deleteThread(threadId);
  } catch (error) {
    deleteFeedback.value = deleteFailureFeedback('thread', threadId, error, t.value);
  }
}

function openWorkspaceDialog(): void {
  workspaceDialogOpen.value = true;
}

function handleWorkspaceRegistered(workspaceId: string): void {
  app.activeWorkspaceId.value = workspaceId;
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}

async function startTurn(text: string, attachments?: TurnAttachment[]): Promise<void> {
  runtimeError.value = '';
  try {
    await app.startTurn(text, attachments);
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : '发送失败，请重试。';
  }
}

async function respondApproval(approvalId: string, approved: boolean): Promise<void> {
  approvalError.value = '';
  try {
    await app.respondApproval(approvalId, approved);
  } catch {
    approvalError.value = t.value('approvalResponseFailed');
  }
}

const latestUndoableTurn = computed<UndoableTurnSummary | undefined>(() => {
  const threadId = app.state.value.activeThreadId;
  if (!threadId) return undefined;
  const turnsById = new Map(app.state.value.snapshot.turns.map((turn) => [turn.id, turn]));
  const candidates = app.state.value.snapshot.undoableTurns
    .map((entry) => ({ entry, turn: turnsById.get(entry.turnId) }))
    .filter((pair): pair is { entry: UndoableTurnSummary; turn: TurnRecord } =>
      Boolean(pair.turn && pair.turn.threadId === threadId));
  candidates.sort((left, right) => right.turn.createdAt.localeCompare(left.turn.createdAt));
  return candidates[0]?.entry;
});

async function undoTurnFileChanges(turnId: string): Promise<void> {
  runtimeError.value = '';
  try {
    await app.undoTurn(turnId);
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : t.value('undoTurnFailed');
  }
}
</script>

<template>
  <section
    v-if="app.loading.value || app.startupError.value"
    class="startup-surface"
    :aria-busy="app.loading.value"
  >
    <div class="startup-brand" aria-label="Private AI">
      <span class="startup-brand-mark">AI</span>
      <strong>Private AI</strong>
    </div>

    <div v-if="app.loading.value" class="startup-skeleton" data-testid="startup-skeleton">
      <aside class="startup-skeleton-sidebar">
        <span class="skeleton-line skeleton-line-wide"></span>
        <span class="skeleton-block skeleton-action"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
      </aside>
      <div class="startup-skeleton-main">
        <span class="skeleton-line skeleton-title"></span>
        <span class="skeleton-panel"></span>
        <span class="skeleton-panel skeleton-panel-short"></span>
      </div>
      <aside class="startup-skeleton-inspector">
        <span class="skeleton-line"></span>
        <span class="skeleton-block skeleton-card"></span>
        <span class="skeleton-block skeleton-card"></span>
      </aside>
      <p class="startup-message">正在加载最新工作区…</p>
    </div>

    <div v-else class="startup-failure" data-testid="startup-failure" role="alert">
      <h1>工作区初始化失败</h1>
      <p>{{ app.startupError.value }}</p>
      <button class="primary-action compact" type="button" @click="app.retryInitialWorkspace">
        重试
      </button>
    </div>
  </section>

  <main v-else class="desktop-shell" :class="{ 'settings-shell': view === 'settings' }">
    <Sidebar
      :workspaces="app.state.value.snapshot.workspaces"
      :threads="app.state.value.snapshot.threads"
      :active-thread-id="activeThreadId"
      :active-workspace-id="app.activeWorkspaceId.value"
      :runtime-by-thread="app.state.value.runtimeByThread"
      :delete-feedback="deleteFeedback"
      :loading="app.loading.value"
      :theme="theme"
      :language="app.state.value.snapshot.settings.language"
      :t="t"
      @new-thread="createThread"
      @add-workspace="openWorkspaceDialog"
      @select-thread="selectThread"
      @select-workspace="selectWorkspace"
      @toggle-pin="togglePin"
      @delete-thread="deleteThread"
      @toggle-theme="toggleTheme"
      @open-settings="view = 'settings'"
    />

    <Conversation
      v-if="view === 'chat'"
      :thread="app.activeThread.value"
      :items="app.activeItems.value"
      :turns="app.activeTurns.value"
      :events="app.visibleEvents.value"
      :active-busy="app.activeBusy.value"
      :active-runtime="app.activeRuntime.value"
      :reasoning-display-mode="app.state.value.snapshot.settings.reasoningDisplayMode"
      :loading="app.loading.value"
      :model-profiles="app.state.value.snapshot.modelProfiles"
      :model-providers="app.state.value.snapshot.modelProviders ?? []"
      :active-model-profile-id="app.activeModelProfileId.value"
      :active-model-profile="app.activeModelProfile.value"
      :thread-workspace-name="threadWorkspaceName"
      :latest-undoable-turn="latestUndoableTurn"
      :runtime-error="runtimeError"
      :t="t"
      @submit="startTurn"
      @cancel="app.cancelTurn"
      @open-settings="view = 'settings'"
      @select-model="app.selectModelProfile"
      @undo-turn="undoTurnFileChanges"
    />

    <Inspector
      v-if="view === 'chat'"
      :pending-approval="app.activePendingApproval.value"
      :events="app.visibleEvents.value"
      :turns="app.activeTurns.value"
      :settings="app.state.value.snapshot.settings"
      :busy="app.activeBusy.value"
      :approval-response-in-flight="app.approvalResponseInFlightId.value === app.activePendingApproval.value?.id"
      :approval-error="approvalError"
      :t="t"
      @approve="respondApproval($event, true)"
      @reject="respondApproval($event, false)"
    />

    <SettingsView
      v-else
      :model-profiles="app.state.value.snapshot.modelProfiles"
      :model-providers="app.state.value.snapshot.modelProviders ?? []"
      :active-model-profile-id="app.activeModelProfileId.value"
      :language="app.state.value.snapshot.settings.language"
      :settings="app.state.value.snapshot.settings"
      :workspaces="app.state.value.snapshot.workspaces"
      :t="t"
      :save-model-provider="app.saveModelProvider"
      :delete-model-provider="app.deleteModelProvider"
      :discover-provider-models="app.discoverProviderModels"
      :test-model-provider="app.testModelProvider"
      :add-provider-models="app.addProviderModels"
      :update-provider-model="app.updateProviderModel"
      :delete-provider-model="app.deleteProviderModel"
      @back="view = 'chat'"
      @delete-workspace="app.deleteWorkspace"
      @set-workspace-trust="app.updateWorkspaceTrust"
      @add-workspace="openWorkspaceDialog"
      @select-model-profile="app.selectModelProfile"
      @set-language="app.setLanguage"
      @update-settings="app.updateSettings"
    />

    <WorkspaceDialog
      :open="workspaceDialogOpen"
      :t="t"
      :register-workspace="app.registerWorkspace"
      @close="workspaceDialogOpen = false"
      @registered="(workspace) => handleWorkspaceRegistered(workspace.id)"
    />
  </main>
</template>
