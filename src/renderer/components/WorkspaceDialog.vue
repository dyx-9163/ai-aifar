<script setup lang="ts">
import { ref } from 'vue';
import type { WorkspaceRecord, WorkspaceTrustLevel } from '../../shared/domain';
import type { Translator } from '../i18n';

const props = defineProps<{
  open: boolean;
  t: Translator;
  registerWorkspace: (path: string, trustLevel: WorkspaceTrustLevel) => Promise<WorkspaceRecord>;
}>();

const emit = defineEmits<{
  close: [];
  registered: [workspace: WorkspaceRecord];
}>();

const workspacePath = ref('');
const workspaceTrust = ref<WorkspaceTrustLevel>('read-only');
const workspaceStatus = ref('');
const addingWorkspace = ref(false);

async function addWorkspace(): Promise<void> {
  const path = workspacePath.value.trim();
  if (!path || addingWorkspace.value) {
    return;
  }
  addingWorkspace.value = true;
  workspaceStatus.value = '';
  try {
    const workspace = await props.registerWorkspace(path, workspaceTrust.value);
    workspacePath.value = '';
    workspaceStatus.value = props.t('workspaceRegistered');
    emit('registered', workspace);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    workspaceStatus.value = detail
      ? `${props.t('workspaceRegisterFailed')} ${detail}`
      : props.t('workspaceRegisterFailed');
  } finally {
    addingWorkspace.value = false;
  }
}

function close(): void {
  workspaceStatus.value = '';
  emit('close');
}
</script>

<template>
  <div v-if="open" class="dialog-backdrop" data-testid="workspace-dialog" @click.self="close">
    <section class="dialog-card" role="dialog" :aria-label="t('addWorkspace')">
      <header class="dialog-header">
        <h2>{{ t('addWorkspace') }}</h2>
        <button type="button" class="dialog-close" :title="t('cancel')" @click="close">×</button>
      </header>
      <label class="field-stack">
        <span>{{ t('workspacePathLabel') }}</span>
        <input
          v-model="workspacePath"
          class="text-input"
          data-testid="workspace-path-input"
          placeholder="D:\projects\demo"
          spellcheck="false"
        />
      </label>
      <label class="field-stack">
        <span>{{ t('workspaceTrustLabel') }}</span>
        <select v-model="workspaceTrust" class="model-select wide" data-testid="workspace-trust-select">
          <option value="read-only">{{ t('workspaceReadOnly') }}</option>
          <option value="read-write">{{ t('workspaceReadWrite') }}</option>
        </select>
      </label>
      <p v-if="workspaceStatus" class="settings-note" data-testid="workspace-status" role="status">{{ workspaceStatus }}</p>
      <div class="approval-actions">
        <button
          type="button"
          class="primary-action compact"
          data-testid="workspace-add-button"
          :disabled="addingWorkspace || workspacePath.trim().length === 0"
          :aria-busy="addingWorkspace"
          @click="addWorkspace"
        >
          {{ t('addWorkspace') }}
        </button>
      </div>
    </section>
  </div>
</template>
