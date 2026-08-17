<script setup lang="ts">
import { computed } from 'vue';
import type { Approval } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';

const props = defineProps<{
  pendingApproval?: Approval;
  events: AgentEvent[];
  busy: boolean;
}>();

defineEmits<{
  approve: [];
  reject: [];
}>();

const activity = computed(() => props.events.filter((event) => event.type !== 'message.delta').slice(-8).reverse());
</script>

<template>
  <aside class="inspector-pane" aria-label="Task details">
    <section class="inspector-section">
      <div class="section-heading">
        <p class="pane-label">Plan</p>
        <span class="status-dot" :class="{ running: busy }"></span>
      </div>
      <ol class="plan-list">
        <li>Understand the request</li>
        <li>Stream deterministic agent events</li>
        <li>Require approval for write-like prompts</li>
      </ol>
    </section>

    <section v-if="pendingApproval" class="approval-panel">
      <p class="pane-label">Approval</p>
      <h2>{{ pendingApproval.title }}</h2>
      <p>{{ pendingApproval.description }}</p>
      <div class="approval-actions">
        <button type="button" class="secondary-button" :disabled="pendingApproval.status !== 'pending'" @click="$emit('reject')">Reject</button>
        <button type="button" class="primary-action compact" :disabled="pendingApproval.status !== 'pending'" @click="$emit('approve')">Approve</button>
      </div>
    </section>

    <section class="inspector-section">
      <p class="pane-label">Activity</p>
      <div class="activity-list">
        <p v-if="activity.length === 0" class="empty-copy">No activity yet</p>
        <div v-for="event in activity" :key="`${event.type}-${'sequence' in event ? event.sequence : 0}`" class="activity-row">
          <span>{{ event.type }}</span>
          <small v-if="'sequence' in event">#{{ event.sequence }}</small>
        </div>
      </div>
    </section>
  </aside>
</template>
