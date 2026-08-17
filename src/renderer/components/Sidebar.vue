<script setup lang="ts">
import type { ThreadSummary } from '../../shared/domain';

defineProps<{
  threads: ThreadSummary[];
  activeThreadId?: string;
  loading: boolean;
  theme: 'light' | 'dark';
}>();

defineEmits<{
  newThread: [];
  selectThread: [threadId: string];
  toggleTheme: [];
}>();
</script>

<template>
  <aside class="sidebar-pane" aria-label="Task navigation">
    <div class="brand-row">
      <span class="brand-mark">AI</span>
      <div>
        <p class="brand-title">Private AI</p>
        <p class="brand-subtitle">Local agent desktop</p>
      </div>
    </div>

    <button class="primary-action" type="button" @click="$emit('newThread')">
      <span aria-hidden="true">+</span>
      <span>New task</span>
    </button>

    <nav class="thread-list" aria-label="Tasks">
      <p class="pane-label">Workspace</p>
      <button
        v-for="thread in threads"
        :key="thread.id"
        class="thread-button"
        :class="{ active: thread.id === activeThreadId }"
        type="button"
        @click="$emit('selectThread', thread.id)"
      >
        <span class="thread-title">{{ thread.title }}</span>
        <span class="thread-status">{{ thread.status }}</span>
      </button>
      <p v-if="!loading && threads.length === 0" class="empty-copy">No tasks yet</p>
    </nav>

    <div class="sidebar-footer">
      <button class="icon-button" type="button" :title="`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`" @click="$emit('toggleTheme')">
        <span aria-hidden="true">{{ theme === 'dark' ? 'L' : 'D' }}</span>
      </button>
      <span class="footer-note">Demo mode</span>
    </div>
  </aside>
</template>
