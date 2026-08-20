import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatMessages } from '../src/agent/chatContext';
import { compressedInitialRequestMessages, streamChatCompletion, testModelProfile, type ModelStreamHandlers } from '../src/agent/modelProvider';
import type { RuntimeModelProfile } from '../src/agent/database';

const profile: RuntimeModelProfile = {
  id: 'model-1',
  name: 'AIFAR Qwen',
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'Qwen3.5-9B',
  apiKey: 'local-not-used',
  apiKeyConfigured: true,
  capabilities: {
    text: true,
    vision: false,
    longContext: false,
    reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: [] },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
    streaming: true,
    usage: { tokens: false, reasoningTokens: false },
  },
  reasoning: { mode: 'disabled', protocol: 'none', effort: 'medium', display: 'auto' },
  maxConcurrency: 1,
  maxOutputTokens: 2048,
  responseSpeed: 'standard',
  isDefault: true,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const ignoreHandlers: ModelStreamHandlers = {
  onAnswerDelta: () => undefined,
  onRawReasoningDelta: () => undefined,
  onReasoningSummaryDelta: () => undefined,
  onPhase: () => undefined,
};

describe('OpenAI-compatible model provider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never surfaces provider body text or API-key representations in an HTTP error', async () => {
    const specialKey = ['unit-key-', '"', '\\', '?/'].join('');
    const echoedPrompt = 'private prompt that must not escape';
    const echoedResponse = 'private response that must not escape';
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
      error: {
        message: `request rejected for ${specialKey}; prompt=${echoedPrompt}; response=${echoedResponse}`,
        code: 'authentication_failed',
      },
      provider_internal_diagnostic: specialKey,
    }), { status: 401 });

    const error = await streamChatCompletion(
      { ...profile, apiKey: specialKey },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    ).then(() => undefined, (caught: unknown) => caught);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toBe('Model request was rejected (HTTP 401). Check the profile credentials.');
    expect(message).not.toContain(echoedPrompt);
    expect(message).not.toContain(echoedResponse);
    expect(message).not.toContain('provider_internal_diagnostic');
    expect(containsSecretRepresentation(message, specialKey)).toBe(false);
    expect(message.length).toBeLessThanOrEqual(96);
  });

  it('maps a bounded structured context rejection to fixed new-chat guidance', async () => {
    const echoedPrompt = 'confidential context payload';
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
      error: {
        type: 'exceed_context_size_error',
        code: 'context_length_exceeded',
        message: echoedPrompt,
      },
    }), { status: 400 });

    await expect(streamChatCompletion(
      profile,
      [{ role: 'user', content: echoedPrompt }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Model request exceeds the available context. Start a new chat or lower the history limit.');
      expect(message).not.toContain(echoedPrompt);
      return true;
    });
  });

  it('bounds provider diagnostic reads before mapping an HTTP error', async () => {
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('private-response-body'.repeat(512)));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const fetchImpl = async (): Promise<Response> => ({
      ok: false,
      status: 500,
      body,
      text: async () => { throw new Error('unbounded response.text() must not be used'); },
    }) as Response;

    await expect(streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('Model service failed to process the request (HTTP 500).');
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancellations).toBe(1);
  });

  it('returns typed offline when connection testing times out and fetch ignores abort', async () => {
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const completion = testModelProfile(profile, fetchImpl, 20);

    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then((result) => ({ type: 'completed' as const, result })),
      new Promise<{ type: 'timed-out' }>((resolve) => {
        guard = setTimeout(() => resolve({ type: 'timed-out' }), 125);
      }),
    ]);
    if (guard) clearTimeout(guard);
    resolveFetch(new Response(null, { status: 200 }));
    if (outcome.type === 'timed-out') await completion;

    expect(outcome).toMatchObject({
      type: 'completed',
      result: {
        ok: false,
        status: 'offline',
        message: 'Model connection test timed out after 20ms.',
        model: 'Qwen3.5-9B',
        clientConcurrency: 1,
      },
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('returns exact-model and slot diagnostics through the bounded connection wrapper', async () => {
    const signalInputs: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signalInputs.push(init?.signal);
      return signalInputs.length === 1
        ? Response.json({ data: [{ id: 'Qwen3.5-9B' }] })
        : Response.json([{ id: 0 }, { id: 1 }]);
    };

    await expect(testModelProfile(profile, fetchImpl, 100)).resolves.toMatchObject({
      ok: true,
      status: 'concurrency-warning',
      model: 'Qwen3.5-9B',
      clientConcurrency: 1,
      serviceSlots: 2,
    });
    expect(signalInputs).toHaveLength(2);
    expect(signalInputs[0]).toBe(signalInputs[1]);
  });

  it('returns typed offline without encoded API-key forms for connection-test transport errors', async () => {
    const specialKey = ['connection-key-', '"', '\\', '?/'].join('');
    const fetchImpl = async (): Promise<Response> => {
      throw new Error(`transport escaped=${JSON.stringify(specialKey).slice(1, -1)} encoded=${encodeURIComponent(specialKey)}`);
    };

    const result = await testModelProfile({ ...profile, apiKey: specialKey }, fetchImpl);
    const message = result.message;

    expect(result).toMatchObject({ ok: false, status: 'offline', model: 'Qwen3.5-9B' });
    expect(containsSecretRepresentation(message, specialKey)).toBe(false);
  });

  it('redacts encoded API-key forms from streaming transport errors', async () => {
    const specialKey = ['stream-key-', '"', '\\', '?/'].join('');
    const fetchImpl = async (): Promise<Response> => {
      throw new Error(`stream escaped=${JSON.stringify(specialKey).slice(1, -1)} encoded=${encodeURIComponent(specialKey)}`);
    };

    const error = await streamChatCompletion(
      { ...profile, apiKey: specialKey },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    ).then(() => undefined, (caught: unknown) => caught);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('stream');
    expect(containsSecretRepresentation(message, specialKey)).toBe(false);
  });

  it('hard-times out the whole model run when fetch ignores abort', async () => {
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    };
    const completion = streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
      () => Date.now(),
      20,
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then(
        () => ({ type: 'completed' as const }),
        (error: unknown) => ({ type: 'rejected' as const, error }),
      ),
      new Promise<{ type: 'guard-expired' }>((resolve) => {
        guard = setTimeout(() => resolve({ type: 'guard-expired' }), 125);
      }),
    ]);
    if (guard) clearTimeout(guard);
    resolveFetch(new Response('data: [DONE]\n\n', { status: 200 }));
    if (outcome.type === 'guard-expired') {
      await completion.catch(() => undefined);
    }

    expect(outcome).toMatchObject({
      type: 'rejected',
      error: expect.objectContaining({ message: 'Model request timed out after 20ms.' }),
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('uses a longer default timeout for local Qwen reasoning runs', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    };
    const completion = streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
          usage: { tokens: true, reasoningTokens: true },
        },
        reasoning: { mode: 'enabled', protocol: 'qwen', display: 'raw' },
      },
      [{ role: 'user', content: 'generate a full HTML, CSS, and JS page' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 1);
    expect(requestSignal?.aborted).toBe(false);

    resolveFetch(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    await expect(completion).resolves.toMatchObject({ reasoningRequested: 'enabled' });
  });

  it('stops at the DONE sentinel and releases a provider stream that remains open', async () => {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        ));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const fetchImpl = async (): Promise<Response> =>
      new Response(body as unknown as BodyInit, { status: 200 });
    const completion = streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then(() => 'completed' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), 75);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timed-out') {
      sourceController.close();
      await completion;
    }

    expect(outcome).toBe('completed');
    expect(cancelCalls).toBe(1);
  });

  it('does not wait for a provider reader cancel that never settles', async () => {
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        ));
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const completion = streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      async () => new Response(body as unknown as BodyInit, { status: 200 }),
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then(() => 'completed' as const),
      new Promise<'guard-expired'>((resolve) => {
        guard = setTimeout(() => resolve('guard-expired'), 75);
      }),
    ]);
    if (guard) clearTimeout(guard);

    expect(outcome).toBe('completed');
    expect(cancelCalls).toBe(1);
  });

  it('times out a model stream that never produces another chunk and releases its reader', async () => {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const fetchImpl = async (): Promise<Response> =>
      new Response(body as unknown as BodyInit, { status: 200 });
    const completion = streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
      () => Date.now(),
      20,
    );

    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then(
        () => ({ type: 'completed' as const }),
        (error: unknown) => ({ type: 'rejected' as const, error }),
      ),
      new Promise<{ type: 'timed-out' }>((resolve) => {
        guard = setTimeout(() => resolve({ type: 'timed-out' }), 125);
      }),
    ]);
    if (guard) clearTimeout(guard);
    if (outcome.type === 'timed-out') {
      sourceController.close();
      await completion;
    }

    expect(outcome).toMatchObject({
      type: 'rejected',
      error: expect.objectContaining({ message: 'Model request timed out after 20ms.' }),
    });
    expect(cancelCalls).toBe(1);
  });

  it('streams answer deltas without inventing reasoning parameters for an unsupported profile', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(
        ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };
    const deltas: string[] = [];

    const metrics = await streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => deltas.push(delta) },
      new AbortController().signal,
      fetchImpl,
      () => 1_000,
    );

    expect(deltas).toEqual(['Hi', ' there']);
    expect(metrics).toMatchObject({
      reasoningRequested: 'disabled',
      reasoningProtocol: 'none',
      reasoningObserved: false,
      responseSpeed: 'standard',
      speedSource: 'unavailable',
      usageSource: 'unavailable',
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect((requests[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer local-not-used');
    expect(JSON.parse(String(requests[0]?.init.body)).chat_template_kwargs).toBeUndefined();
  });

  it.each([
    ['enabled', true],
    ['disabled', false],
  ] as const)('maps qwen toggle mode %s to enable_thinking=%s', async (mode, enableThinking) => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode, protocol: 'qwen', effort: 'medium', display: 'auto' },
        maxOutputTokens: 3072,
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      model: 'Qwen3.5-9B',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      temperature: 0.2,
      max_tokens: 3072,
      chat_template_kwargs: { enable_thinking: enableThinking },
    });
  });

  it('sends toggle reasoning controls by request format without requiring the Qwen provider label', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'openai', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('sends any declared openai reasoning effort including max', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'effort', effortOptions: ['low', 'medium', 'high', 'max'], outputModes: ['summary'] } },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).reasoning_effort).toBe('max');
  });

  it('sends effort reasoning controls by request format without requiring the OpenAI provider label', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'effort', effortOptions: ['high', 'max'], outputModes: ['summary'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'high', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).reasoning_effort).toBe('high');
  });

  it('merges custom reasoning request fields without letting them replace core chat fields', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: {
            inputMode: 'custom',
            effortOptions: [],
            outputModes: ['raw'],
            customRequestBody: {
              model: 'must-not-replace',
              messages: [],
              chat_template_kwargs: { enable_thinking: true },
              extra_body: { provider_flag: 'on' },
            },
          } as never,
        },
        reasoning: { mode: 'enabled', protocol: 'custom', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    const body = JSON.parse(String(requests[0]?.body));
    expect(body.model).toBe('Qwen3.5-9B');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.extra_body).toEqual({ provider_flag: 'on' });
  });

  it('rejects an undeclared reasoning effort before fetch', async () => {
    let fetchCalls = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    };

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'effort', effortOptions: ['low', 'high'], outputModes: ['summary'] } },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('does not support reasoning effort "max"');
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ['unsupported/enabled', 'unsupported', 'none'],
  ] as const)('rejects invalid %s reasoning configuration before fetch', async (_name, inputMode, protocol) => {
    let fetchCalls = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    };

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: {
            inputMode,
            effortOptions: inputMode === 'effort' ? ['low'] : [],
            outputModes: [],
          },
        },
        reasoning: { mode: 'enabled', protocol, effort: 'low', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow();
    expect(fetchCalls).toBe(0);
  });

  it('records requested fast response speed without inventing provider timing', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );

    const metrics = await streamChatCompletion(
      { ...profile, responseSpeed: 'fast' },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(metrics).toMatchObject({
      responseSpeed: 'fast',
      speedSource: 'unavailable',
    });
  });

  it('fails a DONE-terminated reasoning stream that never produces a final answer', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"hidden chain of thought"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    const answers: string[] = [];
    const raw: string[] = [];

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      {
        ...ignoreHandlers,
        onAnswerDelta: (delta) => answers.push(delta),
        onRawReasoningDelta: (delta) => raw.push(delta),
      },
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('Model stream ended without producing a final answer.');

    expect(answers).toEqual([]);
    expect(raw).toEqual(['hidden chain of thought']);
  });

  it('fails a length-bounded reasoning stream with fixed output-limit guidance', async () => {
    const privateReasoning = 'private reasoning must not enter the error';
    const chunks = [
      `data: {"choices":[{"delta":{"reasoning_content":"${privateReasoning}"}}]}\n\n`,
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      async () => new Response(
        ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      ),
    )).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe(
        'Model reached the output-token limit before producing a final answer. Increase the profile output limit or start a new chat.',
      );
      expect(message).not.toContain(privateReasoning);
      return true;
    });
  });

  it('recovers a reasoning-only length-truncated attempt with one direct-answer retry', async () => {
    const responses = [
      [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ],
      [
        'data: {"choices":[{"delta":{"content":"The answer is 42."}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    ];
    const requests: Array<{ messages: ChatMessage[] }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
      const chunks = responses.shift();
      if (!chunks) throw new Error('unexpected extra continuation request');
      return new Response(
        ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };
    const answer: string[] = [];

    const metrics = await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => answer.push(delta) },
      new AbortController().signal,
      fetchImpl,
    );

    expect(answer.join('')).toBe('The answer is 42.');
    expect(requests).toHaveLength(2);
    expect(String(requests[1]?.messages.at(-1)?.content)).toContain('entire output budget on internal reasoning');
    expect(metrics.finishReason).toBe('stop');
  });

  it('continues a length-bounded answer until the provider naturally stops', async () => {
    const responses = [
      [
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"completion_tokens":2048}}\n\n',
        'data: [DONE]\n\n',
      ],
      [
        'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"completion_tokens":2048}}\n\n',
        'data: [DONE]\n\n',
      ],
      [
        'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":16}}\n\n',
        'data: [DONE]\n\n',
      ],
    ];
    const requests: Array<{ messages: ChatMessage[] }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
      const chunks = responses.shift();
      if (!chunks) throw new Error('unexpected extra continuation request');
      return new Response(
        ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };
    const answer: string[] = [];

    const metrics = await streamChatCompletion(
      profile,
      [{ role: 'user', content: '写完整页面代码' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => answer.push(delta) },
      new AbortController().signal,
      fetchImpl,
    );

    expect(answer.join('')).toBe('第一段第二段完成');
    expect(requests).toHaveLength(3);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: '写完整页面代码' },
      { role: 'assistant', content: '第一段' },
      {
        role: 'user',
        content: 'Continue from exactly where the previous answer stopped. Do not repeat any previous text. Continue until the task is complete.',
      },
    ]);
    expect(requests[2]?.messages.at(-2)).toEqual({ role: 'assistant', content: '第一段第二段' });
    expect(metrics.finishReason).toBe('stop');
    expect(metrics.completionTokens).toBe(4112);
  });

  it('stops automatic continuation when a length-bounded segment makes no answer progress', async () => {
    const responses = [
      [
        'data: {"choices":[{"delta":{"content":"已有内容"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ],
      [
        'data: {"choices":[{"delta":{"reasoning_content":"仍在思考"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    ];
    const fetchImpl = async (): Promise<Response> => {
      const chunks = responses.shift();
      if (!chunks) throw new Error('unexpected extra continuation request');
      return new Response(
        ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };
    const answer: string[] = [];

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: '写完整页面代码' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => answer.push(delta) },
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('Model reached the output-token limit without making final-answer progress while continuing.');

    expect(answer.join('')).toBe('已有内容');
  });

  it('streams raw reasoning, native summary, and answer through independent handlers', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"检查输入"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_summary":"已检查输入"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"最终答案"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    const answer: string[] = [];
    const raw: string[] = [];
    const summary: string[] = [];
    const phases: string[] = [];

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      {
        onAnswerDelta: (delta) => answer.push(delta),
        onRawReasoningDelta: (delta) => raw.push(delta),
        onReasoningSummaryDelta: (delta) => summary.push(delta),
        onPhase: (phase) => phases.push(phase),
      },
      new AbortController().signal,
      fetchImpl,
      () => 1_000,
    );

    expect(phases).toEqual(['reasoning', 'answering']);
    expect(raw).toEqual(['检查输入']);
    expect(summary).toEqual(['已检查输入']);
    expect(answer).toEqual(['最终答案']);
  });

  it('preserves repeated and prefix-like direct deltas exactly across byte-split SSE', async () => {
    const payload = [
      'data: {"choices":[{"delta":{"reasoning_content":"同","reasoning_summary":"同","content":"同"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"同思","reasoning_summary":"同摘","content":"同答"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"同思","reasoning_summary":"同摘","content":"同答"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"思","reasoning_summary":"摘","content":"答"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const bytes = new TextEncoder().encode(payload);
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        ReadableStream.from(Array.from(bytes, (byte) => Uint8Array.of(byte))) as unknown as BodyInit,
        { status: 200 },
      );
    const answer: string[] = [];
    const raw: string[] = [];
    const summary: string[] = [];
    const phases: string[] = [];

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      {
        onAnswerDelta: (delta) => answer.push(delta),
        onRawReasoningDelta: (delta) => raw.push(delta),
        onReasoningSummaryDelta: (delta) => summary.push(delta),
        onPhase: (phase) => phases.push(phase),
      },
      new AbortController().signal,
      fetchImpl,
      () => 1_000,
    );

    expect(raw).toEqual(['同', '同思', '同思', '思']);
    expect(summary).toEqual(['同', '同摘', '同摘', '摘']);
    expect(answer).toEqual(['同', '同答', '同答', '答']);
    expect(raw.join('')).toBe('同同思同思思');
    expect(summary.join('')).toBe('同同摘同摘摘');
    expect(answer.join('')).toBe('同同答同答答');
    expect(phases).toEqual(['reasoning', 'answering']);
  });

  it('deduplicates only repeated explicit SSE event identifiers', async () => {
    const payload = [
      'id: token-1\n',
      'data: {"choices":[{"delta":{"content":"ha"}}]}\n\n',
      'id: token-1\n',
      'data: {"choices":[{"delta":{"content":"ha"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ha"}}]}\n\n',
      'id: token-2\n',
      'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
      'id: token-3\n',
      'data: {"choices":[{"delta":{"content":"ha"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const answer: string[] = [];

    await streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => answer.push(delta) },
      new AbortController().signal,
      async () => new Response(
        ReadableStream.from([new TextEncoder().encode(payload)]) as unknown as BodyInit,
        { status: 200 },
      ),
    );

    expect(answer).toEqual(['ha', 'ha', ' ', 'ha']);
    expect(answer.join('')).toBe('haha ha');
  });

  it('ignores zero-length answer, raw reasoning, and summary deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_summary":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const answer: string[] = [];
    const raw: string[] = [];
    const summary: string[] = [];
    const phases: string[] = [];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

    const metrics = await streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      {
        onAnswerDelta: (delta) => answer.push(delta),
        onRawReasoningDelta: (delta) => raw.push(delta),
        onReasoningSummaryDelta: (delta) => summary.push(delta),
        onPhase: (phase) => phases.push(phase),
      },
      new AbortController().signal,
      fetchImpl,
      () => 1_000,
    );

    expect(answer).toEqual(['ok']);
    expect(raw).toEqual([]);
    expect(summary).toEqual([]);
    expect(phases).toEqual(['answering']);
    expect(metrics.timeToFirstTokenMs).toBe(0);
    expect(metrics.reasoningObserved).toBe(false);
  });

  it('preserves whitespace-only answer, raw reasoning, and summary deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":" "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_summary":"  "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const answer: string[] = [];
    const raw: string[] = [];
    const summary: string[] = [];
    const phases: string[] = [];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

    await streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      {
        onAnswerDelta: (delta) => answer.push(delta),
        onRawReasoningDelta: (delta) => raw.push(delta),
        onReasoningSummaryDelta: (delta) => summary.push(delta),
        onPhase: (phase) => phases.push(phase),
      },
      new AbortController().signal,
      fetchImpl,
    );

    expect(raw).toEqual([' ']);
    expect(summary).toEqual(['  ']);
    expect(answer).toEqual([' ', 'ok']);
    expect(phases).toEqual(['reasoning', 'answering']);
  });

  it('fails a stream whose only final-answer deltas are whitespace', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"  "},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const answer: string[] = [];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

    await expect(streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      { ...ignoreHandlers, onAnswerDelta: (delta) => answer.push(delta) },
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('Model stream ended without producing a final answer.');
    expect(answer).toEqual(['  ']);
  });

  it('does not retry a rejected reasoning parameter without reasoning', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response('reasoning_effort is unsupported; Authorization: Bearer local-not-used', { status: 400 });
    };

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: { inputMode: 'effort', effortOptions: ['max'], outputModes: ['summary'] },
          usage: { tokens: true, reasoningTokens: true },
        },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Model request failed with HTTP 400.');
      expect(message).not.toContain('reasoning_effort is unsupported');
      expect(message).not.toContain('local-not-used');
      expect(message).not.toContain('Bearer');
      return true;
    });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body)).reasoning_effort).toBe('max');
  });

  it('does not retry when a structured reasoning error merely mentions stream_options', async () => {
    let fetchCalls = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'reasoning_effort is unsupported while stream_options.include_usage is enabled',
          param: 'reasoning_effort',
          code: 'invalid_parameter',
        },
      }), { status: 400 });
    };

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: { inputMode: 'effort', effortOptions: ['max'], outputModes: ['summary'] },
          usage: { tokens: true, reasoningTokens: true },
        },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('HTTP 400');
    expect(fetchCalls).toBe(1);
  });

  it('does not let message text override a structured reasoning error code', async () => {
    let fetchCalls = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'stream_options.include_usage is unsupported',
          code: 'invalid_reasoning_effort',
        },
      }), { status: 400 });
    };

    await expect(streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, usage: { tokens: true, reasoningTokens: true } },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    )).rejects.toThrow('HTTP 400');
    expect(fetchCalls).toBe(1);
  });

  it('retries a structured stream usage parameter error exactly once', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: 'unsupported parameter',
            param: 'stream_options.include_usage',
            code: 'unsupported_parameter',
          },
        }), { status: 400 });
      }
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, usage: { tokens: true, reasoningTokens: true } },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.body)).stream_options).toEqual({ include_usage: true });
    expect(JSON.parse(String(requests[1]?.body)).stream_options).toBeUndefined();
  });

  it('retries once for a bounded structured stream-usage code while preserving reasoning parameters', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: {
            code: 'unsupported_stream_options',
            message: 'private provider diagnostic that must not be surfaced',
          },
        }), { status: 400 });
      }
      return new Response(
        ReadableStream.from([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: {
          ...profile.capabilities,
          reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
          usage: { tokens: true, reasoningTokens: true },
        },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(String(requests[0]?.body));
    const secondBody = JSON.parse(String(requests[1]?.body));
    expect(firstBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(firstBody.stream_options).toEqual({ include_usage: true });
    expect(firstBody.max_tokens).toBe(profile.maxOutputTokens);
    expect(secondBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(secondBody.stream_options).toBeUndefined();
    expect(secondBody.max_tokens).toBe(profile.maxOutputTokens);
  });

  it('supports the reasoning field alias without mixing it into the answer', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning":"raw alias"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"final"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const raw: string[] = [];
    const answer: string[] = [];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      {
        ...ignoreHandlers,
        onRawReasoningDelta: (delta) => raw.push(delta),
        onAnswerDelta: (delta) => answer.push(delta),
      },
      new AbortController().signal,
      fetchImpl,
    );

    expect(raw).toEqual(['raw alias']);
    expect(answer).toEqual(['final']);
  });

  it('extracts finish reason and token speed from streamed provider metadata', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    let now = 1_000;
    const nowMs = () => {
      now += 500;
      return now;
    };

    const metrics = await streamChatCompletion(
      profile,
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
      nowMs,
    );

    expect(metrics).toMatchObject({
      reasoningRequested: 'disabled',
      reasoningProtocol: 'none',
      reasoningObserved: false,
      finishReason: 'stop',
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
      speedSource: 'client',
      usageSource: 'server',
    });
    expect(metrics.durationMs).toBeGreaterThan(0);
    expect(metrics.tokensPerSecond).toBeGreaterThan(0);
  });

  it('labels provider token speed as server sourced when timing metadata is returned', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12,"completion_tokens_details":{"reasoning_tokens":2}},"timings":{"predicted_per_second":24}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

    const metrics = await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(metrics).toMatchObject({
      reasoningRequested: 'enabled',
      reasoningProtocol: 'qwen',
      reasoningObserved: true,
      reasoningTokens: 2,
      tokensPerSecond: 24,
      speedSource: 'server',
      usageSource: 'server',
    });
  });

  it('builds model context from same-chat message history', () => {
    expect(
      buildChatMessages([
        {
          id: 'user-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          kind: 'message',
          role: 'user',
          text: 'first question',
          createdAt: '2026-08-17T00:00:00.000Z',
        },
        {
          id: 'assistant-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          kind: 'message',
          role: 'assistant',
          text: 'first answer',
          createdAt: '2026-08-17T00:00:01.000Z',
        },
      ]),
    ).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
  });

  it('builds model context with the configured latest-message limit', () => {
    const history = ['one', 'two', 'three'].map((text, index) => ({
      id: `item-${index}`,
      threadId: 'thread-1',
      turnId: `turn-${index}`,
      kind: 'message' as const,
      role: 'user' as const,
      text,
      createdAt: `2026-08-17T00:00:0${index}.000Z`,
    }));

    expect(buildChatMessages(history, 2)).toEqual([
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  describe('native tool calling', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file.',
          parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];

    it('sends the tool schemas and tool_choice in the request body', async () => {
      const requests: RequestInit[] = [];
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push(init ?? {});
        return new Response(
          ReadableStream.from([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
          { status: 200 },
        );
      };

      await streamChatCompletion(
        profile,
        [{ role: 'user', content: 'hello' }],
        ignoreHandlers,
        new AbortController().signal,
        fetchImpl,
        undefined,
        undefined,
        tools,
      );

      const body = JSON.parse(String(requests[0]?.body));
      expect(body.tools).toEqual(tools);
      expect(body.tool_choice).toBe('auto');
    });

    it('omits tools fields when no schemas are provided', async () => {
      const requests: RequestInit[] = [];
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push(init ?? {});
        return new Response(
          ReadableStream.from([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
          { status: 200 },
        );
      };

      await streamChatCompletion(
        profile,
        [{ role: 'user', content: 'hello' }],
        ignoreHandlers,
        new AbortController().signal,
        fetchImpl,
      );

      const body = JSON.parse(String(requests[0]?.body));
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it('accumulates streamed tool_call argument fragments into complete calls', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\": \\"src/App.vue\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-2","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetchImpl = async (): Promise<Response> =>
        new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
      const delivered: unknown[] = [];

      await streamChatCompletion(
        profile,
        [{ role: 'user', content: 'read the app' }],
        {
          ...ignoreHandlers,
          onNativeToolCalls: (calls) => delivered.push(...calls),
        },
        new AbortController().signal,
        fetchImpl,
        undefined,
        undefined,
        tools,
      );

      expect(delivered).toEqual([
        { id: 'call-1', name: 'read_file', arguments: { path: 'src/App.vue' } },
        { id: 'call-2', name: 'git_status', arguments: {} },
      ]);
    });

    it('keeps a tool-call-only stream from failing the final-answer assertion', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetchImpl = async (): Promise<Response> =>
        new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

      await expect(streamChatCompletion(
        profile,
        [{ role: 'user', content: 'show git state' }],
        ignoreHandlers,
        new AbortController().signal,
        fetchImpl,
        undefined,
        undefined,
        tools,
      )).resolves.toMatchObject({ finishReason: 'tool_calls' });
    });

    it('surfaces invalid tool-call argument JSON instead of dropping the call', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{broken"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetchImpl = async (): Promise<Response> =>
        new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });

      await expect(streamChatCompletion(
        profile,
        [{ role: 'user', content: 'read the app' }],
        ignoreHandlers,
        new AbortController().signal,
        fetchImpl,
        undefined,
        undefined,
        tools,
      )).rejects.toThrow('tool call');
    });
  });
});

describe('context compression for oversized prompts', () => {
  const agentProfile: RuntimeModelProfile = { ...profile, maxOutputTokens: 8192 };

  it('keeps the recent tool-call/observation tail intact and summarizes only older history', () => {
    const older = { role: 'user' as const, content: `old context ${'O'.repeat(40_000)}` };
    const toolCall = { role: 'assistant' as const, content: '```tool\n{"tool": "read_file", "input": {"path": "src/App.vue"}}\n```' };
    const observation = { role: 'user' as const, content: `Tool result for call "call-1":\n${'R'.repeat(20_000)}` };
    const latest = { role: 'user' as const, content: `add auto-fire back ${'L'.repeat(500)}` };

    const compressed = compressedInitialRequestMessages(agentProfile, [older, toolCall, observation, latest], 0);

    const noticeIndex = compressed.findIndex((message) =>
      typeof message.content === 'string' && message.content.includes('[Local context compaction active]'));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    const notice = compressed[noticeIndex];
    expect(typeof notice.content === 'string' && notice.content.includes('old context')).toBe(true);
    expect(typeof notice.content === 'string' && notice.content.includes('O'.repeat(5_000))).toBe(false);

    expect(compressed.indexOf(toolCall)).toBe(noticeIndex + 1);
    expect(compressed.indexOf(observation)).toBe(noticeIndex + 2);
    expect(compressed[compressed.length - 1]?.content).toContain('add auto-fire back');
  });

  it('omits the compaction notice when the recent tail already fits', () => {
    const toolCall = { role: 'assistant' as const, content: 'reading now' };
    const latest = { role: 'user' as const, content: 'please continue' };
    const compressed = compressedInitialRequestMessages(agentProfile, [toolCall, latest], 0);
    expect(compressed.some((message) =>
      typeof message.content === 'string' && message.content.includes('[Local context compaction active]'))).toBe(false);
    expect(compressed[compressed.length - 2]).toBe(toolCall);
  });
});

function containsSecretRepresentation(text: string, secret: string): boolean {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  return [secret, jsonEscaped, encodeURIComponent(secret)].some((candidate) => text.includes(candidate));
}
