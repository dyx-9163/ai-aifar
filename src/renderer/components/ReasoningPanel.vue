<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { ReasoningDisplayMode, ReasoningItem } from '../../shared/domain';
import type { Translator } from '../i18n';
import { copyTextWithFeedback, selectReasoningContent } from '../modelControls';

const props = defineProps<{
  raw?: ReasoningItem;
  summary?: ReasoningItem;
  preference: ReasoningDisplayMode;
  running: boolean;
  turnId?: string;
  t: Translator;
}>();

const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
let resetCopyStateTimer: number | undefined;
const selection = computed(() => selectReasoningContent(
  props.preference,
  [props.raw, props.summary].filter((item): item is ReasoningItem => Boolean(item)),
));
const title = computed(() => {
  if (selection.value.mode === 'summary') {
    return props.t('reasoningSummary');
  }
  if (selection.value.mode === 'raw') {
    return props.t('rawReasoning');
  }
  return props.t('reasoning');
});
const unavailableCopy = computed(() =>
  selection.value.mode === 'summary'
    ? props.t('reasoningSummaryUnavailable')
    : props.t('rawReasoningUnavailable'),
);

async function copySelectedReasoning(): Promise<void> {
  if (selection.value.availability !== 'available') {
    return;
  }
  copyState.value = await copyTextWithFeedback(
    (text) => navigator.clipboard.writeText(text),
    selection.value.text,
  );
  if (resetCopyStateTimer !== undefined) {
    window.clearTimeout(resetCopyStateTimer);
  }
  resetCopyStateTimer = window.setTimeout(() => {
    copyState.value = 'idle';
    resetCopyStateTimer = undefined;
  }, 1_500);
}

onUnmounted(() => {
  if (resetCopyStateTimer !== undefined) {
    window.clearTimeout(resetCopyStateTimer);
  }
});
</script>

<template>
  <details
    class="reasoning-panel"
    data-testid="reasoning-panel"
    data-item-kind="reasoning"
    :data-reasoning-mode="selection.mode"
    :data-turn-id="turnId"
  >
    <summary class="reasoning-panel-summary">
      <span v-if="running" class="progress-dot" aria-hidden="true"></span>
      <span>{{ title }}</span>
      <span class="reasoning-panel-hint">{{ t('clickToExpand') }}</span>
    </summary>
    <div class="reasoning-panel-body">
      <pre
        v-if="selection.availability === 'available'"
        class="reasoning-content"
        data-testid="reasoning-content"
      >{{ selection.text }}</pre>
      <p
        v-else-if="selection.availability === 'unsupported'"
        class="reasoning-unavailable"
        data-testid="reasoning-unavailable"
        :data-reasoning-mode="selection.mode"
      >
        {{ unavailableCopy }}
      </p>
      <p v-else class="reasoning-unavailable">
        {{ running ? t('modelReasoning') : t('noReasoningContent') }}
      </p>
      <button
        v-if="selection.availability === 'available'"
        type="button"
        class="reasoning-copy"
        data-testid="reasoning-copy"
        :data-copy-state="copyState"
        @click="copySelectedReasoning"
      >
        {{ copyState === 'copied' ? t('copied') : t('copyReasoning') }}
      </button>
      <p
        v-if="copyState === 'failed'"
        class="reasoning-unavailable"
        data-testid="reasoning-copy-error"
        role="status"
      >
        {{ t('copyReasoningFailed') }}
      </p>
    </div>
  </details>
</template>
