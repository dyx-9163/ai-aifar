<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ThreadRuntimeState, TurnAttachment } from '../../shared/domain';
import type { Translator } from '../i18n';
import { composerAction } from '../modelControls';

const props = defineProps<{
  activeBusy: boolean;
  activeRuntime?: ThreadRuntimeState;
  supportsVision: boolean;
  t: Translator;
}>();

const emit = defineEmits<{
  submit: [text: string, attachments?: TurnAttachment[]];
  cancel: [];
}>();

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 4;

const text = ref('');
const attachments = ref<TurnAttachment[]>([]);
const attachmentError = ref('');
const clearWhenAccepted = ref(false);
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
const canSubmit = computed(() => props.activeBusy || Boolean(text.value.trim()) || attachments.value.length > 0);

function submit(): void {
  if (props.activeBusy) {
    emit('cancel');
    return;
  }
  const value = text.value.trim() || (attachments.value.length > 0 ? props.t('describeAttachedImages') : '');
  if (!value && attachments.value.length === 0) {
    return;
  }
  emit('submit', value, snapshotAttachments());
  clearWhenAccepted.value = true;
}

watch(() => props.activeBusy, (busy) => {
  if (!busy || !clearWhenAccepted.value) {
    return;
  }
  text.value = '';
  attachments.value = [];
  attachmentError.value = '';
  clearWhenAccepted.value = false;
});

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}

async function handleAttachmentChange(event: Event): Promise<void> {
  attachmentError.value = '';
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!props.supportsVision) {
    attachmentError.value = props.t('modelNoVision');
    return;
  }
  const remaining = MAX_IMAGE_ATTACHMENTS - attachments.value.length;
  const selected = files.slice(0, Math.max(0, remaining));
  if (selected.length < files.length) {
    attachmentError.value = props.t('tooManyImages').replace('{count}', String(MAX_IMAGE_ATTACHMENTS));
  }
  const next = [...attachments.value];
  for (const file of selected) {
    if (!file.type.startsWith('image/')) {
      attachmentError.value = props.t('imageFilesOnly');
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      attachmentError.value = props.t('imageTooLarge');
      continue;
    }
    next.push({
      kind: 'image',
      name: file.name,
      mimeType: file.type,
      dataUrl: await readFileAsDataUrl(file),
      size: file.size,
    });
  }
  attachments.value = next;
}

function removeAttachment(index: number): void {
  attachments.value = attachments.value.filter((_, candidate) => candidate !== index);
}

function snapshotAttachments(): TurnAttachment[] {
  return attachments.value.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    dataUrl: attachment.dataUrl,
    size: attachment.size,
  }));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read image file.'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image file.'));
    reader.readAsDataURL(file);
  });
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <div class="composer-input-shell">
      <div v-if="attachments.length > 0" class="attachment-list" :aria-label="t('attachedImages')">
        <span v-for="(attachment, index) in attachments" :key="`${attachment.name}-${index}`" class="attachment-chip">
          {{ attachment.name }}
          <button type="button" :aria-label="t('removeAttachment')" :disabled="activeBusy" @click="removeAttachment(index)">×</button>
        </span>
      </div>
      <textarea
        v-model="text"
        class="composer-input"
        data-testid="composer-input"
        rows="3"
        :placeholder="t('askPlaceholder')"
        :disabled="activeBusy"
        @keydown="handleKeydown"
      />
      <p v-if="attachmentError" class="attachment-error" role="status">{{ attachmentError }}</p>
    </div>
    <label
      class="attach-button"
      :class="{ disabled: activeBusy || !supportsVision }"
      :title="supportsVision ? t('attachImages') : t('modelNoVision')"
    >
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        :disabled="activeBusy || !supportsVision"
        @change="handleAttachmentChange"
      />
      <span>＋</span>
      <span>{{ t('image') }}</span>
    </label>
    <button
      class="send-button"
      type="submit"
      data-testid="composer-send"
      :data-action="action"
      :disabled="!canSubmit"
      :title="actionLabel"
    >
      <span aria-hidden="true">{{ activeBusy ? '■' : '>' }}</span>
      <span>{{ actionLabel }}</span>
    </button>
  </form>
</template>
