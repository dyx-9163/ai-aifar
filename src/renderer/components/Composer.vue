<script setup lang="ts">
import { ref } from 'vue';
import type { Translator } from '../i18n';

const props = defineProps<{
  busy: boolean;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
}>();

const text = ref('');

function submit(): void {
  if (props.busy) {
    emit('cancel');
    return;
  }
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
      data-testid="composer-input"
      rows="3"
      :placeholder="t('askPlaceholder')"
    :disabled="busy"
    @keydown="handleKeydown"
  />
    <button class="send-button" type="submit" data-testid="composer-send" :disabled="!busy && !text.trim()" :title="busy ? t('stop') : t('send')">
      <span aria-hidden="true">{{ busy ? '■' : '>' }}</span>
      <span>{{ busy ? t('stop') : t('send') }}</span>
    </button>
  </form>
</template>
