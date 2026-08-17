<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  AppSettings,
  LanguagePreference,
  ModelProfile,
  ModelProfileInput,
  ModelResponseSpeed,
  ReasoningEffort,
  ReasoningMode,
  ReasoningProtocol,
  RuntimeSettingsInput,
} from '../../shared/domain';
import type { Translator } from '../i18n';

const props = defineProps<{
  modelProfiles: ModelProfile[];
  activeModelProfileId?: string;
  language: LanguagePreference;
  settings: AppSettings;
  t: Translator;
}>();

const emit = defineEmits<{
  back: [];
  saveModelProfile: [profile: ModelProfileInput];
  deleteModelProfile: [id: string];
  testModelProfile: [profile: ModelProfileInput, report: (message: string) => void];
  selectModelProfile: [id?: string];
  setLanguage: [language: LanguagePreference];
  updateSettings: [settings: RuntimeSettingsInput];
}>();

const modelStatus = ref(props.t('apiKeyNotice'));
const activeSection = ref<'general' | 'models' | 'advanced'>('models');
const form = reactive({
  id: '',
  name: 'Private model endpoint',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'your-model-name',
  apiKey: 'local-not-used',
  isDefault: true,
  reasoningMode: 'disabled' as ReasoningMode,
  reasoningProtocol: 'none' as ReasoningProtocol,
  reasoningEffort: 'medium' as ReasoningEffort,
  responseSpeed: 'standard' as ModelResponseSpeed,
});

const activeReasoningLabel = computed(() => {
  const profile = props.modelProfiles.find((candidate) => candidate.id === props.activeModelProfileId);
  if (!profile) {
    return props.t('disabled');
  }
  return `${reasoningModeLabel(profile.reasoning.mode)} / ${reasoningProtocolLabel(profile.reasoning.protocol)}`;
});

watch(
  () => props.activeModelProfileId,
  (id) => {
    const profile = props.modelProfiles.find((candidate) => candidate.id === id);
    if (profile) {
      loadProfile(profile);
    }
  },
  { immediate: true },
);

function loadProfile(profile: ModelProfile): void {
  form.id = profile.id;
  form.name = profile.name;
  form.baseUrl = profile.baseUrl;
  form.model = profile.model;
  form.apiKey = '';
  form.isDefault = profile.isDefault;
  form.reasoningMode = profile.reasoning.mode;
  form.reasoningProtocol = profile.reasoning.protocol;
  form.reasoningEffort = profile.reasoning.effort;
  form.responseSpeed = profile.responseSpeed;
  modelStatus.value = profile.apiKeyConfigured ? props.t('savedProfileLoadedKeepKey') : props.t('savedProfileLoaded');
}

function resetForm(): void {
  form.id = '';
  form.name = 'Private model endpoint';
  form.baseUrl = 'http://127.0.0.1:8080/v1';
  form.model = 'your-model-name';
  form.apiKey = 'local-not-used';
  form.isDefault = props.modelProfiles.length === 0;
  form.reasoningMode = 'disabled';
  form.reasoningProtocol = 'none';
  form.reasoningEffort = 'medium';
  form.responseSpeed = 'standard';
  modelStatus.value = props.t('readyToAddModel');
}

function inputFromForm(): ModelProfileInput {
  return {
    id: form.id || undefined,
    name: form.name,
    provider: 'openai-compatible',
    baseUrl: form.baseUrl,
    model: form.model,
    apiKey: form.apiKey || undefined,
    isDefault: form.isDefault,
    capabilities: {
      text: true,
      vision: false,
      longContext: false,
      reasoning: form.reasoningProtocol !== 'none',
      streamingUsage: true,
    },
    reasoning: {
      mode: form.reasoningMode,
      protocol: form.reasoningProtocol,
      effort: form.reasoningEffort,
    },
    responseSpeed: form.responseSpeed,
  };
}

function saveProfile(): void {
  emit('saveModelProfile', inputFromForm());
  modelStatus.value = props.t('savedModelProfile');
}

function testProfile(): void {
  modelStatus.value = props.t('testingModelEndpoint');
  emit('testModelProfile', inputFromForm(), (message) => {
    modelStatus.value = message;
  });
}

function deleteProfile(): void {
  if (!form.id) {
    return;
  }
  emit('deleteModelProfile', form.id);
  resetForm();
}

function handleLanguageChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'zh-CN' || value === 'en-US') {
    emit('setLanguage', value);
  }
}

function handleContextLimitChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  if (Number.isInteger(value)) {
    emit('updateSettings', { contextMessageLimit: value });
  }
}

function handleMetricsChange(event: Event): void {
  emit('updateSettings', { showModelMetrics: (event.target as HTMLInputElement).checked });
}

function reasoningModeLabel(mode: ReasoningMode): string {
  if (mode === 'enabled') {
    return props.t('enabled');
  }
  if (mode === 'auto') {
    return props.t('auto');
  }
  return props.t('disabled');
}

function reasoningProtocolLabel(protocol: ReasoningProtocol): string {
  if (protocol === 'qwen') {
    return 'Qwen';
  }
  if (protocol === 'openai') {
    return 'OpenAI';
  }
  if (protocol === 'custom') {
    return props.t('customDisabled');
  }
  return props.t('none');
}
</script>

<template>
  <section class="settings-view" aria-label="Settings">
    <header class="settings-header">
      <div>
        <p class="pane-label">{{ t('settings') }}</p>
        <h1>{{ t('settings') }}</h1>
        <p>{{ t('settingsIntro') }}</p>
      </div>
      <button type="button" class="secondary-button compact" @click="$emit('back')">{{ t('backToChat') }}</button>
    </header>

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <button type="button" :class="{ active: activeSection === 'general' }" @click="activeSection = 'general'">
          <span>{{ t('general') }}</span>
          <small>{{ t('generalHint') }}</small>
        </button>
        <button type="button" :class="{ active: activeSection === 'models' }" @click="activeSection = 'models'">
          <span>{{ t('modelProviders') }}</span>
          <small>{{ t('modelProvidersHint') }}</small>
        </button>
        <button type="button" :class="{ active: activeSection === 'advanced' }" @click="activeSection = 'advanced'">
          <span>{{ t('advanced') }}</span>
          <small>{{ t('advancedHint') }}</small>
        </button>
      </nav>

      <section v-if="activeSection === 'general'" class="settings-card">
        <p class="pane-label">{{ t('general') }}</p>
        <h2>{{ t('appearance') }}</h2>
        <label class="field-stack">
          <span>{{ t('selectLanguage') }}</span>
          <select :value="language" class="model-select wide" data-testid="language-select" @change="handleLanguageChange">
            <option value="zh-CN">{{ t('chinese') }}</option>
            <option value="en-US">{{ t('english') }}</option>
          </select>
        </label>
      </section>

      <section v-else-if="activeSection === 'models'" class="settings-card model-provider-card">
        <div class="section-heading">
          <div>
            <p class="pane-label">{{ t('settings') }}</p>
            <h2>{{ t('modelProviders') }}</h2>
          </div>
          <button type="button" class="secondary-button compact-button" @click="resetForm">{{ t('addProvider') }}</button>
        </div>

        <label class="field-stack">
          <span>{{ t('currentChatModel') }}</span>
          <select :value="activeModelProfileId ?? ''" class="model-select wide" @change="emit('selectModelProfile', (($event.target as HTMLSelectElement).value || undefined))">
            <option value="">{{ t('demoMode') }}</option>
            <option v-for="profile in modelProfiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </option>
          </select>
        </label>

        <div class="model-settings-layout">
          <aside class="profile-list-panel">
            <p v-if="modelProfiles.length === 0" class="settings-note">{{ t('noModelProfiles') }}</p>
            <button
              v-for="profile in modelProfiles"
              :key="profile.id"
              type="button"
              class="profile-row"
              :class="{ active: profile.id === form.id }"
              @click="loadProfile(profile)"
            >
              <span>{{ profile.name }}</span>
              <small>{{ profile.apiKeyConfigured ? t('keySaved') : t('noKey') }}</small>
            </button>
          </aside>

          <div class="settings-form two-column">
            <label class="field-stack">
              <span>{{ t('name') }}</span>
              <input v-model="form.name" class="text-input" placeholder="Private model endpoint" />
            </label>
            <label class="field-stack">
              <span>{{ t('baseUrl') }}</span>
              <input v-model="form.baseUrl" class="text-input" placeholder="http://127.0.0.1:8080/v1" />
            </label>
            <label class="field-stack">
              <span>{{ t('model') }}</span>
              <input v-model="form.model" class="text-input" placeholder="Qwen3.5-9B / DeepSeek-R1 / Llama-3.1" />
            </label>
            <label class="field-stack">
              <span>{{ t('apiKey') }}</span>
              <input v-model="form.apiKey" class="text-input" type="password" placeholder="local-not-used" />
            </label>
            <label class="check-row">
              <input v-model="form.isDefault" type="checkbox" />
              <span>{{ t('defaultModel') }}</span>
            </label>
            <div class="settings-subsection">
              <h3>{{ t('reasoning') }}</h3>
              <label class="field-stack">
                <span>{{ t('reasoningMode') }}</span>
                <select v-model="form.reasoningMode" data-testid="reasoning-mode-select" class="model-select wide">
                  <option value="disabled">{{ t('disabled') }}</option>
                  <option value="auto">{{ t('auto') }}</option>
                  <option value="enabled">{{ t('enabled') }}</option>
                </select>
              </label>
              <label class="field-stack">
                <span>{{ t('reasoningProtocol') }}</span>
                <select v-model="form.reasoningProtocol" data-testid="reasoning-protocol-select" class="model-select wide">
                  <option value="none">{{ t('none') }}</option>
                  <option value="qwen">Qwen</option>
                  <option value="openai">OpenAI</option>
                  <option value="custom" disabled>{{ t('customDisabled') }}</option>
                </select>
              </label>
              <label class="field-stack">
                <span>{{ t('reasoningEffort') }}</span>
                <select v-model="form.reasoningEffort" class="model-select wide">
                  <option value="low">{{ t('low') }}</option>
                  <option value="medium">{{ t('medium') }}</option>
                  <option value="high">{{ t('high') }}</option>
                  <option value="xhigh">{{ t('xhigh') }}</option>
                </select>
              </label>
              <label class="field-stack">
                <span>{{ t('responseSpeed') }}</span>
                <select v-model="form.responseSpeed" class="model-select wide">
                  <option value="standard">{{ t('standard') }}</option>
                  <option value="fast">{{ t('fast') }}</option>
                  <option value="quality">{{ t('quality') }}</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <p class="settings-note">{{ modelStatus }}</p>

        <div class="approval-actions">
          <button type="button" class="secondary-button compact" :disabled="!form.id" @click="deleteProfile">{{ t('delete') }}</button>
          <button type="button" class="secondary-button compact" @click="testProfile">{{ t('test') }}</button>
          <button type="button" class="primary-action compact" @click="saveProfile">{{ t('save') }}</button>
        </div>
      </section>

      <section v-else class="settings-card">
        <p class="pane-label">{{ t('advanced') }}</p>
        <h2>{{ t('runtimeBehavior') }}</h2>
        <label class="toggle-row">
          <span>{{ t('metricsDisplay') }}</span>
          <input data-testid="metrics-toggle" type="checkbox" :checked="settings.showModelMetrics" @change="handleMetricsChange" />
        </label>
        <label class="field-stack">
          <span>{{ t('contextMessageLimit') }}</span>
          <select
            data-testid="context-limit-select"
            class="model-select wide"
            :value="String(settings.contextMessageLimit)"
            @change="handleContextLimitChange"
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </label>
        <div class="settings-summary-list">
          <p><span>{{ t('activeReasoning') }}</span><strong>{{ activeReasoningLabel }}</strong></p>
          <p><span>{{ t('contextPolicy') }}</span><strong>{{ t('sameChatOnly') }}</strong></p>
        </div>
      </section>
    </div>
  </section>
</template>
