import { describe, expect, it, vi } from 'vitest';
import type { RuntimeModelProvider } from '../src/agent/database.js';
import {
  MAX_MODEL_CATALOG_BYTES,
  discoverProviderModels,
  providerEndpoint,
} from '../src/agent/providerCatalog.js';

function runtimeProvider(overrides: Partial<RuntimeModelProvider> = {}): RuntimeModelProvider {
  return {
    id: 'provider-1',
    name: 'Test provider',
    baseUrl: 'https://example.test/v1',
    protocol: 'openai-chat-completions',
    apiKey: 'secret-key',
    apiKeyConfigured: true,
    maxConcurrency: 2,
    requestTimeoutMs: 30_000,
    allowImages: false,
    toolCallingMode: 'native',
    thinkingMode: 'model-default',
    customHeaderNames: [],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider model catalog', () => {
  it('preserves compatible-mode/v1 and normalizes exact case-sensitive model ids', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      data: [{ id: 'deepseek-v4-pro' }, { id: 'Qwen-Max' }, { id: 'deepseek-v4-pro' }, { id: 'qwen-max' }],
    }));
    const result = await discoverProviderModels(
      runtimeProvider({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' }),
      fetchImpl,
      new AbortController().signal,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }) }),
    );
    expect(result).toEqual({
      status: 'available',
      models: ['deepseek-v4-pro', 'Qwen-Max', 'qwen-max'],
    });
  });

  it('treats an absent catalog as a manual-entry warning', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    await expect(discoverProviderModels(runtimeProvider(), fetchImpl, new AbortController().signal))
      .resolves.toMatchObject({ status: 'unsupported', models: [] });
  });

  it('supports custom catalog paths and Anthropic authentication', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ models: [{ name: 'claude-sonnet' }] }));
    await discoverProviderModels(runtimeProvider({
      protocol: 'anthropic-messages',
      catalogPath: 'catalog/models',
      customHeaders: { 'x-tenant': 'private-tenant' },
    }), fetchImpl, new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/v1/catalog/models', expect.objectContaining({
      headers: expect.objectContaining({
        'x-api-key': 'secret-key',
        'anthropic-version': '2023-06-01',
        'x-tenant': 'private-tenant',
      }),
    }));
  });

  it('rejects malformed, oversized, and overpopulated catalogs', async () => {
    const signal = new AbortController().signal;
    await expect(discoverProviderModels(runtimeProvider(), async () => Response.json({ nope: [] }), signal))
      .rejects.toThrow('valid model list');
    await expect(discoverProviderModels(
      runtimeProvider(),
      async () => new Response('x'.repeat(MAX_MODEL_CATALOG_BYTES + 1)),
      signal,
    )).rejects.toThrow('too large');
    await expect(discoverProviderModels(
      runtimeProvider(),
      async () => Response.json({ data: Array.from({ length: 10_001 }, (_, index) => ({ id: `m-${index}` })) }),
      signal,
    )).rejects.toThrow('too many');
  });

  it('propagates caller cancellation and enforces a provider-independent discovery timeout', async () => {
    const cancelled = new AbortController();
    cancelled.abort(new DOMException('cancelled', 'AbortError'));
    await expect(discoverProviderModels(runtimeProvider(), async (_url, init) => {
      throw init?.signal?.reason;
    }, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });

    vi.useFakeTimers();
    try {
      const pending = expect(discoverProviderModels(
        runtimeProvider(),
        () => new Promise(() => undefined),
        new AbortController().signal,
      )).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(15_001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts provider secrets from remote errors', async () => {
    await expect(discoverProviderModels(
      runtimeProvider({ customHeaders: { 'x-private': 'header-secret' } }),
      async () => new Response('secret-key header-secret', { status: 500 }),
      new AbortController().signal,
    )).rejects.toSatisfy((error: Error) =>
      !error.message.includes('secret-key') && !error.message.includes('header-secret'));
  });

  it('normalizes endpoint joins without dropping base path segments', () => {
    expect(providerEndpoint('https://example.test/root/v1/', '/models')).toBe('https://example.test/root/v1/models');
  });
});
