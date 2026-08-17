<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ModelProfileInput } from '../shared/domain';
import Conversation from './components/Conversation.vue';
import Inspector from './components/Inspector.vue';
import SettingsView from './components/SettingsView.vue';
import Sidebar from './components/Sidebar.vue';
import { useApp } from './composables/useApp';
import { createTranslator } from './i18n';

const app = useApp();
const theme = ref<'light' | 'dark'>('dark');
const view = ref<'chat' | 'settings'>('chat');

const activeThreadId = computed(() => app.state.value.activeThreadId);
const t = computed(() => createTranslator(app.state.value.snapshot.settings.language));

onMounted(() => {
  document.documentElement.dataset.theme = theme.value;
});

async function createThread(): Promise<void> {
  view.value = 'chat';
  await app.createThread('New task', app.state.value.activeGroupId);
}

function selectThread(threadId: string): void {
  view.value = 'chat';
  app.state.value.activeThreadId = threadId;
  app.state.value.activeGroupId = app.state.value.snapshot.threads.find((thread) => thread.id === threadId)?.groupId;
}

function selectGroup(groupId: string): void {
  view.value = 'chat';
  app.state.value.activeGroupId = groupId;
  app.state.value.activeThreadId = app.state.value.snapshot.threads.find((thread) => thread.groupId === groupId)?.id;
}

async function createGroup(): Promise<void> {
  const name = window.prompt(t.value('newGroupName'), t.value('defaultGroupName'));
  if (!name?.trim()) {
    return;
  }
  view.value = 'chat';
  await app.createGroup(name.trim());
}

async function deleteThread(threadId: string): Promise<void> {
  if (!window.confirm(t.value('deleteChatConfirm'))) {
    return;
  }
  await app.deleteThread(threadId);
}

async function deleteGroup(groupId: string): Promise<void> {
  if (!window.confirm(t.value('deleteGroupConfirm'))) {
    return;
  }
  await app.deleteGroup(groupId);
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}

async function testModelProfile(profile: ModelProfileInput, report: (message: string) => void): Promise<void> {
  try {
    const result = await app.testModelProfile(profile);
    report(result.message);
  } catch (error) {
    report(error instanceof Error ? error.message : t.value('modelConnectionFailed'));
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
      :events="app.visibleEvents.value"
      :busy="app.state.value.busy"
      :loading="app.loading.value"
      :model-profiles="app.state.value.snapshot.modelProfiles"
      :active-model-profile-id="app.activeModelProfileId.value"
      :active-model-profile="app.activeModelProfile.value"
      :t="t"
      @submit="app.startTurn"
      @cancel="app.cancelTurn"
      @select-model="app.selectModelProfile"
      @update-model-runtime="app.updateActiveModelRuntime"
    />

    <Inspector
      v-if="view === 'chat'"
      :pending-approval="app.state.value.pendingApproval"
      :events="app.visibleEvents.value"
      :settings="app.state.value.snapshot.settings"
      :busy="app.state.value.busy"
      :t="t"
      @approve="app.respondApproval(true)"
      @reject="app.respondApproval(false)"
    />

    <SettingsView
      v-else
      :model-profiles="app.state.value.snapshot.modelProfiles"
      :active-model-profile-id="app.activeModelProfileId.value"
      :language="app.state.value.snapshot.settings.language"
      :settings="app.state.value.snapshot.settings"
      :t="t"
      @back="view = 'chat'"
      @save-model-profile="app.saveModelProfile"
      @delete-model-profile="app.deleteModelProfile"
      @test-model-profile="testModelProfile"
      @select-model-profile="app.selectModelProfile"
      @set-language="app.setLanguage"
      @update-settings="app.updateSettings"
    />
  </main>
</template>
