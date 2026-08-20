<script setup lang="ts">
import { computed } from 'vue';
import type { Translator } from '../i18n';
import { operationPanelState, type OperationTimelineEntry } from '../timeline';

const props = defineProps<{
  operations: OperationTimelineEntry[];
  running: boolean;
  t: Translator;
}>();

const panel = computed(() => operationPanelState(props.operations.length, props.running, props.t));
</script>

<template>
  <details
    class="operation-panel"
    data-testid="operation-panel"
    data-item-kind="operations"
    :open="panel.open"
  >
    <summary class="operation-panel-summary">
      <span v-if="running" class="progress-dot" aria-hidden="true"></span>
      <span>{{ panel.summary }}</span>
    </summary>
    <ol class="operation-list">
      <li
        v-for="operation in operations"
        :key="operation.id"
        class="operation-row"
        :data-operation-status="operation.status"
      >
        <div class="operation-heading">
          <strong>{{ operation.title ?? t('activity') }}</strong>
          <span>{{ t(operation.status) }}</span>
        </div>
        <pre v-if="operation.text" class="operation-output">{{ operation.text }}</pre>
      </li>
    </ol>
  </details>
</template>
