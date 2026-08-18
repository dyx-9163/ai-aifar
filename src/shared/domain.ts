export type ThemePreference = 'system' | 'light' | 'dark';

export type LanguagePreference = 'zh-CN' | 'en-US';

export type ThreadStatus = 'ready' | 'running' | 'failed';

export interface ChatGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSummary {
  id: string;
  groupId: string;
  title: string;
  status: ThreadStatus;
  modelProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ItemKind = 'message' | 'reasoning' | 'tool' | 'change';

export interface BaseItem {
  id: string;
  threadId: string;
  turnId?: string;
  kind: ItemKind;
  createdAt: string;
}

export interface MessageItem extends BaseItem {
  kind: 'message';
  role: 'user' | 'assistant' | 'system';
  text: string;
  // Existing rows without this field are complete unless their TurnRecord is unfinished.
  incomplete?: boolean;
}

export type ReasoningOutputMode = 'raw' | 'summary';

export interface ReasoningItem extends BaseItem {
  kind: 'reasoning';
  mode: ReasoningOutputMode;
  text: string;
  incomplete: boolean;
}

export interface ToolItem extends BaseItem {
  kind: 'tool';
  title: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
}

export interface ChangeItem extends BaseItem {
  kind: 'change';
  path: string;
  action: 'created' | 'modified' | 'deleted';
  summary: string;
}

export type Item = MessageItem | ReasoningItem | ToolItem | ChangeItem;

export interface Approval {
  id: string;
  threadId: string;
  turnId: string;
  title: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  respondedAt?: string;
}

export interface AppSettings {
  theme: ThemePreference;
  language: LanguagePreference;
  activeModelProfileId?: string;
  showModelMetrics: boolean;
  contextMessageLimit: number;
  reasoningDisplayMode: ReasoningDisplayMode;
}

export type ModelProviderType = 'openai-compatible';

export type MetricSource = 'server' | 'client' | 'unavailable';
export type ReasoningMode = 'auto' | 'enabled' | 'disabled';
export type ReasoningProtocol = 'none' | 'qwen' | 'openai' | 'custom';
/** @deprecated Provider profiles declare their own effort strings. */
export type ReasoningEffort = string;
export type ModelResponseSpeed = 'standard' | 'fast' | 'quality';
export type ModelRunPhase = 'connecting' | 'reasoning' | 'answering';
export type ReasoningInputMode = 'unsupported' | 'toggle' | 'effort' | 'custom';
export type ReasoningDisplayMode = 'auto' | 'raw' | 'summary';
export type TurnStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ModelReasoningSettings {
  mode: ReasoningMode;
  protocol: ReasoningProtocol;
  effort?: string;
  display: ReasoningDisplayMode;
}

export interface RuntimeSettingsInput {
  showModelMetrics?: boolean;
  contextMessageLimit?: number;
  reasoningDisplayMode?: ReasoningDisplayMode;
}

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  longContext: boolean;
  reasoning: {
    inputMode: ReasoningInputMode;
    effortOptions: string[];
    outputModes: ReasoningOutputMode[];
    defaultEffort?: string;
  };
  concurrency: {
    defaultLimit: number;
    configurable: boolean;
    maxLimit?: number;
  };
  streaming: boolean;
  usage: { tokens: boolean; reasoningTokens: boolean };
}

export interface ModelCapabilitiesInput {
  text?: boolean;
  vision?: boolean;
  longContext?: boolean;
  reasoning?: Partial<ModelCapabilities['reasoning']>;
  concurrency?: Partial<ModelCapabilities['concurrency']>;
  streaming?: boolean;
  usage?: Partial<ModelCapabilities['usage']>;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: ModelProviderType;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  capabilities: ModelCapabilities;
  reasoning: ModelReasoningSettings;
  maxConcurrency: number;
  maxOutputTokens: number;
  /** @deprecated Kept readable for persisted-profile migration only. */
  responseSpeed: ModelResponseSpeed;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfileInput {
  id?: string;
  name: string;
  provider: ModelProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  capabilities?: ModelCapabilitiesInput;
  reasoning?: Partial<ModelReasoningSettings>;
  maxConcurrency?: number;
  maxOutputTokens?: number;
  /** @deprecated Kept readable for persisted-profile migration only. */
  responseSpeed?: ModelResponseSpeed;
  isDefault?: boolean;
}

export type ModelConnectionSuccessStatus = 'connected' | 'concurrency-warning' | 'slots-unverified';
export type ModelConnectionFailureStatus = 'offline' | 'model-mismatch';
export type ModelConnectionStatus = ModelConnectionSuccessStatus | ModelConnectionFailureStatus;

interface ModelConnectionResultBase {
  message: string;
  model: string;
  clientConcurrency: number;
}

export interface ModelConnectionConnectedResult extends ModelConnectionResultBase {
  ok: true;
  status: 'connected';
  serviceSlots: number;
}

export interface ModelConnectionConcurrencyWarningResult extends ModelConnectionResultBase {
  ok: true;
  status: 'concurrency-warning';
  serviceSlots: number;
}

export interface ModelConnectionSlotsUnverifiedResult extends ModelConnectionResultBase {
  ok: true;
  status: 'slots-unverified';
}

export interface ModelConnectionOfflineResult extends ModelConnectionResultBase {
  ok: false;
  status: 'offline';
}

export interface ModelConnectionMismatchResult extends ModelConnectionResultBase {
  ok: false;
  status: 'model-mismatch';
}

export type ModelConnectionSuccessResult =
  | ModelConnectionConnectedResult
  | ModelConnectionConcurrencyWarningResult
  | ModelConnectionSlotsUnverifiedResult;
export type ModelConnectionFailureResult = ModelConnectionOfflineResult | ModelConnectionMismatchResult;
export type ModelConnectionResult = ModelConnectionSuccessResult | ModelConnectionFailureResult;

export interface ModelRunMetrics {
  modelProfileId?: string;
  modelName?: string;
  reasoningRequested: ReasoningMode;
  reasoningProtocol: ReasoningProtocol;
  reasoningObserved: boolean;
  /** @deprecated No supported adapter exposes this setting. */
  responseSpeed?: ModelResponseSpeed;
  durationMs: number;
  tokensPerSecond?: number;
  speedSource: MetricSource;
  usageSource: MetricSource;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  thinkingEnabled?: boolean;
}

export interface AppSnapshot {
  groups: ChatGroup[];
  threads: ThreadSummary[];
  turns: TurnRecord[];
  items: Record<string, Item[]>;
  approvals: Approval[];
  modelProfiles: ModelProfile[];
  settings: AppSettings;
}

export interface TurnRecord {
  id: string;
  threadId: string;
  modelProfileId?: string;
  status: Exclude<TurnStatus, 'idle'>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  incomplete: boolean;
  metrics?: ModelRunMetrics;
}

export interface ThreadRuntimeState {
  threadId: string;
  turnId?: string;
  modelProfileId?: string;
  status: TurnStatus;
  queuePosition?: number;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  tokensPerSecond?: number;
  error?: string;
}
