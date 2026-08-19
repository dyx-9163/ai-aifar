<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  Item,
  ModelProfile,
  ReasoningDisplayMode,
  ReasoningItem,
  ThreadRuntimeState,
  ThreadSummary,
  TurnAttachment,
  TurnRecord,
} from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import type { Translator } from '../i18n';
import { isLocalQwenServiceProfile } from '../../shared/localQwenIdentity';
import { renderMarkdown } from '../markdown';
import {
  copyTextWithFeedback,
  groupReasoningItems,
  reasoningControls,
  reasoningMenuCommand,
  reasoningProfileForRuntime,
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
  turns: TurnRecord[];
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
  submit: [text: string, attachments?: TurnAttachment[]];
  cancel: [];
  openSettings: [];
  selectModel: [modelProfileId?: string];
  updateModelRuntime: [patch: { reasoning?: { mode?: 'enabled' | 'disabled'; effort?: string } }];
}>();

const timelineEntries = computed(() => createTimelineEntries(props.items, props.events, props.turns, props.t));
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
const supportsVision = computed(() => Boolean(
  props.activeModelProfile?.capabilities.vision ||
  (props.activeModelProfile && isLocalQwenServiceProfile(props.activeModelProfile)),
));
const timelineRef = ref<HTMLElement>();
const isPinnedToBottom = ref(true);
const hasUnreadBelow = ref(false);
const isAutoScrolling = ref(false);
const messageCopyState = ref<Record<string, 'idle' | 'copied' | 'failed'>>({});
const reasoningMenuOpen = ref(false);
const reasoningMenuRef = ref<HTMLElement>();
const reasoningTriggerRef = ref<HTMLButtonElement>();
const reasoningMenuId = 'reasoning-effort-menu';
const copyResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
const runtimeReasoningProfile = computed(() => reasoningProfileForRuntime(
  props.modelProfiles,
  props.activeModelProfile,
  props.activeRuntime,
));
const activeReasoningEffort = computed(() =>
  props.activeModelProfile?.reasoning.effort
    ?? props.activeModelProfile?.capabilities.reasoning.defaultEffort,
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
const progressLabel = (phase: 'connecting' | 'compressing' | 'reasoning' | 'answering') => {
  if (phase === 'compressing') {
    return props.t('modelCompressingContext');
  }
  if (phase === 'reasoning') {
    return props.t('modelReasoning');
  }
  if (phase === 'answering') {
    return props.t('modelAnswering');
  }
  return props.t('modelConnecting');
};

function userMessageText(text: string): string {
  return text.replace(/\n\n\[已上传图片: .+\]$/, '');
}

function imageAttachments(entry: { attachments?: TurnAttachment[] }): TurnAttachment[] {
  return entry.attachments?.filter((attachment) => attachment.kind === 'image') ?? [];
}

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

function closeReasoningMenu(): void {
  reasoningMenuOpen.value = false;
}

function handleReasoningMenuKeydown(event: KeyboardEvent): void {
  if (reasoningMenuCommand(event.key) !== 'close') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeReasoningMenu();
  void nextTick(() => reasoningTriggerRef.value?.focus());
}

function handleReasoningFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node) || !reasoningMenuRef.value?.contains(next)) {
    closeReasoningMenu();
  }
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (reasoningMenuOpen.value && target instanceof Node && !reasoningMenuRef.value?.contains(target)) {
    closeReasoningMenu();
  }
}

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown));
onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  for (const timer of copyResetTimers.values()) clearTimeout(timer);
  copyResetTimers.clear();
});

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

function scheduleCopyStateReset(key: string): void {
  const previous = copyResetTimers.get(key);
  if (previous) clearTimeout(previous);
  copyResetTimers.set(key, setTimeout(() => {
    const next = { ...messageCopyState.value };
    delete next[key];
    messageCopyState.value = next;
    copyResetTimers.delete(key);
  }, 1_500));
}

async function copyAssistantMessage(entryId: string, text: string): Promise<void> {
  const state = await copyTextWithFeedback((value) => navigator.clipboard.writeText(value), text);
  messageCopyState.value = { ...messageCopyState.value, [entryId]: state };
  scheduleCopyStateReset(entryId);
}

async function handleAssistantContentClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-copy-code-button="true"]');
  if (!button) return;
  const code = button.closest('.code-block')?.querySelector('pre code')?.textContent;
  if (code === undefined) return;
  const state = await copyTextWithFeedback((value) => navigator.clipboard.writeText(value), code);
  button.dataset.copyState = state;
  button.textContent = state === 'copied' ? props.t('copied') : props.t('copyCodeFailed');
  setTimeout(() => {
    button.dataset.copyState = 'idle';
    button.textContent = props.t('copyCode');
  }, 1_500);
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
        <div
          v-else-if="reasoningControl.kind === 'effort'"
          ref="reasoningMenuRef"
          class="runtime-menu"
          data-testid="reasoning-runtime-menu"
          @keydown="handleReasoningMenuKeydown"
          @focusout="handleReasoningFocusOut"
        >
          <button
            :id="`${reasoningMenuId}-trigger`"
            ref="reasoningTriggerRef"
            type="button"
            class="runtime-menu-trigger"
            data-testid="reasoning-runtime-trigger"
            aria-haspopup="menu"
            :aria-expanded="reasoningMenuOpen"
            :aria-controls="reasoningMenuId"
            @click="toggleReasoningMenu"
          >
            <span>{{ t('reasoningEffort') }}</span>
            <strong>{{ reasoningSummary }}</strong>
          </button>
          <div v-if="reasoningMenuOpen" :id="reasoningMenuId" class="runtime-menu-panel" role="menu" :aria-labelledby="`${reasoningMenuId}-trigger`">
            <button
              v-for="effort in reasoningControl.options"
              :key="effort"
              type="button"
              role="menuitemradio"
              :aria-checked="activeModelProfile?.reasoning.mode !== 'disabled' && activeReasoningEffort === effort"
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
        <span
          class="runtime-pill"
          data-testid="active-runtime-status"
          :data-runtime-status="activeRuntime?.status ?? 'idle'"
          :data-queue-position="activeRuntime?.queuePosition"
        >{{ runtimeStatus }}</span>
        <span v-if="runtimeError" class="runtime-control-error" data-testid="model-runtime-error" :title="runtimeError">{{ runtimeError }}</span>
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
          :output-modes="runtimeReasoningProfile?.capabilities.reasoning.outputModes"
          :turn-id="standaloneReasoningGroup.turnId"
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
            :output-modes="runtimeReasoningProfile?.capabilities.reasoning.outputModes"
            :turn-id="reasoningPanelByEntryId.get(entry.id)?.turnId"
            :t="t"
          />
          <article
            v-if="entry.kind !== 'reasoning'"
            :data-testid="entry.kind === 'message' ? `${entry.role}-message` : entry.kind === 'metrics' ? 'turn-metrics' : entry.kind === 'tool' && entry.status === 'failed' ? 'turn-error' : undefined"
            :data-item-kind="entry.kind"
            :data-message-role="entry.kind === 'message' ? entry.role : undefined"
            :data-turn-id="entry.kind === 'message' ? entry.turnId : undefined"
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
              <div class="message-header">
                <span class="message-role">{{ entry.role === 'assistant' ? t('assistant') : entry.role === 'user' ? t('user') : entry.role }}</span>
                <button
                  v-if="entry.role === 'assistant'"
                  type="button"
                  class="message-copy-button"
                  data-testid="copy-answer-button"
                  :data-copy-state="messageCopyState[entry.id] ?? 'idle'"
                  @click="copyAssistantMessage(entry.id, entry.text)"
                >
                  {{ messageCopyState[entry.id] === 'copied' ? t('copied') : messageCopyState[entry.id] === 'failed' ? t('copyAnswerFailed') : t('copyAnswer') }}
                </button>
              </div>
              <div
                v-if="entry.role === 'assistant'"
                class="message-content markdown-body"
                data-testid="assistant-message-content"
                @click="handleAssistantContentClick"
                v-html="renderMarkdown(entry.text, { copyCodeLabel: t('copyCode') })"
              ></div>
              <div v-else class="message-content user-message-content" :data-testid="`${entry.role}-message-content`">
                <p>{{ userMessageText(entry.text) }}</p>
                <div v-if="imageAttachments(entry).length > 0" class="message-attachments" :aria-label="t('attachedImages')">
                  <figure
                    v-for="(attachment, index) in imageAttachments(entry)"
                    :key="`${entry.id}-${attachment.name}-${index}`"
                    class="message-attachment"
                  >
                    <img :src="attachment.dataUrl" :alt="attachment.name" loading="lazy" />
                    <figcaption :title="attachment.name">{{ attachment.name }}</figcaption>
                  </figure>
                </div>
              </div>
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
      :supports-vision="supportsVision"
      :t="t"
      @submit="(text, attachments) => emit('submit', text, attachments)"
      @cancel="emit('cancel')"
    />
  </section>
</template>
