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

const DEFAULT_MODEL_RUN_TIMEOUT_MS = 5 * 60 * 1_000;

export async function streamChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
  nowMs: () => number = () => Date.now(),
  timeoutMs = DEFAULT_MODEL_RUN_TIMEOUT_MS,
): Promise<ModelRunMetrics> {
  validateReasoningSelection(profile);
  const startedAt = nowMs();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const requestSignal = linkedTimeoutSignal(signal, timeoutMs);
  try {
    const response = await requestChatCompletion(profile, messages, headers, requestSignal.signal, fetchImpl);

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
      requestSignal.signal,
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
  } catch (error) {
    if (requestSignal.timedOut() && !signal.aborted) {
      throw new Error(`Model request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    requestSignal.dispose();
  }
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

  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) {
        return metrics;
      }
      if (!value) {
        continue;
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
        if (!data) {
          continue;
        }
        if (data === '[DONE]') {
          return metrics;
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
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The provider may have already errored or released its side of the stream.
    }
    reader.releaseLock();
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function linkedTimeoutSignal(signal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(abortReason(signal));
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Model request timed out.', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Turn was cancelled.', 'AbortError');
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
  chunk.answerDelta = nonEmptyStreamText(delta?.content);
  chunk.rawReasoningDelta = nonEmptyStreamText(delta?.reasoning_content) ?? nonEmptyStreamText(delta?.reasoning);
  chunk.reasoningSummaryDelta = nonEmptyStreamText(delta?.reasoning_summary);
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
  const structured = parseStructuredProviderError(body);
  if (structured?.param) {
    return isStreamUsageParameter(structured.param);
  }
  if (structured?.code) {
    return isStreamUsageCode(structured.code);
  }
  return explicitlyRejectsStreamUsage(structured?.message ?? body);
}

function parseStructuredProviderError(body: string): { param?: string; code?: string; message?: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { param?: unknown; code?: unknown; message?: unknown } };
    if (!parsed.error || typeof parsed.error !== 'object') return undefined;
    return {
      param: typeof parsed.error.param === 'string' ? parsed.error.param : undefined,
      code: typeof parsed.error.code === 'string' ? parsed.error.code : undefined,
      message: typeof parsed.error.message === 'string' ? parsed.error.message : undefined,
    };
  } catch {
    return undefined;
  }
}

function isStreamUsageParameter(param: string): boolean {
  const normalized = param.trim().toLowerCase();
  return normalized === 'stream_options'
    || normalized === 'include_usage'
    || normalized === 'stream_options.include_usage';
}

function isStreamUsageCode(code: string): boolean {
  return /(?:^|[._-])(?:stream_options|include_usage)(?:$|[._-])/.test(code.trim().toLowerCase());
}

function explicitlyRejectsStreamUsage(message: string): boolean {
  const target = '(?:stream_options(?:\\.include_usage)?|include_usage)';
  const problem = '(?:unsupported|not\\s+supported|unknown|unrecognized|invalid)';
  const normalized = message.toLowerCase();
  return new RegExp(`${problem}(?:\\s+request)?(?:\\s+parameter)?\\s*[:=]?\\s*["']?${target}\\b`).test(normalized)
    || new RegExp(`\\b${target}\\b\\s+(?:is\\s+)?${problem}`).test(normalized);
}

function nonEmptyStreamText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
