import type { RuntimeModelProfile } from './database.js';
import type {
  ModelCapabilities,
  ModelReasoningSettings,
  ReasoningInputMode,
  ReasoningProtocol,
} from '../shared/domain.js';

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
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: {
      inputMode: effortOptions.length ? 'effort' : 'unsupported',
      effortOptions: [...new Set(effortOptions)],
      outputModes: effortOptions.length ? ['summary'] : [],
      defaultEffort: effortOptions.includes('medium') ? 'medium' : effortOptions[0],
    },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
  };
}

export function normalizeModelCapabilities(input: unknown, reasoningProtocol: ReasoningProtocol): ModelCapabilities {
  const value = asRecord(input);
  const reasoning = asRecord(value?.reasoning);

  if (!reasoning) {
    if (reasoningProtocol === 'qwen' && value?.reasoning === true) {
      return qwenCapabilities();
    }
    return unsupportedCapabilities(value);
  }

  const concurrency = asRecord(value?.concurrency);
  const usage = asRecord(value?.usage);
  const effortOptions = stringArray(reasoning.effortOptions);
  const outputModes = stringArray(reasoning.outputModes).filter(
    (mode): mode is 'raw' | 'summary' => mode === 'raw' || mode === 'summary',
  );
  const defaultEffort = nonEmptyString(reasoning.defaultEffort);

  return {
    text: booleanOr(value?.text, true),
    vision: booleanOr(value?.vision, false),
    longContext: booleanOr(value?.longContext, false),
    reasoning: {
      inputMode: reasoningInputMode(reasoning.inputMode),
      effortOptions,
      outputModes,
      defaultEffort: defaultEffort && effortOptions.includes(defaultEffort) ? defaultEffort : undefined,
    },
    concurrency: {
      defaultLimit: positiveIntegerOr(concurrency?.defaultLimit, 1),
      configurable: booleanOr(concurrency?.configurable, true),
      maxLimit: positiveIntegerOr(concurrency?.maxLimit, 32),
    },
    streaming: booleanOr(value?.streaming, true),
    usage: {
      tokens: booleanOr(usage?.tokens, true),
      reasoningTokens: booleanOr(usage?.reasoningTokens, true),
    },
  };
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

export function validateReasoningSelection(profile: RuntimeModelProfile): void {
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

  const effort = profile.reasoning.effort;
  if (!effort) {
    throw new Error(`Model profile "${profile.name}" requires a reasoning effort`);
  }
  if (!effortOptions.includes(effort)) {
    throw new Error(`Model profile "${profile.name}" does not support reasoning effort "${effort}"`);
  }
}

function unsupportedCapabilities(value: Record<string, unknown> | undefined): ModelCapabilities {
  const usage = asRecord(value?.usage);
  const legacyStreamingUsage = typeof value?.streamingUsage === 'boolean' ? value.streamingUsage : undefined;
  return {
    text: booleanOr(value?.text, true),
    vision: booleanOr(value?.vision, false),
    longContext: booleanOr(value?.longContext, false),
    reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: [] },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: booleanOr(value?.streaming, legacyStreamingUsage ?? true),
    usage: {
      tokens: booleanOr(usage?.tokens, legacyStreamingUsage ?? true),
      reasoningTokens: booleanOr(usage?.reasoningTokens, legacyStreamingUsage ?? true),
    },
  };
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
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function reasoningInputMode(value: unknown): ReasoningInputMode {
  return value === 'toggle' || value === 'effort' || value === 'custom' ? value : 'unsupported';
}
