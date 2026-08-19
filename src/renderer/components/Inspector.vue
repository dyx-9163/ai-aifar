<script setup lang="ts">
import { computed } from 'vue';
import type { AppSettings, Approval, ModelRunMetrics, PatchDiffLineKind, TurnRecord } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import type { Translator } from '../i18n';

const props = defineProps<{
  pendingApproval?: Approval;
  events: AgentEvent[];
  turns: TurnRecord[];
  settings: AppSettings;
  busy: boolean;
  approvalResponseInFlight: boolean;
  approvalError?: string;
  t: Translator;
}>();

defineEmits<{
  approve: [approvalId: string];
  reject: [approvalId: string];
}>();

const activity = computed(() => props.events.filter((event) => event.type !== 'message.delta').slice(-8).reverse());
const latestMetrics = computed(() => {
  const live = props.events
    .filter((event): event is Extract<AgentEvent, { type: 'model.metrics' }> => event.type === 'model.metrics')
    .at(-1)?.metrics;
  return live ?? props.turns.filter((turn) => turn.metrics).at(-1)?.metrics;
});

function activityText(event: AgentEvent): string {
  if (event.type === 'turn.failed') {
    return `${event.type}: ${event.error}`;
  }
  if (event.type === 'model.progress') {
    return `${event.type}: ${progressText(event.phase)}`;
  }
  return event.type;
}

function progressText(phase: 'connecting' | 'compressing' | 'reasoning' | 'answering'): string {
  if (phase === 'compressing') return props.t('modelCompressingContext');
  if (phase === 'reasoning') return props.t('modelReasoning');
  if (phase === 'answering') return props.t('modelAnswering');
  return props.t('modelConnecting');
}

function metricValue(value: number | undefined, suffix = ''): string {
  return typeof value === 'number' ? `${value.toFixed(suffix ? 1 : 0)}${suffix}` : '-';
}

function speedValue(metrics: ModelRunMetrics): string {
  return typeof metrics.tokensPerSecond === 'number'
    ? `${metrics.tokensPerSecond.toFixed(1)} tok/s · ${metrics.speedSource}`
    : metrics.speedSource;
}

function diffPrefix(kind: PatchDiffLineKind): string {
  if (kind === 'added') return '+ ';
  if (kind === 'removed') return '- ';
  return '  ';
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

    <section v-if="pendingApproval || approvalError" class="approval-panel">
      <template v-if="pendingApproval">
        <p class="pane-label">{{ t('approval') }}</p>
        <h2>{{ pendingApproval.title }}</h2>
        <p>{{ pendingApproval.description }}</p>
        <div v-if="pendingApproval.fileChanges?.length" class="file-change-preview" data-testid="approval-file-change">
          <template v-for="(change, changeIndex) in pendingApproval.fileChanges" :key="changeIndex">
            <p class="file-change-path" data-testid="approval-file-change-path">
              {{ change.relativePath }}
              <small>{{ change.action }}</small>
            </p>
            <pre class="file-change-diff"><code><span
              v-for="(line, index) in change.lines"
              :key="index"
              class="diff-line"
              :class="`diff-line-${line.kind}`"
            >{{ diffPrefix(line.kind) }}{{ line.text }}
</span></code></pre>
          </template>
        </div>
        <div class="approval-actions">
          <button type="button" class="secondary-button" data-testid="approval-reject-button" :disabled="pendingApproval.status !== 'pending' || approvalResponseInFlight" @click="$emit('reject', pendingApproval.id)">{{ t('reject') }}</button>
          <button type="button" class="primary-action compact" data-testid="approval-approve-button" :disabled="pendingApproval.status !== 'pending' || approvalResponseInFlight" @click="$emit('approve', pendingApproval.id)">{{ t('approve') }}</button>
        </div>
      </template>
      <p v-if="approvalError" class="runtime-control-error" data-testid="approval-response-error" role="status">
        {{ approvalError }}
      </p>
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
