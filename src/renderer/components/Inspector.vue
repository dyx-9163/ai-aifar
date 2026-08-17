<script setup lang="ts">
import { computed } from 'vue';
import type { AppSettings, Approval, ModelRunMetrics } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import type { Translator } from '../i18n';

const props = defineProps<{
  pendingApproval?: Approval;
  events: AgentEvent[];
  settings: AppSettings;
  busy: boolean;
  t: Translator;
}>();

defineEmits<{
  approve: [];
  reject: [];
}>();

const activity = computed(() => props.events.filter((event) => event.type !== 'message.delta').slice(-8).reverse());
const latestMetrics = computed(() =>
  props.events
    .filter((event): event is Extract<AgentEvent, { type: 'model.metrics' }> => event.type === 'model.metrics')
    .at(-1)?.metrics,
);

function activityText(event: AgentEvent): string {
  if (event.type === 'turn.failed') {
    return `${event.type}: ${event.error}`;
  }
  return event.type;
}

function metricValue(value: number | undefined, suffix = ''): string {
  return typeof value === 'number' ? `${value.toFixed(suffix ? 1 : 0)}${suffix}` : '-';
}

function speedValue(metrics: ModelRunMetrics): string {
  return typeof metrics.tokensPerSecond === 'number'
    ? `${metrics.tokensPerSecond.toFixed(1)} tok/s · ${metrics.speedSource}`
    : metrics.speedSource;
}
</script>

<template>
  <aside class="inspector-pane" aria-label="Task details">
    <section class="inspector-section">
      <div class="section-heading">
        <p class="pane-label">{{ t('plan') }}</p>
        <span class="status-dot" :class="{ running: busy }"></span>
      </div>
      <ol class="plan-list">
        <li>{{ t('understandRequest') }}</li>
        <li>{{ t('streamAgentEvents') }}</li>
        <li>{{ t('requireApproval') }}</li>
      </ol>
    </section>

    <section v-if="settings.showModelMetrics && latestMetrics" class="inspector-section">
      <p class="pane-label">{{ t('runMetrics') }}</p>
      <div class="metric-grid">
        <div class="metric-row">
          <span>{{ t('requestedReasoning') }}</span>
          <strong>{{ latestMetrics.reasoningRequested }}/{{ latestMetrics.reasoningProtocol }}</strong>
        </div>
        <div class="metric-row">
          <span>{{ t('reasoningObserved') }}</span>
          <strong>{{ latestMetrics.reasoningObserved ? t('enabled') : t('disabled') }}</strong>
        </div>
        <div class="metric-row">
          <span>{{ t('duration') }}</span>
          <strong>{{ metricValue(latestMetrics.durationMs / 1000, 's') }}</strong>
        </div>
        <div class="metric-row">
          <span>{{ t('timeToFirstToken') }}</span>
          <strong>{{ latestMetrics.timeToFirstTokenMs ? `${latestMetrics.timeToFirstTokenMs}ms` : '-' }}</strong>
        </div>
        <div class="metric-row">
          <span>{{ t('tokensPerSecond') }}</span>
          <strong>{{ speedValue(latestMetrics) }}</strong>
        </div>
        <div class="metric-row">
          <span>{{ t('completionTokens') }}</span>
          <strong>{{ latestMetrics.completionTokens ?? '-' }} · {{ latestMetrics.usageSource }}</strong>
        </div>
      </div>
    </section>

    <section v-if="pendingApproval" class="approval-panel">
      <p class="pane-label">{{ t('approval') }}</p>
      <h2>{{ pendingApproval.title }}</h2>
      <p>{{ pendingApproval.description }}</p>
      <div class="approval-actions">
        <button type="button" class="secondary-button" :disabled="pendingApproval.status !== 'pending'" @click="$emit('reject')">{{ t('reject') }}</button>
        <button type="button" class="primary-action compact" :disabled="pendingApproval.status !== 'pending'" @click="$emit('approve')">{{ t('approve') }}</button>
      </div>
    </section>

    <section class="inspector-section">
      <p class="pane-label">{{ t('activity') }}</p>
      <div class="activity-list">
        <p v-if="activity.length === 0" class="empty-copy">{{ t('noActivityYet') }}</p>
        <div v-for="event in activity" :key="`${event.type}-${'sequence' in event ? event.sequence : 0}`" class="activity-row">
          <span>{{ activityText(event) }}</span>
          <small v-if="'sequence' in event">#{{ event.sequence }}</small>
        </div>
      </div>
    </section>
  </aside>
</template>
