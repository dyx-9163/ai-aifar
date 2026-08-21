<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  AppSettings, LanguagePreference, ModelCatalogResult, ModelProfile, ModelProvider,
  ModelProviderInput, ProviderConnectionResult, ProviderModelInput, RuntimeSettingsInput,
  WorkspaceRecord, WorkspaceTrustLevel,
} from '../../shared/domain';
import type { Translator } from '../i18n';
import {
  buildModelProviderInput, createProviderDraft, loadProviderDraft,
  providerDraftValidationIssue, type ProviderDraft,
} from '../providerForm';
import {
  clearAllModels, clearFilteredModels, filterCatalogModels, parseManualModelIds,
  selectAllModels, selectFilteredModels,
} from '../modelCatalogSelection';

const props = defineProps<{
  modelProviders: ModelProvider[];
  modelProfiles: ModelProfile[];
  activeModelProfileId?: string;
  language: LanguagePreference;
  settings: AppSettings;
  workspaces: WorkspaceRecord[];
  t: Translator;
  saveModelProvider: (provider: ModelProviderInput) => Promise<ModelProvider>;
  deleteModelProvider: (id: string) => Promise<void>;
  discoverProviderModels: (provider: ModelProviderInput) => Promise<ModelCatalogResult>;
  testModelProvider: (provider: ModelProviderInput, modelId: string) => Promise<ProviderConnectionResult>;
  addProviderModels: (providerId: string, models: ProviderModelInput[]) => Promise<ModelProfile[]>;
  updateProviderModel: (providerId: string, model: ProviderModelInput & { id: string }) => Promise<ModelProfile>;
  deleteProviderModel: (id: string) => Promise<void>;
}>();

const emit = defineEmits<{
  back: [];
  deleteWorkspace: [workspaceId: string];
  setWorkspaceTrust: [workspaceId: string, trustLevel: WorkspaceTrustLevel];
  addWorkspace: [];
  selectModelProfile: [id?: string];
  setLanguage: [language: LanguagePreference];
  updateSettings: [settings: RuntimeSettingsInput];
}>();

type ModelDraft = {
  displayName: string; enabled: boolean; contextWindowTokens?: number;
  maxOutputTokens: number; isDefault: boolean;
};

const activeSection = ref<'general' | 'workspaces' | 'models' | 'runtime'>('models');
const selectedProviderId = ref<string>();
const draft = reactive<ProviderDraft>(createProviderDraft());
const status = ref('');
const busy = ref(false);
const catalogOpen = ref(false);
const catalogModels = ref<string[]>([]);
const catalogQuery = ref('');
const catalogSelected = ref<Set<string>>(new Set());
const manualModelIds = ref('');
const testModelId = ref('');
const modelDrafts = reactive<Record<string, ModelDraft>>({});

const providerModels = computed(() => props.modelProfiles
  .filter((model) => model.providerId === draft.id)
  .sort((left, right) => left.name.localeCompare(right.name)));
const configuredModelIds = computed(() => new Set(providerModels.value.map((model) => model.model)));
const selectableCatalogModels = computed(() => catalogModels.value.filter((id) => !configuredModelIds.value.has(id)));
const visibleCatalogModels = computed(() => filterCatalogModels(catalogModels.value, catalogQuery.value));
const providerIssue = computed(() => providerDraftValidationIssue(draft));

watch(
  () => [props.modelProviders, props.activeModelProfileId] as const,
  () => {
    if (selectedProviderId.value && props.modelProviders.some((provider) => provider.id === selectedProviderId.value)) return;
    const providerId = props.modelProfiles.find((model) => model.id === props.activeModelProfileId)?.providerId;
    const provider = props.modelProviders.find((candidate) => candidate.id === providerId) ?? props.modelProviders[0];
    if (provider) selectProvider(provider); else newProvider();
  },
  { immediate: true, deep: true },
);

watch(
  () => props.modelProfiles,
  (models) => {
    for (const model of models) {
      modelDrafts[model.id] = {
        displayName: model.name,
        enabled: model.enabled !== false,
        contextWindowTokens: model.contextWindowTokens,
        maxOutputTokens: model.maxOutputTokens,
        isDefault: model.isDefault,
      };
    }
  },
  { immediate: true, deep: true },
);

function text(zh: string, en: string): string { return props.language === 'zh-CN' ? zh : en; }

function selectProvider(provider: ModelProvider): void {
  selectedProviderId.value = provider.id;
  Object.assign(draft, loadProviderDraft(provider));
  status.value = '';
  testModelId.value = props.modelProfiles.find((model) => model.providerId === provider.id)?.model ?? '';
}

function newProvider(): void {
  selectedProviderId.value = undefined;
  Object.assign(draft, createProviderDraft());
  status.value = '';
  testModelId.value = '';
}

async function ensureSavedProvider(): Promise<ModelProvider> {
  const saved = await props.saveModelProvider(buildModelProviderInput(draft));
  selectedProviderId.value = saved.id;
  Object.assign(draft, loadProviderDraft(saved));
  return saved;
}

async function runBusy(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  try { await work(); }
  catch (error) { status.value = error instanceof Error ? error.message : text('操作失败。', 'Operation failed.'); }
  finally { busy.value = false; }
}

async function saveProvider(): Promise<void> {
  if (providerIssue.value) return;
  await runBusy(async () => { await ensureSavedProvider(); status.value = text('供应商配置已保存。', 'Provider saved.'); });
}

async function discoverModels(): Promise<void> {
  if (providerIssue.value) return;
  await runBusy(async () => {
    const result = await props.discoverProviderModels(buildModelProviderInput(draft));
    catalogModels.value = result.models;
    catalogSelected.value = new Set(result.models.filter((id) => !configuredModelIds.value.has(id)));
    catalogQuery.value = '';
    catalogOpen.value = true;
    status.value = result.warning ?? text(`已获取 ${result.models.length} 个模型。`, `Found ${result.models.length} models.`);
  });
}

async function testConnection(): Promise<void> {
  if (providerIssue.value || !testModelId.value.trim()) {
    status.value = text('请输入一个用于测试的模型 ID。', 'Enter a model ID to test.');
    return;
  }
  await runBusy(async () => {
    const result = await props.testModelProvider(buildModelProviderInput(draft), testModelId.value.trim());
    status.value = result.message;
  });
}

async function removeProvider(): Promise<void> {
  if (!draft.id) return;
  await runBusy(async () => { await props.deleteModelProvider(draft.id!); newProvider(); });
}

function toggleCatalogModel(id: string, checked: boolean): void {
  const next = new Set(catalogSelected.value);
  if (checked) next.add(id); else next.delete(id);
  catalogSelected.value = next;
}

async function savedProviderForModels(): Promise<ModelProvider> {
  return ensureSavedProvider();
}

async function addCatalogSelection(): Promise<void> {
  const ids = [...catalogSelected.value].filter((id) => !configuredModelIds.value.has(id));
  if (!ids.length) return;
  await runBusy(async () => {
    const provider = await savedProviderForModels();
    await props.addProviderModels(provider.id, ids.map((modelId) => ({ modelId, catalogState: 'available' })));
    catalogOpen.value = false;
    status.value = text(`已添加 ${ids.length} 个模型。`, `Added ${ids.length} models.`);
  });
}

async function addManualModels(): Promise<void> {
  const ids = parseManualModelIds(manualModelIds.value).filter((id) => !configuredModelIds.value.has(id));
  if (!ids.length) return;
  await runBusy(async () => {
    const provider = await savedProviderForModels();
    await props.addProviderModels(provider.id, ids.map((modelId) => ({ modelId, catalogState: 'manual' })));
    manualModelIds.value = '';
    status.value = text(`已手动添加 ${ids.length} 个模型。`, `Added ${ids.length} manual models.`);
  });
}

async function saveModel(model: ModelProfile): Promise<void> {
  if (!model.providerId) return;
  const values = modelDrafts[model.id];
  if (!values) return;
  await props.updateProviderModel(model.providerId, {
    id: model.id, modelId: model.model, displayName: values.displayName,
    enabled: values.enabled, contextWindowTokens: values.contextWindowTokens || undefined,
    maxOutputTokens: values.maxOutputTokens, isDefault: values.isDefault,
    catalogState: model.catalogState,
  });
  if (values.isDefault) emit('selectModelProfile', model.id);
}

function addHeader(): void {
  let index = 1;
  while (`x-custom-${index}` in draft.customHeaders) index += 1;
  draft.customHeaders[`x-custom-${index}`] = '';
}

function renameHeader(oldName: string, newName: string): void {
  if (oldName === newName) return;
  const value = draft.customHeaders[oldName] ?? '';
  delete draft.customHeaders[oldName];
  draft.customHeaders[newName] = value;
}

function handleLanguageChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'zh-CN' || value === 'en-US') emit('setLanguage', value);
}

function handleWorkspaceTrustChange(workspaceId: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as WorkspaceTrustLevel;
  if (value === 'read-only' || value === 'read-write') emit('setWorkspaceTrust', workspaceId, value);
}
</script>

<template>
  <section class="settings-view" aria-label="Settings">
    <header class="settings-header">
      <div><p class="pane-label">{{ t('settings') }}</p><h1>{{ t('settings') }}</h1><p>{{ t('settingsIntro') }}</p></div>
      <button type="button" class="secondary-button compact" @click="emit('back')">{{ t('backToChat') }}</button>
    </header>

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <button type="button" :class="{ active: activeSection === 'general' }" @click="activeSection = 'general'"><span>{{ t('general') }}</span></button>
        <button type="button" :class="{ active: activeSection === 'workspaces' }" @click="activeSection = 'workspaces'"><span>{{ t('workspacesSection') }}</span></button>
        <button type="button" :class="{ active: activeSection === 'models' }" @click="activeSection = 'models'"><span>{{ t('modelProviders') }}</span></button>
        <button type="button" :class="{ active: activeSection === 'runtime' }" @click="activeSection = 'runtime'"><span>{{ t('runtime') }}</span></button>
      </nav>

      <section v-if="activeSection === 'general'" class="settings-card">
        <h2>{{ t('general') }}</h2>
        <label class="field-stack"><span>{{ t('selectLanguage') }}</span><select :value="language" class="model-select wide" @change="handleLanguageChange"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
      </section>

      <section v-else-if="activeSection === 'workspaces'" class="settings-card">
        <h2>{{ t('workspacesSection') }}</h2>
        <ul class="workspace-list">
          <li v-for="workspace in workspaces" :key="workspace.id" class="workspace-row">
            <div class="workspace-row-text"><strong>{{ workspace.displayName }}</strong><small>{{ workspace.canonicalRootPath }}</small></div>
            <select class="model-select" :value="workspace.trustLevel" @change="handleWorkspaceTrustChange(workspace.id, $event)"><option value="read-only">{{ t('workspaceReadOnly') }}</option><option value="read-write">{{ t('workspaceReadWrite') }}</option></select>
            <button class="secondary-button compact" @click="emit('deleteWorkspace', workspace.id)">{{ t('delete') }}</button>
          </li>
        </ul>
        <button type="button" class="primary-action compact" @click="emit('addWorkspace')">{{ t('addWorkspace') }}</button>
      </section>

      <section v-else-if="activeSection === 'models'" class="settings-card provider-settings-card">
        <div class="section-heading">
          <div><p class="pane-label">{{ text('供应商与模型', 'Providers and models') }}</p><h2>{{ text('模型服务', 'Model services') }}</h2></div>
          <button type="button" class="secondary-button compact" data-testid="new-provider" @click="newProvider">{{ text('新建供应商', 'New provider') }}</button>
        </div>
        <div class="provider-settings-layout">
          <aside class="provider-list" aria-label="Providers">
            <button v-for="provider in modelProviders" :key="provider.id" type="button" :class="{ active: draft.id === provider.id }" @click="selectProvider(provider)"><strong>{{ provider.name }}</strong><small>{{ provider.protocol }} · {{ modelProfiles.filter((model) => model.providerId === provider.id).length }}</small></button>
            <p v-if="modelProviders.length === 0" class="settings-note">{{ text('还没有供应商。', 'No providers yet.') }}</p>
          </aside>

          <div class="provider-editor">
            <div class="settings-form two-column">
              <label class="field-stack"><span>{{ text('名称', 'Name') }}</span><input v-model="draft.name" class="text-input" placeholder="DashScope / OpenAI / Pangu" /></label>
              <label class="field-stack"><span>{{ text('API 协议', 'API protocol') }}</span><select v-model="draft.protocol" class="model-select wide" data-testid="provider-protocol"><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
              <label class="field-stack"><span>Base URL</span><input v-model="draft.baseUrl" class="text-input" placeholder="https://example.com/v1" /></label>
              <label class="field-stack"><span>API Key</span><input v-model="draft.apiKey" class="text-input" type="password" :placeholder="draft.apiKeyConfigured ? text('留空保留已保存密钥', 'Blank keeps saved key') : 'sk-...'" /></label>
              <label class="field-stack"><span>{{ text('最大并发会话', 'Max concurrent turns') }}</span><input v-model.number="draft.maxConcurrency" class="text-input" type="number" min="1" max="128" /></label>
              <label class="field-stack"><span>{{ text('请求超时（毫秒）', 'Request timeout (ms)') }}</span><input v-model.number="draft.requestTimeoutMs" class="text-input" type="number" min="1000" max="3600000" /></label>
              <label class="field-stack"><span>{{ text('工具调用', 'Tool calling') }}</span><select v-model="draft.toolCallingMode" class="model-select wide"><option value="native">{{ text('原生函数调用', 'Native function calls') }}</option><option value="text-fallback">{{ text('文本兼容模式', 'Text fallback') }}</option></select></label>
              <label class="field-stack"><span>{{ text('思考参数', 'Thinking parameters') }}</span><select v-model="draft.thinkingMode" class="model-select wide"><option value="model-default">{{ text('模型默认（推荐）', 'Model default (recommended)') }}</option><option value="custom">{{ text('自定义 JSON', 'Custom JSON') }}</option></select></label>
              <label class="check-row"><input v-model="draft.allowImages" type="checkbox" /><span>{{ text('允许图片输入', 'Allow image input') }}</span></label>
              <label class="field-stack"><span>{{ text('模型目录路径（可选）', 'Catalog path (optional)') }}</span><input v-model="draft.catalogPath" class="text-input" placeholder="models" /></label>
              <label v-if="draft.thinkingMode === 'custom'" class="field-stack provider-wide"><span>{{ text('自定义请求 JSON', 'Custom request JSON') }}</span><textarea v-model="draft.customRequestBodyText" class="text-input provider-json" placeholder='{"reasoning_effort":"high"}' /></label>
            </div>

            <div class="provider-headers">
              <div class="section-heading compact-heading"><h3>{{ text('自定义请求头', 'Custom headers') }}</h3><button type="button" class="secondary-button compact" @click="addHeader">{{ text('添加', 'Add') }}</button></div>
              <div v-for="(value, name) in draft.customHeaders" :key="name" class="provider-header-row"><input :value="name" class="text-input" :placeholder="text('请求头名称', 'Header name')" @change="renameHeader(name, ($event.target as HTMLInputElement).value)" /><input v-model="draft.customHeaders[name]" class="text-input" type="password" :placeholder="value === '' ? text('留空保留已保存值', 'Blank keeps saved value') : ''" /><button type="button" class="icon-button" :title="t('delete')" @click="delete draft.customHeaders[name]">×</button></div>
            </div>

            <p v-if="providerIssue" class="field-error">{{ providerIssue }}</p><p v-if="status" class="settings-note" role="status">{{ status }}</p>
            <div class="provider-actions"><button type="button" class="secondary-button compact" :disabled="busy || Boolean(providerIssue)" @click="discoverModels">{{ text('获取模型', 'Fetch models') }}</button><input v-model="testModelId" class="text-input test-model-id" :placeholder="text('测试模型 ID', 'Test model ID')" /><button type="button" class="secondary-button compact" :disabled="busy || Boolean(providerIssue)" @click="testConnection">{{ t('testConnection') }}</button><button type="button" class="primary-action compact" :disabled="busy || Boolean(providerIssue)" @click="saveProvider">{{ t('save') }}</button><button type="button" class="secondary-button compact danger-text" :disabled="busy || !draft.id" @click="removeProvider">{{ t('delete') }}</button></div>

            <section v-if="draft.id" class="provider-models">
              <div class="section-heading compact-heading"><div><h3>{{ text('已添加模型', 'Added models') }}</h3><small>{{ providerModels.length }}</small></div></div>
              <div v-for="model in providerModels" :key="model.id" class="provider-model-row" :data-state="model.catalogState">
                <div class="provider-model-identity"><strong>{{ model.model }}</strong><small v-if="model.catalogState === 'missing'">{{ text('目录中暂不可用', 'Missing from catalog') }}</small><small v-else-if="model.catalogState === 'manual'">{{ text('手动添加', 'Manual') }}</small></div>
                <input v-model="modelDrafts[model.id].displayName" class="text-input" :aria-label="text('显示名称', 'Display name')" />
                <label><span>{{ text('上下文', 'Context') }}</span><input v-model.number="modelDrafts[model.id].contextWindowTokens" class="text-input token-input" type="number" min="1" placeholder="32768" /></label>
                <label><span>{{ text('输出 Token', 'Output tokens') }}</span><input v-model.number="modelDrafts[model.id].maxOutputTokens" class="text-input token-input" type="number" min="1" /></label>
                <label class="check-row"><input v-model="modelDrafts[model.id].enabled" type="checkbox" /><span>{{ text('启用', 'Enabled') }}</span></label>
                <label class="check-row"><input v-model="modelDrafts[model.id].isDefault" type="checkbox" /><span>{{ text('默认', 'Default') }}</span></label>
                <button type="button" class="secondary-button compact" @click="saveModel(model)">{{ t('save') }}</button><button type="button" class="icon-button" :title="t('delete')" @click="deleteProviderModel(model.id)">×</button>
              </div>
              <div class="manual-model-add"><textarea v-model="manualModelIds" class="text-input" :placeholder="text('手动输入模型 ID，逗号或换行分隔', 'Manual model IDs, comma or newline separated')" /><button type="button" class="secondary-button compact" :disabled="busy" @click="addManualModels">{{ text('手动添加', 'Add manually') }}</button></div>
            </section>
          </div>
        </div>
      </section>

       <section v-else class="settings-card"><h2>{{ t('runtimeBehavior') }}</h2><label class="toggle-row"><input :checked="settings.showModelMetrics" type="checkbox" @change="emit('updateSettings', { showModelMetrics: ($event.target as HTMLInputElement).checked })" /><span>{{ text('显示模型运行指标', 'Show model metrics') }}</span></label><label class="field-stack"><span>{{ t('reasoningDisplayPreference') }}</span><select class="model-select wide" :value="settings.reasoningDisplayMode" @change="emit('updateSettings', { reasoningDisplayMode: ($event.target as HTMLSelectElement).value as AppSettings['reasoningDisplayMode'] })"><option value="auto">{{ t('automatic') }}</option><option value="summary">{{ t('reasoningSummary') }}</option><option value="raw">{{ t('rawReasoning') }}</option></select></label></section>
    </div>

    <div v-if="catalogOpen" class="dialog-backdrop" data-testid="model-catalog-dialog" @click.self="catalogOpen = false">
      <section class="dialog-card catalog-dialog" role="dialog" aria-modal="true">
        <header class="dialog-header"><div><h2>{{ text('选择要添加的模型', 'Choose models to add') }}</h2><p>{{ text('搜索不会清除隐藏的选择。', 'Search does not clear hidden selections.') }}</p></div><button type="button" class="dialog-close" @click="catalogOpen = false">×</button></header>
        <input v-model="catalogQuery" class="text-input" type="search" :placeholder="text('搜索模型', 'Search models')" />
        <div class="catalog-bulk-actions"><button type="button" class="secondary-button compact" @click="catalogSelected = selectAllModels(selectableCatalogModels)">{{ text('全部选中', 'Select all') }}</button><button type="button" class="secondary-button compact" @click="catalogSelected = clearAllModels()">{{ text('全部取消', 'Clear all') }}</button><button type="button" class="secondary-button compact" @click="catalogSelected = selectFilteredModels(selectableCatalogModels, catalogSelected, catalogQuery)">{{ text('选中搜索结果', 'Select results') }}</button><button type="button" class="secondary-button compact" @click="catalogSelected = clearFilteredModels(selectableCatalogModels, catalogSelected, catalogQuery)">{{ text('取消搜索结果', 'Clear results') }}</button></div>
        <div class="catalog-model-list"><label v-for="id in visibleCatalogModels" :key="id" class="catalog-model-option" :class="{ configured: configuredModelIds.has(id) }"><input type="checkbox" :checked="catalogSelected.has(id)" :disabled="configuredModelIds.has(id)" @change="toggleCatalogModel(id, ($event.target as HTMLInputElement).checked)" /><span>{{ id }}</span><small v-if="configuredModelIds.has(id)">{{ text('已添加', 'Added') }}</small></label></div>
        <footer class="provider-actions"><span>{{ text(`已选 ${catalogSelected.size} 个`, `${catalogSelected.size} selected`) }}</span><button type="button" class="secondary-button compact" @click="catalogOpen = false">{{ text('取消', 'Cancel') }}</button><button type="button" class="primary-action compact" :disabled="busy || catalogSelected.size === 0" @click="addCatalogSelection">{{ text('添加所选', 'Add selected') }}</button></footer>
      </section>
    </div>
  </section>
</template>
