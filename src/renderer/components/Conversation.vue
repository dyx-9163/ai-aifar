<script setup lang="ts">
import { computed } from 'vue';
import type { Item, ThreadSummary } from '../../shared/domain';
import type { AgentEvent } from '../../shared/protocol';
import Composer from './Composer.vue';

const props = defineProps<{
  thread?: ThreadSummary;
  items: Item[];
  events: AgentEvent[];
  busy: boolean;
  loading: boolean;
}>();

defineEmits<{
  submit: [text: string];
}>();

const messageEvents = computed(() => props.events.filter((event) => event.type === 'message.delta'));
const toolEvents = computed(() => props.events.filter((event) => event.type === 'tool.started' || event.type === 'tool.output'));

function itemRole(item: Item): string {
  return item.kind === 'message' ? item.role : item.kind;
}

function itemBody(item: Item): string {
  if (item.kind === 'message') {
    return item.text;
  }
  if (item.kind === 'change') {
    return item.summary;
  }
  return item.output ?? item.title;
}
</script>

<template>
  <section class="conversation-pane" aria-label="Conversation">
    <header class="conversation-header">
      <div>
        <p class="pane-label">Task</p>
        <h1>{{ thread?.title ?? 'Local agent workspace' }}</h1>
      </div>
      <span class="runtime-pill">{{ busy ? 'Running' : 'Ready' }}</span>
    </header>

    <div class="timeline">
      <div v-if="loading" class="empty-state">Loading local workspace...</div>
      <div v-else-if="!thread" class="empty-state">Create a task or send a prompt to start.</div>

      <article v-for="item in items" :key="item.id" class="message-row" :class="`role-${item.kind === 'message' ? item.role : 'tool'}`">
        <span class="message-role">{{ itemRole(item) }}</span>
        <p>{{ itemBody(item) }}</p>
      </article>

      <article v-for="(event, index) in messageEvents" :key="`${event.type}-${index}-${event.sequence}`" class="message-row role-assistant live">
        <span class="message-role">assistant</span>
        <p>{{ event.text }}</p>
      </article>

      <article v-for="(event, index) in toolEvents" :key="`${event.type}-${index}-${event.sequence}`" class="tool-row">
        <span>{{ event.type === 'tool.started' ? event.title : event.output }}</span>
      </article>
    </div>

    <Composer :busy="busy" @submit="$emit('submit', $event)" />
  </section>
</template>
