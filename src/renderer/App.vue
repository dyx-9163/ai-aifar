<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Conversation from './components/Conversation.vue';
import Inspector from './components/Inspector.vue';
import Sidebar from './components/Sidebar.vue';
import { useApp } from './composables/useApp';

const app = useApp();
const theme = ref<'light' | 'dark'>('dark');

const activeThreadId = computed(() => app.state.value.activeThreadId);

onMounted(() => {
  document.documentElement.dataset.theme = theme.value;
});

async function createThread(): Promise<void> {
  await app.createThread('New task');
}

function selectThread(threadId: string): void {
  app.state.value.activeThreadId = threadId;
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}
</script>

<template>
  <main class="desktop-shell">
    <Sidebar
      :threads="app.state.value.snapshot.threads"
      :active-thread-id="activeThreadId"
      :loading="app.loading.value"
      :theme="theme"
      @new-thread="createThread"
      @select-thread="selectThread"
      @toggle-theme="toggleTheme"
    />

    <Conversation
      :thread="app.activeThread.value"
      :items="app.activeItems.value"
      :events="app.visibleEvents.value"
      :busy="app.state.value.busy"
      :loading="app.loading.value"
      @submit="app.startTurn"
    />

    <Inspector
      :pending-approval="app.state.value.pendingApproval"
      :events="app.visibleEvents.value"
      :busy="app.state.value.busy"
      @approve="app.respondApproval(true)"
      @reject="app.respondApproval(false)"
    />
  </main>
</template>
