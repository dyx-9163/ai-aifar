import { describe, expect, it, vi } from 'vitest';
import type { RuntimeModelProfile } from '../src/agent/database';
import { qwenCapabilities } from '../src/agent/modelCapabilities';
import { inspectModelConnection } from '../src/agent/modelConnection';

const subject: RuntimeModelProfile = {
  id: 'local-qwen35',
  name: 'Local Qwen3.5-9B',
  provider: 'openai-compatible',
  deploymentType: 'private',
  runtimeType: 'llama.cpp',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'Qwen3.5-9B',
  apiKeyConfigured: false,
  capabilities: qwenCapabilities(),
  reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
  maxConcurrency: 1,
  maxOutputTokens: 2048,
  responseSpeed: 'standard',
  isDefault: true,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

describe('model connection inspection', () => {
  it('treats cloud concurrency as provider-managed without probing llama.cpp slots', async () => {
    const cloudProfile = {
      ...subject,
      deploymentType: 'cloud',
      runtimeType: 'openai-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
      maxConcurrency: 6,
    } as RuntimeModelProfile;
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'qwen3.8-max' }] }));

    await expect(inspectModelConnection(cloudProfile, fetchImpl, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: 'provider-managed',
      model: 'qwen3.8-max',
      clientConcurrency: 6,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('adopts the detected llama.cpp slot count as client concurrency', async () => {
    const privateLlamaProfile = {
      ...subject,
      deploymentType: 'private',
      runtimeType: 'llama.cpp',
      maxConcurrency: 1,
    } as RuntimeModelProfile;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockResolvedValueOnce(Response.json([{ id: 0 }, { id: 1 }]));

    await expect(inspectModelConnection(privateLlamaProfile, fetchImpl, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: 'connected',
      clientConcurrency: 2,
      serviceSlots: 2,
    });
  });

  it('uses safe concurrency one when llama.cpp slots cannot be inspected', async () => {
    const privateLlamaProfile = {
      ...subject,
      deploymentType: 'private',
      runtimeType: 'llama.cpp',
      maxConcurrency: 8,
    } as RuntimeModelProfile;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(inspectModelConnection(privateLlamaProfile, fetchImpl, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: 'slots-unverified',
      clientConcurrency: 1,
    });
  });

  it('uses safe concurrency one for private runtimes without a supported concurrency probe', async () => {
    const privateCompatibleProfile = {
      ...subject,
      deploymentType: 'private',
      runtimeType: 'openai-compatible',
      maxConcurrency: 8,
    } as RuntimeModelProfile;
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }));

    await expect(inspectModelConnection(privateCompatibleProfile, fetchImpl, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: 'slots-unverified',
      clientConcurrency: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires the exact configured model and verifies matching service slots', async () => {
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }, { id: 'another-model' }] }))
      .mockResolvedValueOnce(Response.json([{ id: 0 }]));

    await expect(inspectModelConnection(subject, fetchImpl, signal)).resolves.toMatchObject({
      ok: true,
      status: 'connected',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
      serviceSlots: 1,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8080/v1/models', {
      headers: {},
      signal,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/slots', {
      headers: {},
      signal,
    });
  });

  it('replaces stale client concurrency when the service slot count changes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockResolvedValueOnce(Response.json([{ id: 0 }, { id: 1 }]));

    await expect(inspectModelConnection(subject, fetchImpl, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: 'connected',
      model: 'Qwen3.5-9B',
      clientConcurrency: 2,
      serviceSlots: 2,
      message: expect.stringMatching(/detected 2 llama\.cpp service slots/i),
    });
  });

  it('returns a typed mismatch for a case-only model identifier difference', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ data: [{ id: 'qwen3.5-9b' }, { id: 'other-model' }] }),
    );

    await expect(inspectModelConnection(subject, fetchImpl, new AbortController().signal)).resolves.toEqual({
      ok: false,
      status: 'model-mismatch',
      message: 'Configured model is not advertised by the model endpoint.',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps mismatch failure messages fixed and bounded for an arbitrary configured model identifier', async () => {
    const configuredModel = `private-${'m'.repeat(4_096)}`;
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'other-model' }] }));

    const result = await inspectModelConnection(
      { ...subject, model: configuredModel },
      fetchImpl,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'model-mismatch',
      message: 'Configured model is not advertised by the model endpoint.',
      model: configuredModel,
    });
    expect(result.message).not.toContain(configuredModel);
    expect(result.message.length).toBeLessThan(80);
  });

  it.each([
    ['missing data', {}],
    ['non-array data', { data: { id: 'Qwen3.5-9B' } }],
    ['model without a string id', { data: [{ id: 9 }] }],
  ])('returns a bounded offline result for malformed model metadata: %s', async (_case, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(body));

    await expect(inspectModelConnection(subject, fetchImpl, new AbortController().signal)).resolves.toEqual({
      ok: false,
      status: 'offline',
      message: 'Model endpoint returned unusable model metadata.',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
    });
  });

  it('reports an unavailable model endpoint without inspecting response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('secret provider diagnostic', { status: 503 }));

    const result = await inspectModelConnection(subject, fetchImpl, new AbortController().signal);

    expect(result).toEqual({
      ok: false,
      status: 'offline',
      message: 'Model endpoint is unavailable (HTTP 503).',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
    });
    expect(result.message).not.toContain('secret provider diagnostic');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP failure', async () => new Response(null, { status: 404 })],
    ['transport failure', async () => { throw new Error('slots offline'); }],
    ['invalid JSON', async () => new Response('not-json')],
    ['non-array JSON', async () => Response.json({ slots: [] })],
    ['zero slots', async () => Response.json([])],
    ['duplicate slot identifiers', async () => Response.json([{ id: 0 }, { id: 0 }])],
  ])('keeps model connectivity when slots have an %s', async (_case, slotsResponse) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockImplementationOnce(slotsResponse);

    const result = await inspectModelConnection(subject, fetchImpl, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      status: 'slots-unverified',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
      message: expect.stringMatching(/slot concurrency could not be verified/i),
    });
    expect(result).not.toHaveProperty('serviceSlots');
  });

  it('returns a bounded offline result without API-key representations from model transport errors', async () => {
    const apiKey = ['connection-key-', '"', '\\', '?/'].join('');
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error(`transport key=${apiKey} escaped=${JSON.stringify(apiKey).slice(1, -1)} encoded=${encodeURIComponent(apiKey)}`),
    );

    const result = await inspectModelConnection(
      { ...subject, apiKey, apiKeyConfigured: true },
      fetchImpl,
      new AbortController().signal,
    );
    const message = result.message;

    expect(result).toMatchObject({ ok: false, status: 'offline', model: 'Qwen3.5-9B' });
    expect(message).toBe('Model endpoint is unavailable.');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(JSON.stringify(apiKey).slice(1, -1));
    expect(message).not.toContain(encodeURIComponent(apiKey));
  });

  it('does not downgrade cancellation during model discovery', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      init?.signal?.throwIfAborted();
      return Response.json({ data: [] });
    });

    await expect(inspectModelConnection(subject, fetchImpl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not downgrade cancellation while model metadata is being read', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        controller.signal.throwIfAborted();
      },
    } as Response);

    await expect(inspectModelConnection(subject, fetchImpl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not downgrade cancellation during slot inspection', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        init?.signal?.throwIfAborted();
        return Response.json([]);
      });

    await expect(inspectModelConnection(subject, fetchImpl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not return a slot success when fetch resolves after cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        return Response.json([{ id: 0 }]);
      });

    await expect(inspectModelConnection(subject, fetchImpl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not return a slot success when JSON resolves after cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          controller.abort(new DOMException('cancelled', 'AbortError'));
          return [{ id: 0 }];
        },
      } as Response);

    await expect(inspectModelConnection(subject, fetchImpl, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects promptly when slot fetch ignores an explicit abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
      .mockImplementationOnce(async () => new Promise<Response>(() => undefined));
    const inspection = inspectModelConnection(subject, fetchImpl, controller.signal);

    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(inspection).rejects.toMatchObject({ name: 'AbortError' });
  });
});
