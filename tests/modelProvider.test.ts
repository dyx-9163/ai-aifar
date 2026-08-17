import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../src/agent/chatContext';
import { streamChatCompletion } from '../src/agent/modelProvider';
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

describe('OpenAI-compatible model provider', () => {
  it('streams chat completion deltas and requests thinking off by default', async () => {
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
      (delta) => deltas.push(delta),
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
    expect(JSON.parse(String(requests[0]?.init.body)).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends qwen thinking parameters only when the profile enables qwen reasoning', async () => {
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
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      () => undefined,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('sends openai reasoning effort only when the profile enables openai reasoning', async () => {
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
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'effort', effortOptions: ['low', 'medium', 'high'], outputModes: ['summary'] } },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'high', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      () => undefined,
      new AbortController().signal,
      fetchImpl,
    );

    expect(JSON.parse(String(requests[0]?.body)).reasoning_effort).toBe('high');
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
      () => undefined,
      new AbortController().signal,
      fetchImpl,
    );

    expect(metrics).toMatchObject({
      responseSpeed: 'fast',
      speedSource: 'unavailable',
    });
  });

  it('emits a safe visible notice when a reasoning model returns no displayable content', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"hidden chain of thought"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    const deltas: string[] = [];

    const metrics = await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      (delta) => deltas.push(delta),
      new AbortController().signal,
      fetchImpl,
    );

    expect(deltas.join('')).toContain('模型只返回了思考内容');
    expect(deltas.join('')).not.toContain('hidden chain of thought');
    expect(metrics.reasoningObserved).toBe(true);
  });

  it('reports reasoning and answering phases without exposing hidden reasoning text', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"visible answer"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(ReadableStream.from(chunks.map((chunk) => new TextEncoder().encode(chunk))) as unknown as BodyInit, { status: 200 });
    const deltas: string[] = [];
    const phases: string[] = [];

    await streamChatCompletion(
      {
        ...profile,
        capabilities: { ...profile.capabilities, reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] } },
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium', display: 'auto' },
      },
      [{ role: 'user', content: 'hello' }],
      (delta) => deltas.push(delta),
      new AbortController().signal,
      fetchImpl,
      () => 1_000,
      (phase) => phases.push(phase),
    );

    expect(phases).toEqual(['reasoning', 'answering']);
    expect(deltas).toEqual(['visible answer']);
  });

  it('retries once without optional usage and reasoning parameters when rejected', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response('unsupported parameter', { status: 400 });
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
      () => undefined,
      new AbortController().signal,
      fetchImpl,
    );

    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(String(requests[0]?.body));
    const secondBody = JSON.parse(String(requests[1]?.body));
    expect(firstBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(firstBody.stream_options).toEqual({ include_usage: true });
    expect(secondBody.chat_template_kwargs).toBeUndefined();
    expect(secondBody.stream_options).toBeUndefined();
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
      () => undefined,
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
      () => undefined,
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
