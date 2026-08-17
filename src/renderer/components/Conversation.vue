<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type {
  Item,
  ModelProfile,
  ReasoningDisplayMode,
  ReasoningItem,
  ThreadRuntimeState,
  ThreadSummary,
} from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import type { Translator } from '../i18n';
import { renderMarkdown } from '../markdown';
import {
  groupReasoningItems,
  reasoningControls,
  shouldShowReasoningPanel,
  type ReasoningItemGroup,
} from '../modelControls';
import { isNearBottom } from '../scrolling';
import { createTimelineEntries } from '../timeline';
import Composer from './Composer.vue';
import ReasoningPanel from './ReasoningPanel.vue';

const props = defineProps<{
  thread?: ThreadSummary;
  items: Item[];
  events: AgentEvent[];
  activeBusy: boolean;
  activeRuntime?: ThreadRuntimeState;
  reasoningDisplayMode: ReasoningDisplayMode;
  loading: boolean;
  modelProfiles: ModelProfile[];
  activeModelProfileId?: string;
  activeModelProfile?: ModelProfile;
  runtimeError?: string;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
  openSettings: [];
  selectModel: [modelProfileId?: string];
  updateModelRuntime: [patch: { reasoning?: { mode?: 'enabled' | 'disabled'; effort?: string } }];
}>();

const timelineEntries = computed(() => createTimelineEntries(props.items, props.events));
const reasoningGroups = computed(() => groupReasoningItems(
  props.items.filter((item): item is ReasoningItem => item.kind === 'reasoning'),
));
const reasoningGroupByTurn = computed(() => new Map(reasoningGroups.value.map((group) => [group.turnId, group])));
const reasoningPanelByEntryId = computed(() => {
  const panels = new Map(reasoningGroups.value.map((group) => [group.anchorId, group]));
  for (const entry of timelineEntries.value) {
    if (entry.kind !== 'message' || entry.role !== 'assistant' || !entry.turnId || reasoningGroupByTurn.value.has(entry.turnId)) {
      continue;
    }
    const running = props.activeRuntime?.turnId === entry.turnId
      && (props.activeRuntime.status === 'running' || props.activeRuntime.status === 'cancelling');
    if (shouldShowReasoningPanel(props.reasoningDisplayMode, [], running)) {
      panels.set(entry.id, { turnId: entry.turnId, anchorId: entry.id });
    }
  }
  return panels;
});
const standaloneReasoningGroup = computed<ReasoningItemGroup | undefined>(() => {
  const runtime = props.activeRuntime;
  if (!runtime?.turnId || (runtime.status !== 'running' && runtime.status !== 'cancelling')) {
    return undefined;
  }
  if (reasoningGroupByTurn.value.has(runtime.turnId)) {
    return undefined;
  }
  const hasAssistantAnchor = timelineEntries.value.some(
    (entry) => entry.kind === 'message' && entry.role === 'assistant' && entry.turnId === runtime.turnId,
  );
  return hasAssistantAnchor ? undefined : { turnId: runtime.turnId, anchorId: `reasoning-${runtime.turnId}` };
});
const timelineRef = ref<HTMLElement>();
const isPinnedToBottom = ref(true);
const hasUnreadBelow = ref(false);
const isAutoScrolling = ref(false);
const reasoningMenuOpen = ref(false);

const scrollSignature = computed(() =>
  timelineEntries.value
    .map((entry) => `${entry.id}:${entry.kind === 'progress' ? entry.phase : entry.text.length}`)
    .join('|'),
);

function handleModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectModel', value || undefined);
}

const reasoningControl = computed(() =>
  props.activeModelProfile ? reasoningControls(props.activeModelProfile) : { kind: 'hidden' as const },
);
const activeReasoningEffort = computed(() =>
  props.activeModelProfile?.reasoning.effort
    ?? props.activeModelProfile?.capabilities.reasoning.defaultEffort
    ?? (reasoningControl.value.kind === 'effort' ? reasoningControl.value.options[0] : undefined),
);
const reasoningSummary = computed(() => {
  if (!props.activeModelProfile || props.activeModelProfile.reasoning.mode === 'disabled') {
    return props.t('disabled');
  }
  if (reasoningControl.value.kind === 'toggle') {
    return props.t('enabled');
  }
  return activeReasoningEffort.value ?? props.t('enabled');
});
const runtimeStatus = computed(() => {
  const runtime = props.activeRuntime;
  if (!runtime || runtime.status === 'idle') {
    return props.t('ready');
  }
  if (runtime.status === 'queued') {
    return runtime.queuePosition
      ? props.t('queuedPosition').replace('{position}', String(runtime.queuePosition))
      : props.t('queued');
  }
  return props.t(runtime.status);
});
const progressLabel = (phase: 'connecting' | 'reasoning' | 'answering') => {
  if (phase === 'reasoning') {
    return props.t('modelReasoning');
  }
  if (phase === 'answering') {
    return props.t('modelAnswering');
  }
  return props.t('modelConnecting');
};

function setReasoningEffort(effort: string): void {
  reasoningMenuOpen.value = false;
  emit('updateModelRuntime', { reasoning: { mode: 'enabled', effort } });
}

function toggleReasoning(): void {
  const enabled = props.activeModelProfile?.reasoning.mode !== 'disabled';
  emit('updateModelRuntime', { reasoning: { mode: enabled ? 'disabled' : 'enabled' } });
}

function toggleReasoningMenu(): void {
  if (reasoningControl.value.kind !== 'effort') {
    return;
  }
  reasoningMenuOpen.value = !reasoningMenuOpen.value;
}

function isReasoningRunning(group: ReasoningItemGroup): boolean {
  return props.activeRuntime?.turnId === group.turnId
    && (props.activeRuntime.status === 'running' || props.activeRuntime.status === 'cancelling');
}

function scrollToBottomNow(): void {
  const element = timelineRef.value;
  if (!element) {
    return;
  }
  element.scrollTop = element.scrollHeight;
}

async function scrollToBottom(): Promise<void> {
  isAutoScrolling.value = true;
  await nextTick();
  scrollToBottomNow();
  await nextAnimationFrame();
  scrollToBottomNow();
  await nextAnimationFrame();
  scrollToBottomNow();
  isAutoScrolling.value = false;
}

function handleTimelineScroll(): void {
  const element = timelineRef.value;
  if (!element) {
    return;
  }

  if (isAutoScrolling.value) {
    return;
  }

  if (isNearBottom(element)) {
    isPinnedToBottom.value = true;
    hasUnreadBelow.value = false;
    return;
  }

  isPinnedToBottom.value = false;
}

function jumpToBottom(): void {
  isPinnedToBottom.value = true;
  hasUnreadBelow.value = false;
  void scrollToBottom();
}

watch(
  scrollSignature,
  async () => {
    if (isPinnedToBottom.value) {
      await scrollToBottom();
    } else {
      hasUnreadBelow.value = true;
    }
  },
  { flush: 'post' },
);

watch(
  () => props.activeBusy,
  async (busy) => {
    if (busy) {
      isPinnedToBottom.value = true;
      hasUnreadBelow.value = false;
      await scrollToBottom();
    }
  },
  { flush: 'post' },
);

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
</script>

<template>
  <section class="conversation-pane" aria-label="Conversation">
    <header class="conversation-header">
      <div>
        <p class="pane-label">{{ t('task') }}</p>
        <h1>{{ thread?.title ?? t('localAgentWorkspace') }}</h1>
      </div>
      <div class="conversation-controls">
        <label class="model-picker">
          <span>{{ t('model') }}</span>
          <select :value="activeModelProfileId ?? ''" class="model-select" @change="handleModelChange">
            <option value="">{{ t('demoMode') }}</option>
            <option v-for="profile in modelProfiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </option>
          </select>
        </label>
        <div v-if="reasoningControl.kind === 'toggle'" class="runtime-menu" data-testid="reasoning-runtime-menu">
          <button
            type="button"
            class="runtime-menu-trigger"
            data-testid="reasoning-runtime-trigger"
            @click="toggleReasoning"
          >
            <span>{{ t('thinkingMode') }}</span>
            <strong>{{ reasoningSummary }}</strong>
          </button>
        </div>
        <div v-else-if="reasoningControl.kind === 'effort'" class="runtime-menu" data-testid="reasoning-runtime-menu">
          <button
            type="button"
            class="runtime-menu-trigger"
            data-testid="reasoning-runtime-trigger"
            @click="toggleReasoningMenu"
          >
            <span>{{ t('reasoningEffort') }}</span>
            <strong>{{ reasoningSummary }}</strong>
          </button>
          <div v-if="reasoningMenuOpen" class="runtime-menu-panel">
            <button
              v-for="effort in reasoningControl.options"
              :key="effort"
              type="button"
              :data-testid="`reasoning-runtime-${effort}`"
              :class="{ active: activeModelProfile?.reasoning.mode !== 'disabled' && activeReasoningEffort === effort }"
              :disabled="!activeModelProfile"
              @click="setReasoningEffort(effort)"
            >
              {{ effort }}
            </button>
          </div>
        </div>
        <button
          v-else-if="reasoningControl.kind === 'custom'"
          type="button"
          class="capability-warning"
          data-testid="reasoning-custom-warning"
          @click="emit('openSettings')"
        >
          {{ t('customReasoningWarning') }}
        </button>
        <span class="runtime-pill" data-testid="active-runtime-status">{{ runtimeStatus }}</span>
        <span v-if="runtimeError" class="runtime-control-error" :title="runtimeError">{{ runtimeError }}</span>
      </div>
    </header>

    <div ref="timelineRef" class="timeline" @scroll="handleTimelineScroll">
      <div class="timeline-stack">
        <div v-if="loading" class="empty-state">{{ t('loadingWorkspace') }}</div>
        <div v-else-if="!thread" class="empty-state">{{ t('createTaskHint') }}</div>

        <ReasoningPanel
          v-if="standaloneReasoningGroup"
          :preference="reasoningDisplayMode"
          :running="true"
          :t="t"
        />

        <template
          v-for="entry in timelineEntries"
          :key="entry.id"
        >
          <ReasoningPanel
            v-if="reasoningPanelByEntryId.get(entry.id)"
            :raw="reasoningPanelByEntryId.get(entry.id)?.raw"
            :summary="reasoningPanelByEntryId.get(entry.id)?.summary"
            :preference="reasoningDisplayMode"
            :running="isReasoningRunning(reasoningPanelByEntryId.get(entry.id)!)"
            :t="t"
          />
          <article
            v-if="entry.kind !== 'reasoning'"
            :class="
              entry.kind === 'message'
                ? ['message-row', `role-${entry.role}`, { live: entry.live }]
                : entry.kind === 'metrics'
                  ? 'metrics-row'
                  : entry.kind === 'progress'
                    ? 'progress-row'
                    : 'tool-row'
            "
          >
            <template v-if="entry.kind === 'message'">
              <span class="message-role">{{ entry.role === 'assistant' ? t('assistant') : entry.role === 'user' ? t('user') : entry.role }}</span>
              <div v-if="entry.role === 'assistant'" class="message-content markdown-body" v-html="renderMarkdown(entry.text)"></div>
              <p v-else class="message-content">{{ entry.text }}</p>
            </template>
            <span v-else-if="entry.kind === 'progress'" class="progress-label">
              <span class="progress-dot" aria-hidden="true"></span>
              {{ progressLabel(entry.phase) }}
            </span>
            <span v-else>{{ entry.text }}</span>
          </article>
        </template>
      </div>
      <button v-if="hasUnreadBelow" type="button" class="jump-to-bottom" @click="jumpToBottom">↓</button>
    </div>

    <Composer
      :active-busy="activeBusy"
      :active-runtime="activeRuntime"
      :t="t"
      @submit="emit('submit', $event)"
      @cancel="emit('cancel')"
    />
  </section>
</template>
