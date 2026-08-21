import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../src/shared/domain.js';
import {
  buildModelProviderInput,
  createProviderDraft,
  createProviderOperationState,
  loadProviderDraft,
  providerDraftFingerprint,
  providerDraftValidationIssue,
} from '../src/renderer/providerForm.js';
import {
  clearAllModels,
  clearFilteredModels,
  filterCatalogModels,
  parseManualModelIds,
  selectAllModels,
  selectFilteredModels,
} from '../src/renderer/modelCatalogSelection.js';

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'provider-1', name: 'Saved', baseUrl: 'https://example.test/v1',
    protocol: 'openai-chat-completions', apiKeyConfigured: true, maxConcurrency: 2,
    requestTimeoutMs: 300_000, allowImages: false, toolCallingMode: 'native',
    thinkingMode: 'model-default', customHeaderNames: ['x-tenant'],
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider form state', () => {
  it('creates a blank provider draft instead of copying the selected provider', () => {
    expect(createProviderDraft()).toMatchObject({
      id: undefined, name: '', baseUrl: '', apiKey: '', protocol: 'openai-chat-completions',
    });
  });

  it('preserves saved credentials and headers when edit fields stay blank', () => {
    const input = buildModelProviderInput(loadProviderDraft(provider()));
    expect(input.apiKey).toBeUndefined();
    expect(input.customHeaders).toEqual({ 'x-tenant': '' });
  });

  it('validates custom JSON and fingerprints connection changes without exposing keys', () => {
    const draft = { ...createProviderDraft(), name: 'P', baseUrl: 'https://example.test/v1', apiKey: 'top-secret' };
    expect(providerDraftValidationIssue({ ...draft, customRequestBodyText: '{bad' })).toMatch(/JSON/i);
    const fingerprint = providerDraftFingerprint(draft);
    expect(fingerprint).not.toContain('top-secret');
    expect(fingerprint).not.toBe(providerDraftFingerprint({ ...draft, protocol: 'openai-responses' }));
  });

  it('reconstructs transient operation state as untested', () => {
    expect(createProviderOperationState()).toEqual({ discovery: 'idle', connection: 'untested' });
  });
});

describe('model catalog selection', () => {
  const all = ['qwen-max', 'deepseek-v4-pro', 'gpt-5'];

  it('selects or clears only search results without disturbing hidden selections', () => {
    expect([...selectFilteredModels(all, new Set(['gpt-5']), 'qwen')]).toEqual(['gpt-5', 'qwen-max']);
    expect([...clearFilteredModels(all, new Set(all), 'deepseek')]).toEqual(['qwen-max', 'gpt-5']);
  });

  it('supports complete selection and case-insensitive search while retaining exact IDs', () => {
    expect(filterCatalogModels(all, 'QWEN')).toEqual(['qwen-max']);
    expect([...selectAllModels(all)]).toEqual(all);
    expect([...clearAllModels()]).toEqual([]);
  });

  it('parses manual ids case-sensitively and removes only exact duplicates', () => {
    expect(parseManualModelIds('Qwen-Max, qwen-max\ndeepseek-v4-pro\nQwen-Max')).toEqual([
      'Qwen-Max', 'qwen-max', 'deepseek-v4-pro',
    ]);
  });
});
