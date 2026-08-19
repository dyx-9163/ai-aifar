import { describe, expect, it } from 'vitest';
import type { RuntimeModelProfile } from '../src/agent/database';
import {
  normalizeMaxOutputTokens,
  normalizeModelCapabilities,
  normalizeMaxConcurrency,
  normalizeReasoningSettings,
  openAiCapabilities,
  qwenCapabilities,
  validateReasoningSelection,
} from '../src/agent/modelCapabilities';

describe('model capabilities', () => {
  it('migrates an explicit legacy qwen profile without guessing from its name', () => {
    const capabilities = normalizeModelCapabilities(
      { reasoning: true, streamingUsage: true } as never,
      'qwen',
    );
    expect(capabilities.reasoning).toEqual({
      inputMode: 'toggle', effortOptions: [], outputModes: ['raw'],
    });
    expect(capabilities.concurrency.defaultLimit).toBe(1);
  });

  it('normalizes a missing reasoning subsection without replacing independent declarations', () => {
    const capabilities = normalizeModelCapabilities({
      text: false,
      vision: true,
      longContext: true,
      concurrency: { defaultLimit: 4, configurable: false, maxLimit: 8 },
      streaming: false,
      usage: { tokens: false, reasoningTokens: false },
    }, 'none');

    expect(capabilities).toEqual({
      text: false,
      vision: true,
      longContext: true,
      reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: [] },
      concurrency: { defaultLimit: 4, configurable: false, maxLimit: 8 },
      streaming: false,
      usage: { tokens: false, reasoningTokens: false },
    });
  });

  it('completes legacy qwen reasoning without replacing unrelated declarations', () => {
    const capabilities = normalizeModelCapabilities({
      text: false,
      vision: true,
      longContext: true,
      reasoning: true,
      concurrency: { defaultLimit: 3, configurable: false, maxLimit: 6 },
      streaming: false,
      usage: { tokens: false, reasoningTokens: false },
    }, 'qwen');

    expect(capabilities).toEqual({
      text: false,
      vision: true,
      longContext: true,
      reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
      concurrency: { defaultLimit: 3, configurable: false, maxLimit: 6 },
      streaming: false,
      usage: { tokens: false, reasoningTokens: false },
    });
  });

  it('preserves arbitrary declared effort values', () => {
    const capabilities = openAiCapabilities(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(normalizeReasoningSettings(
      { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'summary' },
      capabilities,
    ).effort).toBe('max');
  });

  it('ignores whitespace-only declared effort values', () => {
    expect(openAiCapabilities(['   ', 'max']).reasoning).toEqual({
      inputMode: 'effort', effortOptions: ['max'], outputModes: ['summary'], defaultEffort: 'max',
    });
    expect(openAiCapabilities(['\t']).reasoning).toEqual({
      inputMode: 'unsupported', effortOptions: [], outputModes: [], defaultEffort: undefined,
    });
  });

  it('rejects an effort that the profile does not declare', () => {
    const profile = profileFixture({ effortOptions: ['low', 'medium', 'high'], effort: 'max' });
    expect(() => validateReasoningSelection(profile)).toThrow('does not support reasoning effort "max"');
  });

  it('treats a whitespace-only selected effort as missing', () => {
    const profile = profileFixture({ effortOptions: ['low'], effort: '   ' });
    expect(() => validateReasoningSelection(profile)).toThrow('requires a reasoning effort');
  });

  it.each([
    {
      name: 'toggle with the OpenAI provider label',
      inputMode: 'toggle' as const,
      protocol: 'openai' as const,
    },
    {
      name: 'effort with the Qwen provider label',
      inputMode: 'effort' as const,
      protocol: 'qwen' as const,
    },
    {
      name: 'a custom request body',
      inputMode: 'custom' as const,
      protocol: 'custom' as const,
    },
  ])('allows $name because request format is configured independently', ({ inputMode, protocol }) => {
    const valid: RuntimeModelProfile = {
      ...profileFixture({ effortOptions: ['low'], effort: 'low' }),
      capabilities: {
        ...openAiCapabilities(['low']),
        reasoning: {
          inputMode,
          effortOptions: inputMode === 'effort' ? ['low'] : [],
          outputModes: [],
          customRequestBody: inputMode === 'custom' ? { extra_body: { thinking: true } } : undefined,
        } as never,
      },
      reasoning: { mode: 'enabled', protocol, effort: 'low', display: 'auto' },
    };

    expect(() => validateReasoningSelection(valid)).not.toThrow();
  });

  it('rejects an enabled control profile with no request parameter format', () => {
    const invalid: RuntimeModelProfile = {
      ...profileFixture({ effortOptions: ['low'], effort: 'low' }),
      capabilities: {
        ...openAiCapabilities(['low']),
        reasoning: {
          inputMode: 'unsupported',
          effortOptions: [],
          outputModes: [],
        },
      },
      reasoning: { mode: 'enabled', protocol: 'none', effort: 'low', display: 'auto' },
    };

    expect(() => validateReasoningSelection(invalid)).toThrow('does not support enabled reasoning input');
  });

  it('bounds profile concurrency by the declared capability limit', () => {
    expect(normalizeMaxConcurrency(99, qwenCapabilities())).toBe(32);
    expect(normalizeMaxConcurrency(0, qwenCapabilities())).toBe(1);
  });

  it.each([
    [undefined, 8192],
    [0, 8192],
    [-1, 8192],
    [1.5, 8192],
    ['2048', 8192],
    [1, 1],
    [4096, 4096],
    [32769, 32768],
  ])('normalizes output limit %s to %s', (value, expected) => {
    expect(normalizeMaxOutputTokens(value)).toBe(expected);
  });
});

function profileFixture(input: { effortOptions: string[]; effort: string }): RuntimeModelProfile {
  const capabilities = openAiCapabilities(input.effortOptions);
  return {
    id: 'model-1',
    name: 'Fixture model',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'fixture-model',
    apiKeyConfigured: false,
    capabilities,
    reasoning: { mode: 'enabled', protocol: 'openai', effort: input.effort, display: 'summary' },
    maxConcurrency: 1,
    maxOutputTokens: 2048,
    responseSpeed: 'standard',
    isDefault: true,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}
