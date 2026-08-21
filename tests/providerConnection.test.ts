import { describe, expect, it, vi } from 'vitest';
import type { RuntimeModelProvider } from '../src/agent/database.js';
import { testProviderConnection } from '../src/agent/providerConnection.js';

function provider(overrides: Partial<RuntimeModelProvider> = {}): RuntimeModelProvider {
  return {
    id: 'provider-1', name: 'Manual provider', baseUrl: 'https://example.test/v1',
    protocol: 'openai-chat-completions', apiKey: 'secret', apiKeyConfigured: true,
    maxConcurrency: 1, requestTimeoutMs: 30_000, allowImages: false,
    toolCallingMode: 'native', thinkingMode: 'model-default', customHeaderNames: [],
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider inference connection test', () => {
  it('tests a manually entered model independently from catalog support', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await expect(testProviderConnection(
      provider(), 'manual-model', fetchImpl, new AbortController().signal,
    )).resolves.toMatchObject({ ok: true, status: 'connected', model: 'manual-model' });
  });

  it('returns a stable authentication status without exposing secrets', async () => {
    const result = await testProviderConnection(
      provider({ customHeaders: { 'x-private': 'header-secret' } }),
      'manual-model',
      async () => new Response('secret header-secret', { status: 401 }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, status: 'authentication-failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('header-secret');
  });
});
