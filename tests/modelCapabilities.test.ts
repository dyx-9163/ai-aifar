import { describe, expect, it } from 'vitest';
import type { RuntimeModelProfile } from '../src/agent/database';
import {
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

  it('preserves arbitrary declared effort values', () => {
    const capabilities = openAiCapabilities(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(normalizeReasoningSettings(
      { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'summary' },
      capabilities,
    ).effort).toBe('max');
  });

  it('rejects an effort that the profile does not declare', () => {
    const profile = profileFixture({ effortOptions: ['low', 'medium', 'high'], effort: 'max' });
    expect(() => validateReasoningSelection(profile)).toThrow('does not support reasoning effort "max"');
  });

  it('bounds profile concurrency by the declared capability limit', () => {
    expect(normalizeMaxConcurrency(99, qwenCapabilities())).toBe(32);
    expect(normalizeMaxConcurrency(0, qwenCapabilities())).toBe(1);
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
    responseSpeed: 'standard',
    isDefault: true,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}
