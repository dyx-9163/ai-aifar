<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Item, ModelProfile, ModelResponseSpeed, ReasoningEffort, ThreadSummary } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import type { Translator } from '../i18n';
import { renderMarkdown } from '../markdown';
import { isNearBottom } from '../scrolling';
import { createTimelineEntries } from '../timeline';
import Composer from './Composer.vue';

const props = defineProps<{
  thread?: ThreadSummary;
  items: Item[];
  events: AgentEvent[];
  busy: boolean;
  loading: boolean;
  modelProfiles: ModelProfile[];
  activeModelProfileId?: string;
  activeModelProfile?: ModelProfile;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
  selectModel: [modelProfileId?: string];
  updateModelRuntime: [patch: { reasoning?: { mode?: 'enabled' | 'disabled'; effort?: ReasoningEffort }; responseSpeed?: ModelResponseSpeed }];
}>();

const timelineEntries = computed(() => createTimelineEntries(props.items, props.events));
const timelineRef = ref<HTMLElement>();
const isPinnedToBottom = ref(true);
const hasUnreadBelow = ref(false);
const isAutoScrolling = ref(false);
const openRuntimeMenu = ref<'reasoning' | 'speed'>();

const scrollSignature = computed(() =>
  timelineEntries.value.map((entry) => `${entry.id}:${entry.kind === 'message' ? entry.text.length : entry.text.length}`).join('|'),
);

function handleModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectModel', value || undefined);
}

const activeReasoningEffort = computed(() => props.activeModelProfile?.reasoning.effort ?? 'medium');
const activeResponseSpeed = computed(() => props.activeModelProfile?.responseSpeed ?? 'standard');
const reasoningEffortOptions: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const responseSpeedOptions: ModelResponseSpeed[] = ['standard', 'fast', 'quality'];
const reasoningSummary = computed(() => {
  if (!props.activeModelProfile || props.activeModelProfile.reasoning.mode === 'disabled') {
    return props.t('disabled');
  }
  return reasoningEffortLabel(activeReasoningEffort.value);
});
const speedSummary = computed(() => responseSpeedLabel(activeResponseSpeed.value));

function setReasoningEffort(effort: ReasoningEffort): void {
  openRuntimeMenu.value = undefined;
  emit('updateModelRuntime', { reasoning: { mode: 'enabled', effort } });
}

function disableReasoning(): void {
  openRuntimeMenu.value = undefined;
  emit('updateModelRuntime', { reasoning: { mode: 'disabled' } });
}

function setResponseSpeed(responseSpeed: ModelResponseSpeed): void {
  openRuntimeMenu.value = undefined;
  emit('updateModelRuntime', { responseSpeed });
}

function toggleRuntimeMenu(menu: 'reasoning' | 'speed'): void {
  if (!props.activeModelProfile) {
    return;
  }
  openRuntimeMenu.value = openRuntimeMenu.value === menu ? undefined : menu;
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === 'low') {
    return props.t('low');
  }
  if (effort === 'high') {
    return props.t('high');
  }
  if (effort === 'xhigh') {
    return props.t('xhigh');
  }
  return props.t('medium');
}

function responseSpeedLabel(responseSpeed: ModelResponseSpeed): string {
  if (responseSpeed === 'fast') {
    return props.t('fast');
  }
  if (responseSpeed === 'quality') {
    return props.t('quality');
  }
  return props.t('standard');
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
  () => props.busy,
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
        <div class="runtime-menu" data-testid="reasoning-runtime-menu" :class="{ disabled: !activeModelProfile }">
          <button type="button" class="runtime-menu-trigger" data-testid="reasoning-runtime-trigger" @click="toggleRuntimeMenu('reasoning')">
            <span>{{ t('reasoningEffort') }}</span>
            <strong>{{ reasoningSummary }}</strong>
          </button>
          <div v-if="openRuntimeMenu === 'reasoning'" class="runtime-menu-panel">
            <button
              type="button"
              data-testid="reasoning-runtime-disabled"
              :class="{ active: activeModelProfile?.reasoning.mode === 'disabled' }"
              :disabled="!activeModelProfile"
              @click="disableReasoning"
            >
              {{ t('disabled') }}
            </button>
            <button
              v-for="effort in reasoningEffortOptions"
              :key="effort"
              type="button"
              :data-testid="`reasoning-runtime-${effort}`"
              :class="{ active: activeModelProfile?.reasoning.mode !== 'disabled' && activeReasoningEffort === effort }"
              :disabled="!activeModelProfile"
              @click="setReasoningEffort(effort)"
            >
              {{ reasoningEffortLabel(effort) }}
            </button>
          </div>
        </div>
        <div class="runtime-menu" data-testid="speed-runtime-menu" :class="{ disabled: !activeModelProfile }">
          <button type="button" class="runtime-menu-trigger" data-testid="speed-runtime-trigger" @click="toggleRuntimeMenu('speed')">
            <span>{{ t('responseSpeed') }}</span>
            <strong>{{ speedSummary }}</strong>
          </button>
          <div v-if="openRuntimeMenu === 'speed'" class="runtime-menu-panel">
            <button
              v-for="speed in responseSpeedOptions"
              :key="speed"
              type="button"
              :data-testid="`speed-runtime-${speed}`"
              :class="{ active: activeResponseSpeed === speed }"
              :disabled="!activeModelProfile"
              @click="setResponseSpeed(speed)"
            >
              {{ responseSpeedLabel(speed) }}
            </button>
          </div>
        </div>
        <span class="runtime-pill">{{ busy ? t('running') : t('ready') }}</span>
      </div>
    </header>

    <div ref="timelineRef" class="timeline" @scroll="handleTimelineScroll">
      <div class="timeline-stack">
        <div v-if="loading" class="empty-state">{{ t('loadingWorkspace') }}</div>
        <div v-else-if="!thread" class="empty-state">{{ t('createTaskHint') }}</div>

        <article
          v-for="entry in timelineEntries"
          :key="entry.id"
          :class="
            entry.kind === 'message'
              ? ['message-row', `role-${entry.role}`, { live: entry.live }]
              : entry.kind === 'metrics'
                ? 'metrics-row'
                : 'tool-row'
          "
        >
          <template v-if="entry.kind === 'message'">
            <span class="message-role">{{ entry.role === 'assistant' ? t('assistant') : entry.role === 'user' ? t('user') : entry.role }}</span>
            <div v-if="entry.role === 'assistant'" class="message-content markdown-body" v-html="renderMarkdown(entry.text)"></div>
            <p v-else class="message-content">{{ entry.text }}</p>
          </template>
          <span v-else>{{ entry.text }}</span>
        </article>
      </div>
      <button v-if="hasUnreadBelow" type="button" class="jump-to-bottom" @click="jumpToBottom">↓</button>
    </div>

    <Composer :busy="busy" :t="t" @submit="emit('submit', $event)" @cancel="emit('cancel')" />
  </section>
</template>
