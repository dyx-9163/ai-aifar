<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ModelConnectionResult, ModelProfileInput, TurnAttachment } from '../shared/domain';
import Conversation from './components/Conversation.vue';
import Inspector from './components/Inspector.vue';
import SettingsView from './components/SettingsView.vue';
import Sidebar from './components/Sidebar.vue';
import { useApp } from './composables/useApp';
import { deleteFailureFeedback, type DeleteFeedback } from './deleteFeedback';
import { createTranslator } from './i18n';

const app = useApp();
const theme = ref<'light' | 'dark'>('dark');
const view = ref<'chat' | 'settings'>('chat');
const runtimeError = ref('');
const approvalError = ref('');
const deleteFeedback = ref<DeleteFeedback>();

const activeThreadId = computed(() => app.state.value.activeThreadId);
const t = computed(() => createTranslator(app.state.value.snapshot.settings.language));

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
  await app.createThread('New task', app.state.value.activeGroupId);
}

function selectThread(threadId: string): void {
  deleteFeedback.value = undefined;
  view.value = 'chat';
  app.state.value.activeThreadId = threadId;
  app.state.value.activeGroupId = app.state.value.snapshot.threads.find((thread) => thread.id === threadId)?.groupId;
}

function selectGroup(groupId: string): void {
  deleteFeedback.value = undefined;
  view.value = 'chat';
  app.state.value.activeGroupId = groupId;
  app.state.value.activeThreadId = app.state.value.snapshot.threads.find((thread) => thread.groupId === groupId)?.id;
}

async function createGroup(): Promise<void> {
  const name = window.prompt(t.value('newGroupName'), t.value('defaultGroupName'));
  if (!name?.trim()) {
    return;
  }
  deleteFeedback.value = undefined;
  view.value = 'chat';
  await app.createGroup(name.trim());
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

async function deleteGroup(groupId: string): Promise<void> {
  if (!window.confirm(t.value('deleteGroupConfirm'))) {
    return;
  }
  deleteFeedback.value = undefined;
  try {
    await app.deleteGroup(groupId);
  } catch (error) {
    deleteFeedback.value = deleteFailureFeedback('group', groupId, error, t.value);
  }
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}

async function testModelProfile(profile: ModelProfileInput): Promise<ModelConnectionResult> {
  return app.testModelProfile(profile);
}

async function updateModelRuntime(patch: {
  reasoning?: { mode?: 'enabled' | 'disabled'; effort?: string };
}): Promise<void> {
  runtimeError.value = '';
  try {
    await app.updateActiveModelRuntime(patch);
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : t.value('modelConnectionFailed');
  }
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
</script>

<template>
  <main class="desktop-shell" :class="{ 'settings-shell': view === 'settings' }">
    <Sidebar
      :groups="app.state.value.snapshot.groups"
      :threads="app.state.value.snapshot.threads"
      :active-thread-id="activeThreadId"
      :active-group-id="app.state.value.activeGroupId"
      :runtime-by-thread="app.state.value.runtimeByThread"
      :delete-feedback="deleteFeedback"
      :loading="app.loading.value"
      :theme="theme"
      :t="t"
      @new-thread="createThread"
      @new-group="createGroup"
      @select-thread="selectThread"
      @select-group="selectGroup"
      @delete-thread="deleteThread"
      @delete-group="deleteGroup"
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
      :active-model-profile-id="app.activeModelProfileId.value"
      :active-model-profile="app.activeModelProfile.value"
      :runtime-error="runtimeError"
      :t="t"
      @submit="startTurn"
      @cancel="app.cancelTurn"
      @open-settings="view = 'settings'"
      @select-model="app.selectModelProfile"
      @update-model-runtime="updateModelRuntime"
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
      :active-model-profile-id="app.activeModelProfileId.value"
      :language="app.state.value.snapshot.settings.language"
      :settings="app.state.value.snapshot.settings"
      :t="t"
      :save-model-profile="app.saveModelProfile"
      :test-model-profile="testModelProfile"
      @back="view = 'chat'"
      @delete-model-profile="app.deleteModelProfile"
      @select-model-profile="app.selectModelProfile"
      @set-language="app.setLanguage"
      @update-settings="app.updateSettings"
    />
  </main>
</template>
