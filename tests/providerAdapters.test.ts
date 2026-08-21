import { describe, expect, it, vi } from 'vitest';
import type { RuntimeModelProfile } from '../src/agent/database.js';
import {
  contextTokenWindow,
  streamModelResponse,
  type ChatMessage,
  type ModelStreamHandlers,
} from '../src/agent/modelProvider.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function runtimeModel(overrides: Partial<RuntimeModelProfile> = {}): RuntimeModelProfile {
  return {
    id: 'model-1',
    providerId: 'provider-1',
    providerName: 'Fixture provider',
    name: 'Fixture',
    provider: 'openai-compatible',
    deploymentType: 'cloud',
    runtimeType: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'fixture',
    protocol: 'openai-chat-completions',
    apiKey: 'secret',
    apiKeyConfigured: true,
    capabilities: {
      text: true,
      vision: true,
      longContext: false,
      reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: ['raw', 'summary'] },
      concurrency: { defaultLimit: 1, configurable: true },
      streaming: true,
      usage: { tokens: true, reasoningTokens: true },
      nativeTools: true,
    },
    reasoning: { mode: 'disabled', protocol: 'none', display: 'auto' },
    maxConcurrency: 1,
    maxOutputTokens: 2048,
    responseSpeed: 'standard',
    isDefault: true,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function handlers() {
  return {
    onAnswerDelta: vi.fn(),
    onRawReasoningDelta: vi.fn(),
    onReasoningSummaryDelta: vi.fn(),
    onPhase: vi.fn(),
    onNativeToolCalls: vi.fn(),
  } satisfies ModelStreamHandlers;
}

function sseDataResponse(entries: readonly (Record<string, unknown> | '[DONE]')[]): Response {
  const text = entries.map((entry) => `data: ${entry === '[DONE]' ? entry : JSON.stringify(entry)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function namedSseResponse(events: readonly [string, Record<string, unknown>][]): Response {
  const text = events.map(([event, data], index) => `id: ${index}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

describe('provider protocol adapters', () => {
  it('dispatches chat completions without vendor thinking fields in model-default mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseDataResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]));
    await streamModelResponse(
      runtimeModel({ thinkingMode: 'model-default' }),
      messages,
      handlers(),
      new AbortController().signal,
      fetchImpl,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/v1/chat/completions');
    expect(body).not.toHaveProperty('enable_thinking');
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('merges custom request values without replacing transport-owned fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseDataResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]',
    ]));
    await streamModelResponse(runtimeModel({
      thinkingMode: 'custom',
      customRequestBody: {
        model: 'replacement', messages: [], stream: false, tools: [],
        extra_body: { enable_thinking: true }, temperature: 0.1,
      },
    }), messages, handlers(), new AbortController().signal, fetchImpl);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'fixture', stream: true, extra_body: { enable_thinking: true }, temperature: 0.1,
    });
  });

  it('uses only a positive model context-window override or the conservative fallback', () => {
    expect(contextTokenWindow(runtimeModel({ contextWindowTokens: 65_536 }))).toBe(65_536);
    expect(contextTokenWindow(runtimeModel({ contextWindowTokens: undefined }))).toBe(32_768);
  });

  it('normalizes OpenAI Responses text, reasoning summary, tools, and usage', async () => {
    const callbacks = handlers();
    const fetchImpl = vi.fn().mockResolvedValue(namedSseResponse([
      ['response.reasoning_summary_text.delta', { delta: 'plan' }],
      ['response.output_text.delta', { delta: 'answer' }],
      ['response.output_item.added', { item: { type: 'function_call', id: 'call-1', name: 'read_file' } }],
      ['response.function_call_arguments.delta', { item_id: 'call-1', delta: '{"path":"README.md"}' }],
      ['response.completed', { response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } } }],
    ]));
    const metrics = await streamModelResponse(
      runtimeModel({ protocol: 'openai-responses' }), messages, callbacks,
      new AbortController().signal, fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/v1/responses');
    expect(callbacks.onReasoningSummaryDelta).toHaveBeenCalledWith('plan');
    expect(callbacks.onAnswerDelta).toHaveBeenCalledWith('answer');
    expect(callbacks.onNativeToolCalls).toHaveBeenCalledWith([
      { id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } },
    ]);
    expect(metrics).toMatchObject({ promptTokens: 10, completionTokens: 4 });
  });

  it('uses Anthropic auth and normalizes thinking and text blocks', async () => {
    const callbacks = handlers();
    const fetchImpl = vi.fn().mockResolvedValue(namedSseResponse([
      ['message_start', { message: { usage: { input_tokens: 7, output_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }],
      ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
      ['message_stop', {}],
    ]));
    const metrics = await streamModelResponse(
      runtimeModel({ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' }),
      messages, callbacks, new AbortController().signal, fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'secret', 'anthropic-version': expect.any(String) }),
    }));
    expect(callbacks.onRawReasoningDelta).toHaveBeenCalledWith('plan');
    expect(callbacks.onAnswerDelta).toHaveBeenCalledWith('answer');
    expect(metrics).toMatchObject({ promptTokens: 7, completionTokens: 3 });
  });
});
