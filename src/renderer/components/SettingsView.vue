<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  AppSettings,
  LanguagePreference,
  ModelConnectionResult,
  ModelProfile,
  ModelProfileInput,
  ReasoningDisplayMode,
  ReasoningInputMode,
  ReasoningMode,
  ReasoningProtocol,
  RuntimeSettingsInput,
} from '../../shared/domain';
import { isLocalQwenServiceProfile } from '../../shared/localQwenIdentity';
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../../shared/modelProfileLimits';
import type { Translator } from '../i18n';
import {
  buildModelProfileInput,
  captureFormOperation,
  connectionTestStateForFingerprint,
  effortValidationIssue,
  formOperationCanApply,
  maxOutputTokensIsValid,
  modelConnectionDiagnostic,
  modelProfileFormFingerprint,
  reconcileEffortSelection,
  reasoningConfigurationValidationIssue,
  runModelProfileSave,
  type ConnectionTestState,
  type ModelProfileFormValues,
} from '../modelProfileForm';

const props = defineProps<{
  modelProfiles: ModelProfile[];
  activeModelProfileId?: string;
  language: LanguagePreference;
  settings: AppSettings;
  t: Translator;
  saveModelProfile: (profile: ModelProfileInput) => Promise<ModelProfile>;
  testModelProfile: (profile: ModelProfileInput) => Promise<ModelConnectionResult>;
}>();

const emit = defineEmits<{
  back: [];
  deleteModelProfile: [id: string];
  selectModelProfile: [id?: string];
  setLanguage: [language: LanguagePreference];
  updateSettings: [settings: RuntimeSettingsInput];
}>();

const modelStatus = ref(props.t('apiKeyNotice'));
const activeSection = ref<'general' | 'models' | 'runtime'>('models');
const connectionTestState = ref<ConnectionTestState>('untested');
const connectionResult = ref<ModelConnectionResult>();
const connectionGuidanceForLocalQwen = ref(false);
const testedFingerprint = ref<string>();
const saving = ref(false);
const testingConnection = ref(false);
const formRevision = ref(0);
const activeSaveOperationToken = ref(0);
const activeConnectionOperationToken = ref(0);
let nextSaveOperationToken = 0;
let nextConnectionOperationToken = 0;
const form = reactive({
  id: '',
  name: 'Private model endpoint',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'your-model-name',
  apiKey: 'local-not-used',
  isDefault: true,
  reasoningMode: 'disabled' as ReasoningMode,
  reasoningProtocol: 'none' as ReasoningProtocol,
  reasoningEffort: '',
  profileReasoningDisplay: 'auto' as ReasoningDisplayMode,
  reasoningInputMode: 'unsupported' as ReasoningInputMode,
  effortOptionsText: '',
  defaultEffort: '',
  rawOutput: false,
  summaryOutput: false,
  maxConcurrency: 1,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
});

const effortOptions = computed(() => [...new Set(
  form.effortOptionsText
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean),
)]);
const editingProfile = computed(() => props.modelProfiles.find((profile) => profile.id === form.id));
const maxConcurrencyLimit = computed(() => editingProfile.value?.capabilities.concurrency.maxLimit ?? 32);
const connectionDiagnostic = computed(() => {
  const result = connectionResult.value;
  if (!result) return '';
  return modelConnectionDiagnostic(result, props.t, connectionGuidanceForLocalQwen.value);
});
const capabilityError = computed(() => {
  if (!maxOutputTokensIsValid(form.maxOutputTokens)) {
    return props.t('maxOutputTokensError').replace('{max}', String(MAX_OUTPUT_TOKENS));
  }
  if (!Number.isInteger(form.maxConcurrency) || form.maxConcurrency < 1 || form.maxConcurrency > maxConcurrencyLimit.value) {
    return props.t('maxConcurrencyError').replace('{max}', String(maxConcurrencyLimit.value));
  }
  const configurationIssue = reasoningConfigurationValidationIssue({
    reasoningMode: form.reasoningMode,
    inputMode: form.reasoningInputMode,
    protocol: form.reasoningProtocol,
  });
  if (configurationIssue) {
    return props.t(configurationIssue);
  }
  const issue = effortValidationIssue({
    reasoningMode: form.reasoningMode,
    inputMode: form.reasoningInputMode,
    options: effortOptions.value,
    currentEffort: form.reasoningEffort,
    defaultEffort: form.defaultEffort,
  });
  return issue ? props.t(issue) : '';
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

watch(
  () => [form.reasoningMode, form.reasoningInputMode, form.effortOptionsText] as const,
  synchronizeEffortSelection,
  { flush: 'sync' },
);

watch(
  () => modelProfileFormFingerprint(inputFromForm()),
  (fingerprint) => {
    formRevision.value += 1;
    connectionTestState.value = connectionTestStateForFingerprint(
      connectionTestState.value,
      testedFingerprint.value,
      fingerprint,
    );
    if (connectionTestState.value === 'untested') {
      connectionResult.value = undefined;
      connectionGuidanceForLocalQwen.value = false;
    }
  },
  { flush: 'sync' },
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
  form.reasoningEffort = profile.reasoning.effort ?? '';
  form.profileReasoningDisplay = profile.reasoning.display;
  form.reasoningInputMode = profile.capabilities.reasoning.inputMode;
  form.effortOptionsText = profile.capabilities.reasoning.effortOptions.join(', ');
  form.defaultEffort = profile.capabilities.reasoning.defaultEffort ?? '';
  form.rawOutput = profile.capabilities.reasoning.outputModes.includes('raw');
  form.summaryOutput = profile.capabilities.reasoning.outputModes.includes('summary');
  form.maxConcurrency = profile.maxConcurrency;
  form.maxOutputTokens = profile.maxOutputTokens;
  synchronizeEffortSelection();
  testedFingerprint.value = undefined;
  connectionTestState.value = 'untested';
  connectionResult.value = undefined;
  connectionGuidanceForLocalQwen.value = false;
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
  form.reasoningEffort = '';
  form.profileReasoningDisplay = 'auto';
  form.reasoningInputMode = 'unsupported';
  form.effortOptionsText = '';
  form.defaultEffort = '';
  form.rawOutput = false;
  form.summaryOutput = false;
  form.maxConcurrency = 1;
  form.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  synchronizeEffortSelection();
  testedFingerprint.value = undefined;
  connectionTestState.value = 'untested';
  connectionResult.value = undefined;
  connectionGuidanceForLocalQwen.value = false;
  modelStatus.value = props.t('readyToAddModel');
}

function inputFromForm(): ModelProfileInput {
  const values: ModelProfileFormValues = {
    id: form.id || undefined,
    name: form.name,
    baseUrl: form.baseUrl,
    model: form.model,
    apiKey: form.apiKey,
    isDefault: form.isDefault,
    reasoningMode: form.reasoningMode,
    reasoningProtocol: form.reasoningProtocol,
    reasoningEffort: form.reasoningEffort,
    profileReasoningDisplay: form.profileReasoningDisplay,
    reasoningInputMode: form.reasoningInputMode,
    effortOptions: effortOptions.value,
    defaultEffort: form.defaultEffort,
    rawOutput: form.rawOutput,
    summaryOutput: form.summaryOutput,
    maxConcurrency: form.maxConcurrency,
    maxOutputTokens: form.maxOutputTokens,
  };
  return buildModelProfileInput(values, editingProfile.value);
}

async function saveProfile(): Promise<void> {
  if (capabilityError.value) {
    modelStatus.value = capabilityError.value;
    return;
  }
  const input = inputFromForm();
  const submitted = captureFormOperation(++nextSaveOperationToken, input, formRevision.value);
  activeSaveOperationToken.value = submitted.token;
  saving.value = true;
  try {
    const result = await runModelProfileSave(input, props.saveModelProfile);
    const current = captureFormOperation(activeSaveOperationToken.value, inputFromForm(), formRevision.value);
    if (!formOperationCanApply(submitted, current)) {
      return;
    }
    if (!result.ok) {
      modelStatus.value = `${props.t('saveModelProfileFailed')} ${result.error.message}`;
      return;
    }
    loadProfile(result.profile);
    modelStatus.value = props.t('savedModelProfile');
  } finally {
    if (activeSaveOperationToken.value === submitted.token) {
      saving.value = false;
    }
  }
}

async function testProfile(): Promise<void> {
  if (capabilityError.value) {
    modelStatus.value = capabilityError.value;
    connectionTestState.value = 'failed';
    return;
  }
  const input = inputFromForm();
  const submitted = captureFormOperation(++nextConnectionOperationToken, input, formRevision.value);
  activeConnectionOperationToken.value = submitted.token;
  modelStatus.value = props.t('testingModelEndpoint');
  testedFingerprint.value = submitted.fingerprint;
  connectionTestState.value = 'testing';
  testingConnection.value = true;
  connectionResult.value = undefined;
  connectionGuidanceForLocalQwen.value = false;
  try {
    const result = await props.testModelProfile(input);
    const current = captureFormOperation(activeConnectionOperationToken.value, inputFromForm(), formRevision.value);
    if (!formOperationCanApply(submitted, current)) {
      if (activeConnectionOperationToken.value === submitted.token) {
        connectionTestState.value = 'untested';
        modelStatus.value = props.t('connectionTestStale');
      }
      return;
    }
    connectionTestState.value = result.status;
    connectionResult.value = result;
    connectionGuidanceForLocalQwen.value = isLocalQwenServiceProfile(input);
    modelStatus.value = props.t('connectionTestCompleted');
  } catch (error) {
    const current = captureFormOperation(activeConnectionOperationToken.value, inputFromForm(), formRevision.value);
    if (formOperationCanApply(submitted, current)) {
      connectionTestState.value = 'failed';
      connectionResult.value = undefined;
      connectionGuidanceForLocalQwen.value = false;
      modelStatus.value = error instanceof Error ? error.message : props.t('modelConnectionFailed');
    }
  } finally {
    if (activeConnectionOperationToken.value === submitted.token) {
      testingConnection.value = false;
    }
  }
}

function synchronizeEffortSelection(): void {
  const reconciled = reconcileEffortSelection({
    reasoningMode: form.reasoningMode,
    inputMode: form.reasoningInputMode,
    options: effortOptions.value,
    currentEffort: form.reasoningEffort,
    defaultEffort: form.defaultEffort,
  });
  form.reasoningEffort = reconciled.currentEffort;
  form.defaultEffort = reconciled.defaultEffort;
}

function deleteProfile(): void {
  if (!form.id || saving.value) {
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

function handleReasoningDisplayChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as ReasoningDisplayMode;
  if (value === 'auto' || value === 'raw' || value === 'summary') {
    emit('updateSettings', { reasoningDisplayMode: value });
  }
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
        <button type="button" :class="{ active: activeSection === 'runtime' }" @click="activeSection = 'runtime'">
          <span>{{ t('runtime') }}</span>
          <small>{{ t('runtimeHint') }}</small>
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
          <button type="button" class="secondary-button compact-button" :disabled="saving" @click="resetForm">{{ t('addProvider') }}</button>
        </div>

        <label class="field-stack">
          <span>{{ t('currentChatModel') }}</span>
          <select :value="activeModelProfileId ?? ''" class="model-select wide" :disabled="saving" @change="emit('selectModelProfile', (($event.target as HTMLSelectElement).value || undefined))">
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
              :disabled="saving"
              @click="loadProfile(profile)"
            >
              <span>{{ profile.name }}</span>
              <small>{{ profile.apiKeyConfigured ? t('keySaved') : t('noKey') }}</small>
            </button>
          </aside>

          <fieldset class="settings-form settings-form-fieldset two-column" :disabled="saving" :aria-busy="saving">
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
              <div class="capability-heading">
                <h3>{{ t('reasoningCapabilities') }}</h3>
                <span class="capability-status" :data-state="connectionTestState" data-testid="capability-test-status">
                  {{ t(connectionTestState) }}
                </span>
              </div>
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
                <span>{{ t('reasoningInputMode') }}</span>
                <select v-model="form.reasoningInputMode" data-testid="reasoning-input-mode" class="model-select wide">
                  <option value="unsupported">{{ t('unsupported') }}</option>
                  <option value="toggle">{{ t('toggle') }}</option>
                  <option value="effort">{{ t('effortOptions') }}</option>
                  <option value="custom">{{ t('customUnverified') }}</option>
                </select>
              </label>
              <label v-if="form.reasoningInputMode === 'effort'" class="field-stack capability-wide">
                <span>{{ t('effortOptions') }}</span>
                <input
                  v-model="form.effortOptionsText"
                  class="text-input"
                  data-testid="effort-options-input"
                  :placeholder="t('effortOptionsPlaceholder')"
                />
              </label>
              <label v-if="form.reasoningInputMode === 'effort'" class="field-stack">
                <span>{{ t('currentEffort') }}</span>
                <select v-model="form.reasoningEffort" data-testid="current-effort-select" class="model-select wide">
                  <option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option>
                </select>
              </label>
              <label v-if="form.reasoningInputMode === 'effort'" class="field-stack">
                <span>{{ t('defaultEffort') }}</span>
                <select v-model="form.defaultEffort" data-testid="default-effort-select" class="model-select wide">
                  <option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option>
                </select>
              </label>
              <label class="check-row capability-check">
                <input v-model="form.rawOutput" data-testid="raw-output-toggle" type="checkbox" />
                <span>{{ t('rawReasoning') }}</span>
              </label>
              <label class="check-row capability-check">
                <input v-model="form.summaryOutput" data-testid="summary-output-toggle" type="checkbox" />
                <span>{{ t('nativeReasoningSummary') }}</span>
              </label>
              <label class="field-stack">
                <span>{{ t('maximumConcurrentTurns') }}</span>
                <input
                  v-model.number="form.maxConcurrency"
                  class="text-input"
                  data-testid="max-concurrency-input"
                  type="number"
                  min="1"
                  :max="maxConcurrencyLimit"
                  :disabled="editingProfile?.capabilities.concurrency.configurable === false"
                />
              </label>
              <label class="field-stack">
                <span>{{ t('maximumOutputTokens') }}</span>
                <input
                  v-model.number="form.maxOutputTokens"
                  class="text-input"
                  data-testid="max-output-tokens-input"
                  type="number"
                  min="1"
                  :max="MAX_OUTPUT_TOKENS"
                  step="1"
                />
              </label>
              <p v-if="form.reasoningInputMode === 'custom'" class="settings-warning capability-wide">
                {{ t('customCapabilityWarning') }}
              </p>
              <p v-if="capabilityError" class="field-error capability-wide" data-testid="capability-validation-error">
                {{ capabilityError }}
              </p>
            </div>
          </fieldset>
        </div>

        <p class="settings-note">{{ modelStatus }}</p>
        <p
          v-if="connectionDiagnostic"
          class="model-connection-diagnostic"
          data-testid="model-connection-diagnostic"
          :data-state="connectionTestState"
          role="status"
          aria-live="polite"
        >
          {{ connectionDiagnostic }}
        </p>

        <div class="approval-actions">
          <button type="button" class="secondary-button compact" :disabled="!form.id || saving" @click="deleteProfile">{{ t('delete') }}</button>
          <button type="button" class="secondary-button compact" :disabled="saving || testingConnection" @click="testProfile">{{ t('testConnection') }}</button>
          <button type="button" class="primary-action compact" :disabled="saving || testingConnection || Boolean(capabilityError)" :aria-busy="saving" @click="saveProfile">
            {{ saving ? t('saving') : t('save') }}
          </button>
        </div>
      </section>

      <section v-else class="settings-card">
        <p class="pane-label">{{ t('runtime') }}</p>
        <h2>{{ t('runtimeBehavior') }}</h2>
        <label class="field-stack">
          <span>{{ t('reasoningDisplayPreference') }}</span>
          <select
            class="model-select wide"
            data-testid="reasoning-display-select"
            :value="settings.reasoningDisplayMode"
            @change="handleReasoningDisplayChange"
          >
            <option value="auto">{{ t('automatic') }}</option>
            <option value="summary">{{ t('reasoningSummary') }}</option>
            <option value="raw">{{ t('rawReasoning') }}</option>
          </select>
        </label>
        <div class="runtime-explanation">
          <strong>{{ t('fifoQueueTitle') }}</strong>
          <p>{{ t('fifoQueueDescription') }}</p>
        </div>
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
