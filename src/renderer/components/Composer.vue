<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  busy: boolean;
}>();

const emit = defineEmits<{
  submit: [text: string];
}>();

const text = ref('');

function submit(): void {
  const value = text.value.trim();
  if (!value) {
    return;
  }
  emit('submit', value);
  text.value = '';
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <textarea
      v-model="text"
      class="composer-input"
      rows="3"
      placeholder="Ask the local agent..."
      :disabled="busy"
      @keydown="handleKeydown"
    />
    <button class="send-button" type="submit" :disabled="busy || !text.trim()" title="Send prompt">
      <span aria-hidden="true">></span>
      <span>Send</span>
    </button>
  </form>
</template>
