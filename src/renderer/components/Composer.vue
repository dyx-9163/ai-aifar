<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ThreadRuntimeState } from '../../shared/domain';
import type { Translator } from '../i18n';
import { composerAction } from '../modelControls';

const props = defineProps<{
  activeBusy: boolean;
  activeRuntime?: ThreadRuntimeState;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
}>();

const text = ref('');
const action = computed(() => composerAction(props.activeRuntime));
const actionLabel = computed(() => {
  if (action.value === 'cancel') {
    return props.t('cancel');
  }
  if (action.value === 'stop') {
    return props.t('stop');
  }
  return props.t('send');
});

function submit(): void {
  if (props.activeBusy) {
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
      :disabled="activeBusy"
      @keydown="handleKeydown"
    />
    <button
      class="send-button"
      type="submit"
      data-testid="composer-send"
      :data-action="action"
      :disabled="!activeBusy && !text.trim()"
      :title="actionLabel"
    >
      <span aria-hidden="true">{{ activeBusy ? '■' : '>' }}</span>
      <span>{{ actionLabel }}</span>
    </button>
  </form>
</template>
