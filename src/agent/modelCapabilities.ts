import type { RuntimeModelProfile } from './database.js';
import type {
  ModelCapabilities,
  ModelCapabilitiesInput,
  ModelReasoningSettings,
  ReasoningInputMode,
  ReasoningProtocol,
} from '../shared/domain.js';
import { reasoningConfigurationIssue, type ReasoningConfigurationIssue } from '../shared/reasoningConfiguration.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../shared/modelProfileLimits.js';

export { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../shared/modelProfileLimits.js';

export function qwenCapabilities(): ModelCapabilities {
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
  };
}

export function openAiCapabilities(effortOptions: string[] = []): ModelCapabilities {
  const declaredEffortOptions = [...new Set(effortOptions.filter(hasNonWhitespaceText))];
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: {
      inputMode: declaredEffortOptions.length ? 'effort' : 'unsupported',
      effortOptions: declaredEffortOptions,
      outputModes: declaredEffortOptions.length ? ['summary'] : [],
      defaultEffort: declaredEffortOptions.includes('medium') ? 'medium' : declaredEffortOptions[0],
    },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
  };
}

export function normalizeModelCapabilities(input: unknown, reasoningProtocol: ReasoningProtocol): ModelCapabilities {
  const value = asRecord(input);
  const reasoning = asRecord(value?.reasoning);
  const concurrency = asRecord(value?.concurrency);
  const usage = asRecord(value?.usage);
  const legacyStreamingUsage = typeof value?.streamingUsage === 'boolean' ? value.streamingUsage : undefined;
  const normalizedReasoning = reasoning
    ? normalizeReasoningCapabilities(reasoning)
    : reasoningProtocol === 'qwen' && value?.reasoning === true
      ? qwenCapabilities().reasoning
      : unsupportedReasoningCapabilities();

  return {
    text: booleanOr(value?.text, true),
    vision: booleanOr(value?.vision, false),
    longContext: booleanOr(value?.longContext, false),
    reasoning: normalizedReasoning,
    concurrency: {
      defaultLimit: positiveIntegerOr(concurrency?.defaultLimit, 1),
      configurable: booleanOr(concurrency?.configurable, true),
      maxLimit: positiveIntegerOr(concurrency?.maxLimit, 32),
    },
    streaming: booleanOr(value?.streaming, legacyStreamingUsage ?? true),
    usage: {
      tokens: booleanOr(usage?.tokens, legacyStreamingUsage ?? true),
      reasoningTokens: booleanOr(usage?.reasoningTokens, legacyStreamingUsage ?? true),
    },
  };
}

export function normalizeProfileCapabilities(
  input: ModelCapabilitiesInput | undefined,
  existing: ModelCapabilities | undefined,
  reasoningProtocol: ReasoningProtocol,
): ModelCapabilities {
  if (!existing || !input) {
    return normalizeModelCapabilities(input ?? existing, reasoningProtocol);
  }

  return normalizeModelCapabilities({
    ...existing,
    ...input,
    reasoning: { ...existing.reasoning, ...input.reasoning },
    concurrency: { ...existing.concurrency, ...input.concurrency },
    usage: { ...existing.usage, ...input.usage },
  }, reasoningProtocol);
}

export function normalizeReasoningSettings(
  input: Partial<ModelReasoningSettings> | undefined,
  capabilities: ModelCapabilities,
): ModelReasoningSettings {
  return {
    mode: input?.mode === 'auto' || input?.mode === 'enabled' || input?.mode === 'disabled' ? input.mode : 'disabled',
    protocol:
      input?.protocol === 'qwen' || input?.protocol === 'openai' || input?.protocol === 'custom' ? input.protocol : 'none',
    effort: nonEmptyString(input?.effort) ?? capabilities.reasoning.defaultEffort,
    display: input?.display === 'raw' || input?.display === 'summary' ? input.display : 'auto',
  };
}

export function normalizeMaxConcurrency(value: unknown, capabilities: ModelCapabilities): number {
  const maxLimit = capabilities.concurrency.maxLimit ?? 32;
  const fallback = capabilities.concurrency.defaultLimit;
  const normalized = positiveIntegerOr(value, fallback);
  return Math.min(maxLimit, Math.max(1, normalized));
}

export function normalizeMaxOutputTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.min(value, MAX_OUTPUT_TOKENS);
}

export function validateReasoningSelection(profile: RuntimeModelProfile): void {
  const issue = reasoningConfigurationIssue({
    inputMode: profile.capabilities.reasoning.inputMode,
    protocol: profile.reasoning.protocol,
    mode: profile.reasoning.mode,
  });
  if (issue) {
    throw new Error(`Model profile "${profile.name}" ${reasoningConfigurationMessage(issue)}`);
  }
  if (profile.reasoning.mode === 'disabled') {
    return;
  }

  const { inputMode, effortOptions } = profile.capabilities.reasoning;
  if (inputMode === 'unsupported') {
    throw new Error(`Model profile "${profile.name}" does not support reasoning`);
  }
  if (inputMode !== 'effort') {
    return;
  }

  const effort = nonEmptyString(profile.reasoning.effort);
  if (!effort) {
    throw new Error(`Model profile "${profile.name}" requires a reasoning effort`);
  }
  if (!effortOptions.includes(effort)) {
    throw new Error(`Model profile "${profile.name}" does not support reasoning effort "${effort}"`);
  }
}

function normalizeReasoningCapabilities(reasoning: Record<string, unknown>): ModelCapabilities['reasoning'] {
  const effortOptions = stringArray(reasoning.effortOptions);
  const outputModes = stringArray(reasoning.outputModes).filter(
    (mode): mode is 'raw' | 'summary' => mode === 'raw' || mode === 'summary',
  );
  const defaultEffort = nonEmptyString(reasoning.defaultEffort);
  return {
    inputMode: reasoningInputMode(reasoning.inputMode),
    effortOptions,
    outputModes,
    defaultEffort: defaultEffort && effortOptions.includes(defaultEffort) ? defaultEffort : undefined,
  };
}

function unsupportedReasoningCapabilities(): ModelCapabilities['reasoning'] {
  return { inputMode: 'unsupported', effortOptions: [], outputModes: [] };
}

function reasoningConfigurationMessage(issue: ReasoningConfigurationIssue): string {
  if (issue === 'toggleRequiresQwen') return 'toggle reasoning requires the qwen protocol';
  if (issue === 'effortRequiresOpenAi') return 'effort reasoning requires the openai protocol';
  if (issue === 'customUnsupported') return 'custom reasoning is not implemented';
  return 'does not support enabled reasoning input';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return hasNonWhitespaceText(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(hasNonWhitespaceText)
    : [];
}

function hasNonWhitespaceText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reasoningInputMode(value: unknown): ReasoningInputMode {
  return value === 'toggle' || value === 'effort' || value === 'custom' ? value : 'unsupported';
}
