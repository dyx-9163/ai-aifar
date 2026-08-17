import type { RuntimeModelProfile } from './database.js';
import type { MetricSource, ModelRunMetrics } from '../shared/domain.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

type StreamedMetrics = Partial<ModelRunMetrics> & {
  serverTokensPerSecond?: number;
};

export async function streamChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  emitDelta: (delta: string) => void | Promise<void>,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
  nowMs: () => number = () => Date.now(),
): Promise<ModelRunMetrics> {
  const startedAt = nowMs();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const response = await requestChatCompletion(profile, messages, headers, signal, fetchImpl);

  if (!response.ok) {
    throw new Error(`Model request failed with HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error('Model response did not include a readable stream.');
  }

  let firstTokenAt: number | undefined;
  let visibleDeltaCount = 0;
  const streamedMetrics = await readSseDeltas(
    response.body,
    async (delta) => {
      firstTokenAt ??= nowMs();
      visibleDeltaCount += 1;
      await emitDelta(delta);
    },
    signal,
  );
  if (visibleDeltaCount === 0 && streamedMetrics.reasoningObserved) {
    firstTokenAt ??= nowMs();
    await emitDelta(
      '模型只返回了思考内容，没有返回可展示回答。请先关闭思考强度，或在模型服务中确认该私有化模型的模板会输出 content 字段。',
    );
  }
  const durationMs = Math.max(1, nowMs() - startedAt);
  const completionTokens = streamedMetrics.completionTokens;
  const serverRate = streamedMetrics.serverTokensPerSecond;
  const tokensPerSecond = serverRate ?? (completionTokens ? completionTokens / (durationMs / 1000) : undefined);
  const speedSource: MetricSource = serverRate ? 'server' : completionTokens ? 'client' : 'unavailable';
  const usageSource: MetricSource =
    streamedMetrics.promptTokens || streamedMetrics.completionTokens || streamedMetrics.totalTokens ? 'server' : 'unavailable';
  const reasoningTokens = streamedMetrics.reasoningTokens;

  return {
    modelProfileId: profile.id,
    modelName: profile.model,
    reasoningRequested: profile.reasoning.mode,
    reasoningProtocol: profile.reasoning.protocol,
    reasoningObserved: Boolean((reasoningTokens && reasoningTokens > 0) || streamedMetrics.reasoningObserved),
    responseSpeed: profile.responseSpeed,
    durationMs,
    timeToFirstTokenMs: firstTokenAt ? Math.max(0, firstTokenAt - startedAt) : undefined,
    ...streamedMetrics,
    tokensPerSecond,
    speedSource,
    usageSource,
  };
}

export async function testModelProfile(profile: RuntimeModelProfile, fetchImpl: FetchLike = fetch): Promise<{ ok: true; message: string }> {
  const headers: Record<string, string> = {};
  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const response = await fetchImpl(`${profile.baseUrl.replace(/\/$/, '')}/models`, { headers });
  if (!response.ok) {
    throw new Error(`Model endpoint returned HTTP ${response.status}.`);
  }

  return { ok: true, message: `Connected to ${profile.name} (${profile.model}).` };
}

async function readSseDeltas(
  body: ReadableStream<Uint8Array>,
  emitDelta: (delta: string) => void | Promise<void>,
  signal: AbortSignal,
): Promise<StreamedMetrics> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const metrics: StreamedMetrics = {};

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice('data:'.length).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      const delta = parseDelta(data);
      if (delta) {
        await emitDelta(delta);
      }
      Object.assign(metrics, parseMetrics(data));
    }
  }

  return metrics;
}

function parseDelta(data: string): string | undefined {
  const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
  const content = parsed.choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : undefined;
}

async function requestChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<Response> {
  const send = (includeUsage: boolean, includeReasoning: boolean) =>
    fetchImpl(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(buildChatCompletionBody(profile, messages, includeUsage, includeReasoning)),
    });

  const first = await send(true, true);
  if (first.ok || (first.status !== 400 && first.status !== 422)) {
    return first;
  }

  const retry = await send(false, false);
  return retry.ok ? retry : first;
}

function buildChatCompletionBody(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  includeUsage: boolean,
  includeReasoning: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    temperature: 0.2,
  };

  if (includeUsage && profile.capabilities.streamingUsage) {
    body.stream_options = { include_usage: true };
  }

  if (includeReasoning) {
    if (profile.reasoning.mode === 'disabled') {
      body.chat_template_kwargs = { enable_thinking: false };
    } else if (shouldSendReasoning(profile)) {
      if (profile.reasoning.protocol === 'qwen') {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (profile.reasoning.protocol === 'openai') {
        body.reasoning_effort = profile.reasoning.effort;
      }
    }
  }

  return body;
}

function shouldSendReasoning(profile: RuntimeModelProfile): boolean {
  if (!profile.capabilities.reasoning || profile.reasoning.protocol === 'none' || profile.reasoning.protocol === 'custom') {
    return false;
  }
  return profile.reasoning.mode === 'enabled' || profile.reasoning.mode === 'auto';
}

function parseMetrics(data: string): StreamedMetrics {
  const parsed = JSON.parse(data) as {
    choices?: Array<{ delta?: { reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      completion_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
    timings?: {
      predicted_per_second?: number;
    };
  };

  const metrics: StreamedMetrics = {};
  const delta = parsed.choices?.[0]?.delta;
  if (typeof delta?.reasoning_content === 'string' || typeof delta?.reasoning === 'string') {
    metrics.reasoningObserved = true;
  }
  const finishReason = parsed.choices?.[0]?.finish_reason;
  if (typeof finishReason === 'string') {
    metrics.finishReason = finishReason;
  }
  if (typeof parsed.usage?.prompt_tokens === 'number') {
    metrics.promptTokens = parsed.usage.prompt_tokens;
  }
  if (typeof parsed.usage?.completion_tokens === 'number') {
    metrics.completionTokens = parsed.usage.completion_tokens;
  }
  if (typeof parsed.usage?.total_tokens === 'number') {
    metrics.totalTokens = parsed.usage.total_tokens;
  }
  if (typeof parsed.usage?.completion_tokens_details?.reasoning_tokens === 'number') {
    metrics.reasoningTokens = parsed.usage.completion_tokens_details.reasoning_tokens;
  }
  if (typeof parsed.timings?.predicted_per_second === 'number') {
    metrics.serverTokensPerSecond = parsed.timings.predicted_per_second;
  }
  return metrics;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Turn was cancelled.', 'AbortError');
  }
}
