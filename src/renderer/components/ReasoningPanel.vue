<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReasoningDisplayMode, ReasoningItem } from '../../shared/domain';
import type { Translator } from '../i18n';
import { selectReasoningContent } from '../modelControls';

const props = defineProps<{
  raw?: ReasoningItem;
  summary?: ReasoningItem;
  preference: ReasoningDisplayMode;
  running: boolean;
  t: Translator;
}>();

const copied = ref(false);
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
  await navigator.clipboard.writeText(selection.value.text);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1_500);
}
</script>

<template>
  <details class="reasoning-panel" data-testid="reasoning-panel">
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
      <p v-else-if="selection.availability === 'unsupported'" class="reasoning-unavailable">
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
        @click="copySelectedReasoning"
      >
        {{ copied ? t('copied') : t('copyReasoning') }}
      </button>
    </div>
  </details>
</template>
