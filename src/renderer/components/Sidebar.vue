<script setup lang="ts">
import { computed } from 'vue';
import type { ChatGroup, ThreadSummary } from '../../shared/domain';
import type { Translator } from '../i18n';

const props = defineProps<{
  groups: ChatGroup[];
  threads: ThreadSummary[];
  activeThreadId?: string;
  activeGroupId?: string;
  loading: boolean;
  theme: 'light' | 'dark';
  t: Translator;
}>();

defineEmits<{
  newThread: [];
  newGroup: [];
  selectThread: [threadId: string];
  selectGroup: [groupId: string];
  deleteThread: [threadId: string];
  deleteGroup: [groupId: string];
  toggleTheme: [];
  openSettings: [];
}>();

const groupsWithThreads = computed(() =>
  props.groups.map((group) => ({
    group,
    threads: props.threads.filter((thread) => thread.groupId === group.id),
  })),
);
</script>

<template>
  <aside class="sidebar-pane" aria-label="Task navigation">
    <div class="brand-row">
      <span class="brand-mark">AI</span>
      <div>
        <p class="brand-title">{{ t('appBrand') }}</p>
        <p class="brand-subtitle">{{ t('appSubtitle') }}</p>
      </div>
    </div>

    <button class="primary-action" type="button" @click="$emit('newThread')">
      <span aria-hidden="true">+</span>
      <span>{{ t('newTask') }}</span>
    </button>

    <nav class="thread-list" aria-label="Tasks">
      <div class="sidebar-section-heading">
        <p class="pane-label">{{ t('workspace') }}</p>
        <button class="mini-button" type="button" :title="t('newGroup')" @click="$emit('newGroup')">+</button>
      </div>

      <section v-for="entry in groupsWithThreads" :key="entry.group.id" class="group-section">
        <button
          class="group-button"
          :class="{ active: entry.group.id === activeGroupId }"
          type="button"
          @click="$emit('selectGroup', entry.group.id)"
        >
          <span class="group-name">{{ entry.group.name }}</span>
          <span class="group-count">{{ entry.threads.length }}</span>
        </button>
        <div
          v-for="thread in entry.threads"
          :key="thread.id"
          class="thread-row"
          :class="{ active: thread.id === activeThreadId }"
        >
          <button class="thread-button" type="button" @click="$emit('selectThread', thread.id)">
            <span class="thread-title">{{ thread.title }}</span>
            <span class="thread-status">{{ thread.status }}</span>
          </button>
          <button class="delete-chat-button" type="button" :title="t('deleteChat')" @click.stop="$emit('deleteThread', thread.id)">×</button>
        </div>
      </section>

      <p v-if="!loading && threads.length === 0" class="empty-copy">{{ t('noTasksYet') }}</p>
    </nav>

    <div class="sidebar-footer">
      <button class="icon-button" type="button" :title="`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`" @click="$emit('toggleTheme')">
        <span aria-hidden="true">{{ theme === 'dark' ? 'L' : 'D' }}</span>
      </button>
      <button class="settings-link" type="button" :title="t('openSettings')" @click="$emit('openSettings')">⚙ {{ t('settings') }}</button>
    </div>
  </aside>
</template>
