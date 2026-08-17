import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../src/agent/chatContext';
import { streamChatCompletion, type ModelStreamHandlers } from '../src/agent/modelProvider';
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
        ReadableStream.from(['data: [DONE]\n\n'].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
        { status: 200 },
      );
    };

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode, protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      ignoreHandlers,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).chat_template_kwargs).toEqual({ enable_thinking: enableThinking });
  });

  it('sends any declared openai reasoning effort including max', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      return new Response(
        ReadableStream.from(['data: [DONE]\n\n'].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
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

  it('records requested fast response speed without inventing provider timing', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        ReadableStream.from(['data: [DONE]\n\n'].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
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

  it('keeps raw reasoning out of the answer when the provider returns no answer', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"hidden chain of thought"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    const answers: string[] = [];
    const raw: string[] = [];

    const metrics = await streamChatCompletion(
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
    );

    expect(answers).toEqual([]);
    expect(raw).toEqual(['hidden chain of thought']);
    expect(metrics.reasoningObserved).toBe(true);
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
      expect(message).toContain('HTTP 400');
      expect(message).toContain('reasoning_effort is unsupported');
      expect(message).not.toContain('local-not-used');
      expect(message).not.toContain('Bearer');
      return true;
    });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body)).reasoning_effort).toBe('max');
  });

  it('retries once without stream_options while preserving reasoning parameters', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response('unsupported parameter: stream_options.include_usage', { status: 400 });
      }
      return new Response(
        ReadableStream.from(['data: [DONE]\n\n'].map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit,
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
    expect(secondBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(secondBody.stream_options).toBeUndefined();
  });

  it('supports the reasoning field alias without mixing it into the answer', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning":"raw alias"}}]}\n\n',
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
    expect(answer).toEqual([]);
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
});
