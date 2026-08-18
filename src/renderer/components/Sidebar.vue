<script setup lang="ts">
import { computed } from 'vue';
import type { ChatGroup, ThreadRuntimeState, ThreadSummary } from '../../shared/domain';
import type { DeleteFeedback } from '../deleteFeedback';
import type { Translator } from '../i18n';
import { threadRuntimePresentation } from '../modelControls';

const props = defineProps<{
  groups: ChatGroup[];
  threads: ThreadSummary[];
  activeThreadId?: string;
  activeGroupId?: string;
  runtimeByThread: Record<string, ThreadRuntimeState>;
  deleteFeedback?: DeleteFeedback;
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

function runtimeText(thread: ThreadSummary): string {
  const presentation = threadRuntimePresentation(props.runtimeByThread[thread.id], thread.status);
  const label = props.t(presentation.key);
  return presentation.key === 'queuedPosition' && presentation.queuePosition
    ? label.replace('{position}', String(presentation.queuePosition))
    : label;
}

function runtimeActive(thread: ThreadSummary): boolean {
  return threadRuntimePresentation(props.runtimeByThread[thread.id], thread.status).active;
}
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
        <p
          v-if="deleteFeedback?.kind === 'group' && deleteFeedback.targetId === entry.group.id"
          class="sidebar-operation-error"
          data-testid="group-delete-error"
          :data-target-id="entry.group.id"
          role="status"
        >{{ deleteFeedback.message }}</p>
        <article
          v-for="thread in entry.threads"
          :key="thread.id"
          class="thread-row"
          :class="{ active: thread.id === activeThreadId, 'runtime-active': runtimeActive(thread) }"
          :data-testid="`thread-row-${thread.id}`"
        >
          <button class="thread-button" type="button" @click="$emit('selectThread', thread.id)">
            <span class="thread-title">{{ thread.title }}</span>
            <span
              class="thread-status"
              data-testid="thread-runtime-status"
              :data-runtime-status="runtimeByThread[thread.id]?.status ?? thread.status"
              :data-queue-position="runtimeByThread[thread.id]?.queuePosition"
            >
              <span v-if="runtimeActive(thread)" class="thread-runtime-dot" aria-hidden="true"></span>
              {{ runtimeText(thread) }}
            </span>
          </button>
          <button class="delete-chat-button" type="button" :title="t('deleteChat')" @click.stop="$emit('deleteThread', thread.id)">×</button>
          <p
            v-if="deleteFeedback?.kind === 'thread' && deleteFeedback.targetId === thread.id"
            class="sidebar-operation-error"
            data-testid="thread-delete-error"
            :data-target-id="thread.id"
            role="status"
          >{{ deleteFeedback.message }}</p>
        </article>
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
