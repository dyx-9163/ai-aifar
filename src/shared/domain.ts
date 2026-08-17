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

export type ItemKind = 'message' | 'tool' | 'change';

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

export type Item = MessageItem | ToolItem | ChangeItem;

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
}

export type ModelProviderType = 'openai-compatible';

export type MetricSource = 'server' | 'client' | 'unavailable';
export type ReasoningMode = 'auto' | 'enabled' | 'disabled';
export type ReasoningProtocol = 'none' | 'qwen' | 'openai' | 'custom';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ModelResponseSpeed = 'standard' | 'fast' | 'quality';

export interface ModelReasoningSettings {
  mode: ReasoningMode;
  protocol: ReasoningProtocol;
  effort: ReasoningEffort;
}

export interface RuntimeSettingsInput {
  showModelMetrics?: boolean;
  contextMessageLimit?: number;
}

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  longContext: boolean;
  reasoning: boolean;
  streamingUsage: boolean;
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
  capabilities?: Partial<ModelCapabilities>;
  reasoning?: Partial<ModelReasoningSettings>;
  responseSpeed?: ModelResponseSpeed;
  isDefault?: boolean;
}

export interface ModelRunMetrics {
  modelProfileId?: string;
  modelName?: string;
  reasoningRequested: ReasoningMode;
  reasoningProtocol: ReasoningProtocol;
  reasoningObserved: boolean;
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
  items: Record<string, Item[]>;
  approvals: Approval[];
  modelProfiles: ModelProfile[];
  settings: AppSettings;
}
