<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LanguagePreference, ThreadRuntimeState, ThreadSummary, WorkspaceRecord } from '../../shared/domain';
import type { DeleteFeedback } from '../deleteFeedback';
import type { Translator } from '../i18n';
import { threadRuntimePresentation } from '../modelControls';
import { formatRelativeTime } from '../relativeTime';

const props = defineProps<{
  workspaces: WorkspaceRecord[];
  threads: ThreadSummary[];
  activeThreadId?: string;
  activeWorkspaceId?: string;
  runtimeByThread: Record<string, ThreadRuntimeState>;
  deleteFeedback?: DeleteFeedback;
  loading: boolean;
  theme: 'light' | 'dark';
  language: LanguagePreference;
  t: Translator;
}>();

defineEmits<{
  newThread: [];
  addWorkspace: [];
  selectThread: [threadId: string];
  selectWorkspace: [workspaceId: string];
  togglePin: [threadId: string, pinned: boolean];
  deleteThread: [threadId: string];
  toggleTheme: [];
  openSettings: [];
}>();

const searchQuery = ref('');
const collapsedWorkspaceIds = ref<Set<string>>(new Set());

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function matchesQuery(thread: ThreadSummary): boolean {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return true;
  return thread.title.toLowerCase().includes(query);
}

const workspaceSections = computed(() =>
  props.workspaces.map((workspace) => ({
    workspace,
    threads: sortThreads(
      props.threads.filter((thread) => thread.workspaceId === workspace.id && matchesQuery(thread)),
    ),
  })),
);

const unlinkedThreads = computed(() =>
  sortThreads(props.threads.filter((thread) => !thread.workspaceId && matchesQuery(thread))),
);

function toggleWorkspaceCollapsed(workspaceId: string): void {
  const next = new Set(collapsedWorkspaceIds.value);
  if (next.has(workspaceId)) {
    next.delete(workspaceId);
  } else {
    next.add(workspaceId);
  }
  collapsedWorkspaceIds.value = next;
}

function relativeTime(thread: ThreadSummary): string {
  return formatRelativeTime(thread.updatedAt, props.language);
}

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

    <input
      v-model="searchQuery"
      class="sidebar-search"
      type="search"
      data-testid="sidebar-search"
      :placeholder="t('searchChatsPlaceholder')"
    />

    <nav class="thread-list" aria-label="Tasks">
      <section
        v-for="section in workspaceSections"
        :key="section.workspace.id"
        class="workspace-section"
      >
        <div
          class="workspace-heading"
          :class="{ active: section.workspace.id === activeWorkspaceId }"
          :data-testid="`workspace-section-${section.workspace.id}`"
        >
          <button
            class="workspace-toggle"
            type="button"
            :aria-expanded="!collapsedWorkspaceIds.has(section.workspace.id)"
            @click="toggleWorkspaceCollapsed(section.workspace.id)"
          >
            <span class="workspace-caret" aria-hidden="true">{{ collapsedWorkspaceIds.has(section.workspace.id) ? '▸' : '▾' }}</span>
            <span class="workspace-folder-icon" aria-hidden="true">📁</span>
            <span class="workspace-name">{{ section.workspace.displayName }}</span>
            <span class="workspace-count">{{ section.threads.length }}</span>
          </button>
          <button
            class="mini-button"
            type="button"
            :title="t('newTask')"
            :data-testid="`workspace-new-thread-${section.workspace.id}`"
            @click="$emit('selectWorkspace', section.workspace.id); $emit('newThread')"
          >+</button>
        </div>

        <template v-if="!collapsedWorkspaceIds.has(section.workspace.id)">
          <article
            v-for="thread in section.threads"
            :key="thread.id"
            class="thread-row"
            :class="{ active: thread.id === activeThreadId, 'runtime-active': runtimeActive(thread) }"
            :data-testid="`thread-row-${thread.id}`"
          >
            <button class="thread-button" type="button" @click="$emit('selectThread', thread.id)">
              <span class="thread-title">
                <span v-if="thread.pinned" class="thread-pin-mark" aria-hidden="true">📌</span>
                {{ thread.title }}
              </span>
              <span class="thread-meta">
                <span class="thread-time">{{ relativeTime(thread) }}</span>
                <span
                  class="thread-status"
                  data-testid="thread-runtime-status"
                  :data-runtime-status="runtimeByThread[thread.id]?.status ?? thread.status"
                  :data-queue-position="runtimeByThread[thread.id]?.queuePosition"
                >
                  <span v-if="runtimeActive(thread)" class="thread-runtime-dot" aria-hidden="true"></span>
                  {{ runtimeText(thread) }}
                </span>
              </span>
            </button>
            <button
              class="thread-hover-action"
              type="button"
              :title="thread.pinned ? t('unpinChat') : t('pinChat')"
              :data-testid="`thread-pin-${thread.id}`"
              @click.stop="$emit('togglePin', thread.id, !thread.pinned)"
            >{{ thread.pinned ? '📌' : '📍' }}</button>
            <button
              class="thread-hover-action delete-chat-button"
              type="button"
              :title="t('deleteChat')"
              :data-testid="`thread-delete-${thread.id}`"
              @click.stop="$emit('deleteThread', thread.id)"
            >×</button>
            <p
              v-if="deleteFeedback?.kind === 'thread' && deleteFeedback.targetId === thread.id"
              class="sidebar-operation-error"
              data-testid="thread-delete-error"
              :data-target-id="thread.id"
              role="status"
            >{{ deleteFeedback.message }}</p>
          </article>
        </template>
      </section>

      <section v-if="unlinkedThreads.length > 0" class="workspace-section unlinked-section">
        <div class="workspace-heading">
          <span class="workspace-toggle">
            <span class="workspace-folder-icon" aria-hidden="true">💬</span>
            <span class="workspace-name">{{ t('unlinkedChats') }}</span>
            <span class="workspace-count">{{ unlinkedThreads.length }}</span>
          </span>
        </div>
        <article
          v-for="thread in unlinkedThreads"
          :key="thread.id"
          class="thread-row"
          :class="{ active: thread.id === activeThreadId, 'runtime-active': runtimeActive(thread) }"
          :data-testid="`thread-row-${thread.id}`"
        >
          <button class="thread-button" type="button" @click="$emit('selectThread', thread.id)">
            <span class="thread-title">
              <span v-if="thread.pinned" class="thread-pin-mark" aria-hidden="true">📌</span>
              {{ thread.title }}
            </span>
            <span class="thread-meta">
              <span class="thread-time">{{ relativeTime(thread) }}</span>
              <span
                class="thread-status"
                data-testid="thread-runtime-status"
                :data-runtime-status="runtimeByThread[thread.id]?.status ?? thread.status"
                :data-queue-position="runtimeByThread[thread.id]?.queuePosition"
              >
                <span v-if="runtimeActive(thread)" class="thread-runtime-dot" aria-hidden="true"></span>
                {{ runtimeText(thread) }}
              </span>
            </span>
          </button>
          <button
            class="thread-hover-action"
            type="button"
            :title="thread.pinned ? t('unpinChat') : t('pinChat')"
            :data-testid="`thread-pin-${thread.id}`"
            @click.stop="$emit('togglePin', thread.id, !thread.pinned)"
          >{{ thread.pinned ? '📌' : '📍' }}</button>
          <button
            class="thread-hover-action delete-chat-button"
            type="button"
            :title="t('deleteChat')"
            :data-testid="`thread-delete-${thread.id}`"
            @click.stop="$emit('deleteThread', thread.id)"
          >×</button>
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

    <button class="add-workspace-action" type="button" data-testid="add-workspace" @click="$emit('addWorkspace')">
      <span aria-hidden="true">+</span>
      <span>{{ t('addWorkspace') }}</span>
    </button>

    <div class="sidebar-footer">
      <button class="icon-button" type="button" :title="`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`" @click="$emit('toggleTheme')">
        <span aria-hidden="true">{{ theme === 'dark' ? 'L' : 'D' }}</span>
      </button>
      <button class="settings-link" type="button" :title="t('openSettings')" @click="$emit('openSettings')">⚙ {{ t('settings') }}</button>
    </div>
  </aside>
</template>
