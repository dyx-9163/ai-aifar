<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Item, ModelProfile, ThreadSummary } from '../../shared/domain';
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
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
  selectModel: [modelProfileId?: string];
}>();

const timelineEntries = computed(() => createTimelineEntries(props.items, props.events));
const timelineRef = ref<HTMLElement>();
const isPinnedToBottom = ref(true);
const hasUnreadBelow = ref(false);
const isAutoScrolling = ref(false);

const scrollSignature = computed(() =>
  timelineEntries.value.map((entry) => `${entry.id}:${entry.kind === 'message' ? entry.text.length : entry.text.length}`).join('|'),
);

function handleModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectModel', value || undefined);
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
