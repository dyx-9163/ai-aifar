import type { RuntimeModelProfile } from './database.js';
import type { MetricSource, ModelRunMetrics, ModelRunPhase } from '../shared/domain.js';
import { validateReasoningSelection } from './modelCapabilities.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelStreamHandlers {
  onAnswerDelta(text: string): Promise<void> | void;
  onRawReasoningDelta(text: string): Promise<void> | void;
  onReasoningSummaryDelta(text: string): Promise<void> | void;
  onPhase(phase: ModelRunPhase): Promise<void> | void;
}

type StreamedMetrics = Partial<ModelRunMetrics> & {
  serverTokensPerSecond?: number;
};

type ParsedStreamChunk = {
  answerDelta?: string;
  rawReasoningDelta?: string;
  reasoningSummaryDelta?: string;
  finishReason?: string;
  usage?: StreamedMetrics;
};

export async function streamChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
  nowMs: () => number = () => Date.now(),
): Promise<ModelRunMetrics> {
  validateReasoningSelection(profile);
  const startedAt = nowMs();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const response = await requestChatCompletion(profile, messages, headers, signal, fetchImpl);

  if (!response.body) {
    throw new Error('Model response did not include a readable stream.');
  }

  let firstTokenAt: number | undefined;
  const trackFirstToken = () => {
    firstTokenAt ??= nowMs();
  };
  const streamedMetrics = await readSseDeltas(
    response.body,
    {
      onAnswerDelta: async (text) => {
        trackFirstToken();
        await handlers.onAnswerDelta(text);
      },
      onRawReasoningDelta: async (text) => {
        trackFirstToken();
        await handlers.onRawReasoningDelta(text);
      },
      onReasoningSummaryDelta: async (text) => {
        trackFirstToken();
        await handlers.onReasoningSummaryDelta(text);
      },
      onPhase: handlers.onPhase,
    },
    signal,
  );
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
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
): Promise<StreamedMetrics> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const metrics: StreamedMetrics = {};
  let currentPhase: ModelRunPhase = 'connecting';

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

      const chunk = parseStreamChunk(data);
      const hasReasoning = chunk.rawReasoningDelta !== undefined || chunk.reasoningSummaryDelta !== undefined;
      if (hasReasoning && currentPhase === 'connecting') {
        currentPhase = 'reasoning';
        await handlers.onPhase(currentPhase);
      }
      if (chunk.rawReasoningDelta !== undefined) {
        await handlers.onRawReasoningDelta(chunk.rawReasoningDelta);
      }
      if (chunk.reasoningSummaryDelta !== undefined) {
        await handlers.onReasoningSummaryDelta(chunk.reasoningSummaryDelta);
      }
      if (chunk.answerDelta !== undefined) {
        if (currentPhase !== 'answering') {
          currentPhase = 'answering';
          await handlers.onPhase(currentPhase);
        }
        await handlers.onAnswerDelta(chunk.answerDelta);
      }
      if (hasReasoning) {
        metrics.reasoningObserved = true;
      }
      if (chunk.finishReason !== undefined) {
        metrics.finishReason = chunk.finishReason;
      }
      Object.assign(metrics, chunk.usage);
    }
  }

  return metrics;
}

async function requestChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<Response> {
  const send = (includeUsage: boolean) =>
    fetchImpl(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(buildChatCompletionBody(profile, messages, includeUsage)),
    });

  const first = await send(true);
  if (first.ok) {
    return first;
  }

  const firstBody = await readErrorBody(first);
  if (profile.capabilities.usage.tokens && isStreamUsageCompatibilityError(first.status, firstBody)) {
    const retry = await send(false);
    if (retry.ok) {
      return retry;
    }
    throw await modelRequestError(retry, profile.apiKey);
  }

  throw modelRequestErrorFromBody(first.status, firstBody, profile.apiKey);
}

function buildChatCompletionBody(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  includeUsage: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    temperature: 0.2,
  };

  if (includeUsage && profile.capabilities.usage.tokens) {
    body.stream_options = { include_usage: true };
  }

  if (profile.capabilities.reasoning.inputMode === 'toggle' && profile.reasoning.protocol === 'qwen') {
    body.chat_template_kwargs = { enable_thinking: profile.reasoning.mode !== 'disabled' };
  }
  if (
    profile.capabilities.reasoning.inputMode === 'effort'
    && profile.reasoning.protocol === 'openai'
    && profile.reasoning.mode !== 'disabled'
  ) {
    body.reasoning_effort = profile.reasoning.effort;
  }

  return body;
}

function parseStreamChunk(data: string): ParsedStreamChunk {
  const parsed = JSON.parse(data) as {
    choices?: Array<{
      delta?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
        reasoning_summary?: string;
      };
      finish_reason?: string | null;
    }>;
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

  const usage: StreamedMetrics = {};
  const delta = parsed.choices?.[0]?.delta;
  const chunk: ParsedStreamChunk = {};
  if (typeof delta?.content === 'string') chunk.answerDelta = delta.content;
  if (typeof delta?.reasoning_content === 'string') chunk.rawReasoningDelta = delta.reasoning_content;
  else if (typeof delta?.reasoning === 'string') chunk.rawReasoningDelta = delta.reasoning;
  if (typeof delta?.reasoning_summary === 'string') chunk.reasoningSummaryDelta = delta.reasoning_summary;
  const finishReason = parsed.choices?.[0]?.finish_reason;
  if (typeof finishReason === 'string') {
    chunk.finishReason = finishReason;
  }
  if (typeof parsed.usage?.prompt_tokens === 'number') {
    usage.promptTokens = parsed.usage.prompt_tokens;
  }
  if (typeof parsed.usage?.completion_tokens === 'number') {
    usage.completionTokens = parsed.usage.completion_tokens;
  }
  if (typeof parsed.usage?.total_tokens === 'number') {
    usage.totalTokens = parsed.usage.total_tokens;
  }
  if (typeof parsed.usage?.completion_tokens_details?.reasoning_tokens === 'number') {
    usage.reasoningTokens = parsed.usage.completion_tokens_details.reasoning_tokens;
  }
  if (typeof parsed.timings?.predicted_per_second === 'number') {
    usage.serverTokensPerSecond = parsed.timings.predicted_per_second;
  }
  if (Object.keys(usage).length > 0) chunk.usage = usage;
  return chunk;
}

async function modelRequestError(response: Response, apiKey: string | undefined): Promise<Error> {
  return modelRequestErrorFromBody(response.status, await readErrorBody(response), apiKey);
}

function modelRequestErrorFromBody(status: number, body: string, apiKey: string | undefined): Error {
  const excerpt = redactResponseExcerpt(body, apiKey);
  return new Error(`Model request failed with HTTP ${status}${excerpt ? `: ${excerpt}` : '.'}`);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isStreamUsageCompatibilityError(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const normalized = body.toLowerCase();
  return normalized.includes('stream_options') || normalized.includes('include_usage');
}

function redactResponseExcerpt(body: string, apiKey: string | undefined): string {
  let redacted = body.replace(/\s+/g, ' ').trim();
  if (apiKey) redacted = redacted.split(apiKey).join('[REDACTED]');
  redacted = redacted
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '[REDACTED]')
    .replace(/bearer\s+[^\s,;]+/gi, '[REDACTED]');
  return redacted.slice(0, 320);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Turn was cancelled.', 'AbortError');
  }
}
