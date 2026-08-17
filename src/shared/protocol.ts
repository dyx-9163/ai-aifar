import type {
  AppSnapshot,
  LanguagePreference,
  MetricSource,
  ModelCapabilitiesInput,
  ModelResponseSpeed,
  ModelRunPhase,
  ModelProfileInput,
  ModelRunMetrics,
  ReasoningDisplayMode,
  ReasoningInputMode,
  ReasoningMode,
  ReasoningOutputMode,
  ReasoningProtocol,
  RuntimeSettingsInput,
  ThemePreference,
} from './domain.js';
import { reasoningConfigurationIssue } from './reasoningConfiguration.js';

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

type SequencedTurnEnvelope = {
  threadId: string;
  turnId: string;
  modelProfileId: string;
  sequence: number;
};

export type SequencedAgentEvent =
  | ({ type: 'turn.queued'; queuePosition: number } & SequencedTurnEnvelope)
  | ({ type: 'turn.started'; title: string } & SequencedTurnEnvelope)
  | ({ type: 'message.delta'; text: string } & SequencedTurnEnvelope)
  | ({ type: 'answer.delta'; text: string } & SequencedTurnEnvelope)
  | ({ type: 'reasoning.raw.delta'; text: string } & SequencedTurnEnvelope)
  | ({ type: 'reasoning.summary.delta'; text: string } & SequencedTurnEnvelope)
  | ({ type: 'model.progress'; phase: ModelRunPhase } & SequencedTurnEnvelope)
  | ({ type: 'tool.started'; toolId: string; title: string } & SequencedTurnEnvelope)
  | ({ type: 'tool.output'; toolId: string; output: string } & SequencedTurnEnvelope)
  | ({ type: 'model.metrics'; metrics: ModelRunMetrics } & SequencedTurnEnvelope)
  | ({ type: 'approval.required'; approvalId: string; title: string; description: string } & SequencedTurnEnvelope)
  | ({ type: 'turn.cancelling' } & SequencedTurnEnvelope)
  | ({ type: 'turn.completed' } & SequencedTurnEnvelope)
  | ({ type: 'turn.failed'; error: string } & SequencedTurnEnvelope)
  | ({ type: 'turn.cancelled' } & SequencedTurnEnvelope);

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
  return hasString(record, 'threadId') && hasString(record, 'turnId') && hasString(record, 'modelProfileId') && hasSequence(record);
}

function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === 'auto' || value === 'enabled' || value === 'disabled';
}

function isReasoningProtocol(value: unknown): value is ReasoningProtocol {
  return value === 'none' || value === 'qwen' || value === 'openai' || value === 'custom';
}

function isReasoningInputMode(value: unknown): value is ReasoningInputMode {
  return value === 'unsupported' || value === 'toggle' || value === 'effort' || value === 'custom';
}

function isReasoningOutputMode(value: unknown): value is ReasoningOutputMode {
  return value === 'raw' || value === 'summary';
}

function isReasoningDisplayMode(value: unknown): value is ReasoningDisplayMode {
  return value === 'auto' || value === 'raw' || value === 'summary';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isMetricSource(value: unknown): value is MetricSource {
  return value === 'server' || value === 'client' || value === 'unavailable';
}

function isModelResponseSpeed(value: unknown): value is ModelResponseSpeed {
  return value === 'standard' || value === 'fast' || value === 'quality';
}

function isModelRunPhase(value: unknown): value is ModelRunPhase {
  return value === 'connecting' || value === 'reasoning' || value === 'answering';
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
    (value.effort === undefined || hasNonEmptyString(value.effort)) &&
    (value.display === undefined || isReasoningDisplayMode(value.display))
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(hasNonEmptyString) && new Set(value).size === value.length;
}

function isReasoningOutputModeArray(value: unknown): value is ReasoningOutputMode[] {
  return Array.isArray(value) && value.every(isReasoningOutputMode) && new Set(value).size === value.length;
}

function isCapabilitiesInput(value: unknown): value is ModelCapabilitiesInput {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }

  const reasoning = value.reasoning;
  const concurrency = value.concurrency;
  const usage = value.usage;
  if ((reasoning !== undefined && !isRecord(reasoning)) || (concurrency !== undefined && !isRecord(concurrency)) || (usage !== undefined && !isRecord(usage))) {
    return false;
  }

  const validReasoning =
    reasoning === undefined ||
    ((reasoning.inputMode === undefined || isReasoningInputMode(reasoning.inputMode)) &&
      (reasoning.effortOptions === undefined || isUniqueNonEmptyStringArray(reasoning.effortOptions)) &&
      (reasoning.outputModes === undefined || isReasoningOutputModeArray(reasoning.outputModes)) &&
      (reasoning.defaultEffort === undefined || hasNonEmptyString(reasoning.defaultEffort)) &&
      (reasoning.defaultEffort === undefined || reasoning.effortOptions === undefined ||
        (isUniqueNonEmptyStringArray(reasoning.effortOptions) && reasoning.effortOptions.includes(reasoning.defaultEffort as string))));
  const validConcurrency =
    concurrency === undefined ||
    ((concurrency.defaultLimit === undefined || isPositiveInteger(concurrency.defaultLimit)) &&
      (concurrency.configurable === undefined || typeof concurrency.configurable === 'boolean') &&
      (concurrency.maxLimit === undefined || isPositiveInteger(concurrency.maxLimit)) &&
      (concurrency.defaultLimit === undefined || concurrency.maxLimit === undefined ||
        (isPositiveInteger(concurrency.defaultLimit) && isPositiveInteger(concurrency.maxLimit) && concurrency.defaultLimit <= concurrency.maxLimit)));
  const validUsage =
    usage === undefined ||
    ((usage.tokens === undefined || typeof usage.tokens === 'boolean') &&
      (usage.reasoningTokens === undefined || typeof usage.reasoningTokens === 'boolean'));

  return (
    (value.text === undefined || typeof value.text === 'boolean') &&
    (value.vision === undefined || typeof value.vision === 'boolean') &&
    (value.longContext === undefined || typeof value.longContext === 'boolean') &&
    (value.streaming === undefined || typeof value.streaming === 'boolean') &&
    validReasoning &&
    validConcurrency &&
    validUsage
  );
}

function isRuntimeSettingsInput(value: unknown): value is RuntimeSettingsInput {
  if (!isRecord(value)) {
    return false;
  }

  const showModelMetrics = value.showModelMetrics;
  const contextMessageLimit = value.contextMessageLimit;
  const reasoningDisplayMode = value.reasoningDisplayMode;

  return (
    (showModelMetrics === undefined || typeof showModelMetrics === 'boolean') &&
    (contextMessageLimit === undefined ||
      (Number.isInteger(contextMessageLimit) && Number(contextMessageLimit) >= 1 && Number(contextMessageLimit) <= 200)) &&
    (reasoningDisplayMode === undefined || isReasoningDisplayMode(reasoningDisplayMode))
  );
}

function isModelProfileInput(value: unknown): value is ModelProfileInput {
  if (!isRecord(value)) {
    return false;
  }

  const structurallyValid = (
    hasOptionalString(value, 'id') &&
    hasString(value, 'name') &&
    value.provider === 'openai-compatible' &&
    hasString(value, 'baseUrl') &&
    hasString(value, 'model') &&
    hasOptionalString(value, 'apiKey') &&
    isCapabilitiesInput(value.capabilities) &&
    isReasoningInput(value.reasoning) &&
    (value.maxConcurrency === undefined || isPositiveInteger(value.maxConcurrency)) &&
    (value.responseSpeed === undefined || isModelResponseSpeed(value.responseSpeed)) &&
    (value.isDefault === undefined || typeof value.isDefault === 'boolean')
  );
  if (!structurallyValid) {
    return false;
  }

  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const capabilityReasoning = capabilities && isRecord(capabilities.reasoning) ? capabilities.reasoning : undefined;
  const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined;
  return reasoningConfigurationIssue({
    inputMode: isReasoningInputMode(capabilityReasoning?.inputMode) ? capabilityReasoning.inputMode : 'unsupported',
    protocol: isReasoningProtocol(reasoning?.protocol) ? reasoning.protocol : 'none',
    mode: isReasoningMode(reasoning?.mode) ? reasoning.mode : 'disabled',
  }) === undefined;
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
    case 'turn.queued':
      return isPositiveInteger(value.queuePosition);
    case 'turn.started':
      return hasString(value, 'title');
    case 'message.delta':
    case 'answer.delta':
    case 'reasoning.raw.delta':
    case 'reasoning.summary.delta':
      return hasString(value, 'text');
    case 'model.progress':
      return isModelRunPhase(value.phase);
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
    case 'turn.cancelling':
    case 'turn.completed':
      return true;
    case 'turn.failed':
      return hasString(value, 'error');
    case 'turn.cancelled':
      return true;
    default:
      return false;
  }
}
