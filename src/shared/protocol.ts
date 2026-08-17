import type {
  AppSnapshot,
  LanguagePreference,
  MetricSource,
  ModelResponseSpeed,
  ModelProfileInput,
  ModelRunMetrics,
  ReasoningEffort,
  ReasoningMode,
  ReasoningProtocol,
  RuntimeSettingsInput,
  ThemePreference,
} from './domain.js';

export type DesktopRequest =
  | { type: 'snapshot.get' }
  | { type: 'group.create'; name: string }
  | { type: 'group.delete'; groupId: string }
  | { type: 'thread.create'; title: string; groupId?: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.setModel'; threadId: string; modelProfileId?: string }
  | { type: 'turn.start'; threadId: string; text: string; modelProfileId?: string }
  | { type: 'turn.cancel'; threadId: string; turnId: string }
  | { type: 'approval.respond'; approvalId: string; approved: boolean }
  | { type: 'modelProfile.save'; profile: ModelProfileInput }
  | { type: 'modelProfile.delete'; id: string }
  | { type: 'modelProfile.test'; profile: ModelProfileInput }
  | { type: 'settings.update'; settings: RuntimeSettingsInput }
  | { type: 'language.set'; language: LanguagePreference }
  | { type: 'theme.set'; theme: ThemePreference };

export type SequencedAgentEvent =
  | { type: 'turn.started'; threadId: string; turnId: string; sequence: number; title: string }
  | { type: 'message.delta'; threadId: string; turnId: string; sequence: number; text: string }
  | { type: 'tool.started'; threadId: string; turnId: string; sequence: number; toolId: string; title: string }
  | { type: 'tool.output'; threadId: string; turnId: string; sequence: number; toolId: string; output: string }
  | { type: 'model.metrics'; threadId: string; turnId: string; sequence: number; metrics: ModelRunMetrics }
  | { type: 'approval.required'; threadId: string; turnId: string; sequence: number; approvalId: string; title: string; description: string }
  | { type: 'turn.completed'; threadId: string; turnId: string; sequence: number }
  | { type: 'turn.failed'; threadId: string; turnId: string; sequence: number; error: string };

export type AgentEvent = { type: 'snapshot'; snapshot: AppSnapshot } | SequencedAgentEvent;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === 'string' && record[key].length > 0;
}

function hasBoolean(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === 'boolean';
}

function hasOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function hasSequence(record: UnknownRecord): boolean {
  return Number.isInteger(record.sequence) && Number(record.sequence) >= 0;
}

function hasThreadTurnAndSequence(record: UnknownRecord): boolean {
  return hasString(record, 'threadId') && hasString(record, 'turnId') && hasSequence(record);
}

function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === 'auto' || value === 'enabled' || value === 'disabled';
}

function isReasoningProtocol(value: unknown): value is ReasoningProtocol {
  return value === 'none' || value === 'qwen' || value === 'openai' || value === 'custom';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

function isMetricSource(value: unknown): value is MetricSource {
  return value === 'server' || value === 'client' || value === 'unavailable';
}

function isModelResponseSpeed(value: unknown): value is ModelResponseSpeed {
  return value === 'standard' || value === 'fast' || value === 'quality';
}

function isReasoningInput(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.mode === undefined || isReasoningMode(value.mode)) &&
    (value.protocol === undefined || isReasoningProtocol(value.protocol)) &&
    (value.effort === undefined || isReasoningEffort(value.effort))
  );
}

function isRuntimeSettingsInput(value: unknown): value is RuntimeSettingsInput {
  if (!isRecord(value)) {
    return false;
  }

  const showModelMetrics = value.showModelMetrics;
  const contextMessageLimit = value.contextMessageLimit;

  return (
    (showModelMetrics === undefined || typeof showModelMetrics === 'boolean') &&
    (contextMessageLimit === undefined ||
      (Number.isInteger(contextMessageLimit) && Number(contextMessageLimit) >= 1 && Number(contextMessageLimit) <= 200))
  );
}

function isModelProfileInput(value: unknown): value is ModelProfileInput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOptionalString(value, 'id') &&
    hasString(value, 'name') &&
    value.provider === 'openai-compatible' &&
    hasString(value, 'baseUrl') &&
    hasString(value, 'model') &&
    hasOptionalString(value, 'apiKey') &&
    isReasoningInput(value.reasoning) &&
    (value.responseSpeed === undefined || isModelResponseSpeed(value.responseSpeed)) &&
    (value.isDefault === undefined || typeof value.isDefault === 'boolean')
  );
}

export function isDesktopRequest(value: unknown): value is DesktopRequest {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'snapshot.get':
      return true;
    case 'group.create':
      return hasString(value, 'name');
    case 'group.delete':
      return hasString(value, 'groupId');
    case 'thread.create':
      return hasString(value, 'title') && hasOptionalString(value, 'groupId');
    case 'thread.delete':
      return hasString(value, 'threadId');
    case 'thread.setModel':
      return hasString(value, 'threadId') && hasOptionalString(value, 'modelProfileId');
    case 'turn.start':
      return hasString(value, 'threadId') && hasString(value, 'text') && hasOptionalString(value, 'modelProfileId');
    case 'turn.cancel':
      return hasString(value, 'threadId') && hasString(value, 'turnId');
    case 'approval.respond':
      return hasString(value, 'approvalId') && hasBoolean(value, 'approved');
    case 'modelProfile.save':
    case 'modelProfile.test':
      return isModelProfileInput(value.profile);
    case 'modelProfile.delete':
      return hasString(value, 'id');
    case 'settings.update':
      return isRuntimeSettingsInput(value.settings);
    case 'language.set':
      return value.language === 'zh-CN' || value.language === 'en-US';
    case 'theme.set':
      return value.theme === 'system' || value.theme === 'light' || value.theme === 'dark';
    default:
      return false;
  }
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'snapshot') {
    return isRecord(value.snapshot);
  }

  if (!hasThreadTurnAndSequence(value)) {
    return false;
  }

  switch (value.type) {
    case 'turn.started':
      return hasString(value, 'title');
    case 'message.delta':
      return hasString(value, 'text');
    case 'tool.started':
      return hasString(value, 'toolId') && hasString(value, 'title');
    case 'tool.output':
      return hasString(value, 'toolId') && typeof value.output === 'string';
    case 'model.metrics':
      return (
        isRecord(value.metrics) &&
        Number.isFinite(value.metrics.durationMs) &&
        isReasoningMode(value.metrics.reasoningRequested) &&
        isReasoningProtocol(value.metrics.reasoningProtocol) &&
        typeof value.metrics.reasoningObserved === 'boolean' &&
        (value.metrics.responseSpeed === undefined || isModelResponseSpeed(value.metrics.responseSpeed)) &&
        isMetricSource(value.metrics.speedSource) &&
        isMetricSource(value.metrics.usageSource)
      );
    case 'approval.required':
      return hasString(value, 'approvalId') && hasString(value, 'title') && hasString(value, 'description');
    case 'turn.completed':
      return true;
    case 'turn.failed':
      return hasString(value, 'error');
    default:
      return false;
  }
}
