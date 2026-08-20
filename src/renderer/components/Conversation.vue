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
  UndoableTurnSummary,
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
import { createTurnTimelineGroups, type TurnTimelineGroup } from '../timeline';
import Composer from './Composer.vue';
import OperationPanel from './OperationPanel.vue';
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
  /** Display name of the workspace the active thread belongs to. */
  threadWorkspaceName?: string;
  latestUndoableTurn?: UndoableTurnSummary;
  runtimeError?: string;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string, attachments?: TurnAttachment[]];
  cancel: [];
  openSettings: [];
  selectModel: [modelProfileId?: string];
  undoTurn: [turnId: string];
  updateModelRuntime: [patch: { reasoning?: { mode?: 'enabled' | 'disabled'; effort?: string } }];
}>();

const timelineGroups = computed(() => createTurnTimelineGroups(props.items, props.events, props.turns, props.t));
const reasoningGroups = computed(() => groupReasoningItems(
  props.items.filter((item): item is ReasoningItem => item.kind === 'reasoning'),
));
const reasoningGroupByTurn = computed(() => new Map(reasoningGroups.value.map((group) => [group.turnId, group])));
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
  timelineGroups.value
    .flatMap((group) => [
      `${group.id}:${group.running}`,
      ...group.userMessages.map((entry) => `${entry.id}:${entry.text.length}`),
      ...group.reasoning.map((entry) => `${entry.id}:${entry.text.length}`),
      ...group.operations.map((entry) => `${entry.id}:${entry.status}:${entry.text.length}`),
      ...group.finalAnswers.map((entry) => `${entry.id}:${entry.text.length}`),
      ...group.metrics.map((entry) => `${entry.id}:${entry.text.length}`),
      ...group.progress.map((entry) => `${entry.id}:${entry.phase}`),
    ])
    .join('|'),
);

function reasoningGroupForTurn(group: TurnTimelineGroup): ReasoningItemGroup | undefined {
  if (!group.turnId) return undefined;
  const existing = reasoningGroupByTurn.value.get(group.turnId);
  if (existing) return existing;
  return shouldShowReasoningPanel(props.reasoningDisplayMode, [], group.running)
    ? { turnId: group.turnId, anchorId: `reasoning-${group.turnId}` }
    : undefined;
}

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
        <button
          v-if="latestUndoableTurn"
          type="button"
          class="undo-turn-button"
          data-testid="undo-turn-button"
          :title="t('undoFileChangesHint')"
          @click="emit('undoTurn', latestUndoableTurn.turnId)"
        >
          {{ t('undoFileChanges') }} ({{ latestUndoableTurn.fileCount }})
        </button>
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

        <template
          v-for="group in timelineGroups"
          :key="group.id"
        >
          <article
            v-for="entry in [...group.userMessages, ...group.otherMessages]"
            :key="entry.id"
            :data-testid="`${entry.role}-message`"
            data-item-kind="message"
            :data-message-role="entry.role"
            :data-turn-id="entry.turnId"
            :class="['message-row', `role-${entry.role}`, { live: entry.live }]"
          >
            <div class="message-header">
              <span class="message-role">{{ entry.role === 'user' ? t('user') : entry.role }}</span>
            </div>
            <div class="message-content user-message-content" :data-testid="`${entry.role}-message-content`">
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
          </article>

          <ReasoningPanel
            v-if="reasoningGroupForTurn(group)"
            :raw="reasoningGroupForTurn(group)?.raw"
            :summary="reasoningGroupForTurn(group)?.summary"
            :preference="reasoningDisplayMode"
            :running="group.running"
            :output-modes="runtimeReasoningProfile?.capabilities.reasoning.outputModes"
            :turn-id="group.turnId"
            :t="t"
          />

          <OperationPanel
            v-if="group.operations.length > 0"
            :operations="group.operations"
            :running="group.running"
            :t="t"
          />

          <article
            v-for="entry in group.finalAnswers"
            :key="entry.id"
            data-testid="assistant-message"
            data-item-kind="message"
            data-message-role="assistant"
            :data-turn-id="entry.turnId"
            :class="['message-row', 'role-assistant', { live: entry.live }]"
          >
            <div class="message-header">
              <span class="message-role">{{ t('assistant') }}</span>
              <button
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
              class="message-content markdown-body"
              data-testid="assistant-message-content"
              @click="handleAssistantContentClick"
              v-html="renderMarkdown(entry.text, { copyCodeLabel: t('copyCode') })"
            ></div>
            <div v-if="entry.truncated" class="truncation-notice" data-testid="answer-truncated-notice">
              {{ t('answerTruncated') }}
            </div>
          </article>

          <article v-for="entry in group.metrics" :key="entry.id" class="metrics-row" data-testid="turn-metrics">
            {{ entry.text }}
          </article>
          <article v-for="entry in group.progress" :key="entry.id" class="progress-row">
            <span class="progress-label">
              <span class="progress-dot" aria-hidden="true"></span>
              {{ progressLabel(entry.phase) }}
            </span>
          </article>
        </template>
      </div>
      <button v-if="hasUnreadBelow" type="button" class="jump-to-bottom" @click="jumpToBottom">↓</button>
    </div>

    <Composer
      :active-busy="activeBusy"
      :active-runtime="activeRuntime"
      :supports-vision="supportsVision"
      :thread-workspace-name="threadWorkspaceName"
      :t="t"
      @submit="(text, attachments) => emit('submit', text, attachments)"
      @cancel="emit('cancel')"
    />
  </section>
</template>
