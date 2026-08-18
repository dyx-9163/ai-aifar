import type { RuntimeModelProfile } from './database.js';
import type { MetricSource, ModelConnectionResult, ModelRunMetrics, ModelRunPhase } from '../shared/domain.js';
import { safeErrorText } from '../shared/redaction.js';
import { validateReasoningSelection } from './modelCapabilities.js';
import { inspectModelConnection } from './modelConnection.js';
import { createStreamTextNormalizer } from './streamTextNormalizer.js';

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
const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_ERROR_BYTES = 8_192;

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
    const operation = (async () => {
      throwIfAborted(requestSignal.signal);
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
    })();
    return await Promise.race([operation, requestSignal.aborted]);
  } catch (error) {
    if (requestSignal.timedOut() && !signal.aborted) {
      throw new Error(`Model request timed out after ${timeoutMs}ms.`);
    }
    if (signal.aborted) throw error;
    throw new Error(safeErrorText(error, profile.apiKey ? [profile.apiKey] : [], 500));
  } finally {
    requestSignal.dispose();
  }
}

export async function testModelProfile(
  profile: RuntimeModelProfile,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_CONNECTION_TEST_TIMEOUT_MS,
): Promise<ModelConnectionResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ModelConnectionResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Model connection test timed out.', 'TimeoutError'));
      resolve(connectionTimeoutResult(profile, timeoutMs));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([
      inspectModelConnection(profile, fetchImpl, controller.signal),
      timeout,
    ]);
  } catch (error) {
    if (timedOut) return connectionTimeoutResult(profile, timeoutMs);
    throw new Error(safeErrorText(error, profile.apiKey ? [profile.apiKey] : [], 500));
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const answer = createStreamTextNormalizer('incremental');
  const rawReasoning = createStreamTextNormalizer('incremental');
  const reasoningSummary = createStreamTextNormalizer('incremental');
  const seenEventDataById = new Map<string, string>();
  let eventDataLines: string[] = [];
  let eventId: string | undefined;

  const dispatchEvent = async (): Promise<boolean> => {
    const data = eventDataLines.join('\n');
    const identity = eventId;
    eventDataLines = [];
    eventId = undefined;
    if (!data) return false;

    if (identity) {
      const previousData = seenEventDataById.get(identity);
      if (previousData !== undefined) {
        if (previousData !== data) {
          throw new Error('Model stream reused an SSE event identifier with conflicting data.');
        }
        return false;
      }
      seenEventDataById.set(identity, data);
    }

    if (data.trim() === '[DONE]') {
      assertFinalAnswer(answer.value(), metrics.finishReason);
      return true;
    }

    const chunk = parseStreamChunk(data);
    const answerDelta = chunk.answerDelta === undefined ? undefined : answer.push(chunk.answerDelta);
    const rawReasoningDelta = chunk.rawReasoningDelta === undefined
      ? undefined
      : rawReasoning.push(chunk.rawReasoningDelta);
    const reasoningSummaryDelta = chunk.reasoningSummaryDelta === undefined
      ? undefined
      : reasoningSummary.push(chunk.reasoningSummaryDelta);
    const hasReasoning = rawReasoningDelta !== undefined || reasoningSummaryDelta !== undefined;
    if (hasReasoning && currentPhase === 'connecting') {
      currentPhase = 'reasoning';
      await handlers.onPhase(currentPhase);
    }
    if (rawReasoningDelta !== undefined) {
      await handlers.onRawReasoningDelta(rawReasoningDelta);
    }
    if (reasoningSummaryDelta !== undefined) {
      await handlers.onReasoningSummaryDelta(reasoningSummaryDelta);
    }
    if (answerDelta !== undefined) {
      if (currentPhase !== 'answering') {
        currentPhase = 'answering';
        await handlers.onPhase(currentPhase);
      }
      await handlers.onAnswerDelta(answerDelta);
    }
    if (hasReasoning) {
      metrics.reasoningObserved = true;
    }
    if (chunk.finishReason !== undefined) {
      metrics.finishReason = chunk.finishReason;
    }
    Object.assign(metrics, chunk.usage);
    return false;
  };

  const consumeLine = async (line: string): Promise<boolean> => {
    if (line === '') return dispatchEvent();
    if (line.startsWith(':')) return false;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      eventDataLines.push(value);
    } else if (field === 'id' && !value.includes('\0')) {
      eventId = value;
    }
    return false;
  };

  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) {
        buffer += decoder.decode();
        if (buffer && await consumeLine(buffer.replace(/\r$/, ''))) return metrics;
        if (eventDataLines.length > 0 && await dispatchEvent()) return metrics;
        assertFinalAnswer(answer.value(), metrics.finishReason);
        return metrics;
      }
      if (!value) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (await consumeLine(line.replace(/\r$/, ''))) return metrics;
      }
    }
  } finally {
    cancelReaderWithoutBlocking(reader);
  }
}

function cancelReaderWithoutBlocking(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The provider may have already errored or released its side of the stream.
  }
  try {
    reader.releaseLock();
  } catch {
    // A provider-controlled pending read may retain the lock; it must not retain scheduler capacity.
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
  aborted: Promise<never>;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAborted(reason);
  };
  const onAbort = () => abort(abortReason(signal));
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    abort(new DOMException('Model request timed out.', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    aborted,
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
  throwIfAborted(signal);
  if (first.ok) {
    return first;
  }

  const firstBody = await readErrorBody(first);
  throwIfAborted(signal);
  if (profile.capabilities.usage.tokens && isStreamUsageCompatibilityError(first.status, firstBody)) {
    const retry = await send(false);
    throwIfAborted(signal);
    if (retry.ok) {
      return retry;
    }
    throw await modelRequestError(retry);
  }

  throw modelRequestErrorFromBody(first.status, firstBody);
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
    max_tokens: profile.maxOutputTokens,
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

async function modelRequestError(response: Response): Promise<Error> {
  return modelRequestErrorFromBody(response.status, await readErrorBody(response));
}

function modelRequestErrorFromBody(status: number, body: string): Error {
  const metadata = parseStructuredProviderError(body);
  if (isContextLimitError(status, metadata)) {
    return new Error('Model request exceeds the available context. Start a new chat or lower the history limit.');
  }
  if (status === 401 || status === 403) {
    return new Error(`Model request was rejected (HTTP ${status}). Check the profile credentials.`);
  }
  if (status === 404) {
    return new Error('Model request failed with HTTP 404. Check the configured base URL and model.');
  }
  if (status === 429) {
    return new Error('Model service rate-limited the request (HTTP 429). Try again later.');
  }
  if (status >= 500 && status <= 599) {
    return new Error(`Model service failed to process the request (HTTP ${status}).`);
  }
  return new Error(`Model request failed with HTTP ${status}.`);
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = MAX_PROVIDER_ERROR_BYTES;
  let result = '';
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) {
        result += decoder.decode();
        break;
      }
      if (!value) continue;
      const accepted = value.subarray(0, remaining);
      result += decoder.decode(accepted, { stream: accepted.byteLength === value.byteLength });
      remaining -= accepted.byteLength;
      if (accepted.byteLength < value.byteLength || remaining === 0) break;
    }
    result += decoder.decode();
    return result;
  } catch {
    return '';
  } finally {
    cancelReaderWithoutBlocking(reader);
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
  return false;
}

type StructuredProviderError = { param?: string; code?: string; type?: string };

function parseStructuredProviderError(body: string): StructuredProviderError | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { param?: unknown; code?: unknown; type?: unknown } };
    if (!parsed.error || typeof parsed.error !== 'object') return undefined;
    return {
      param: boundedProviderIdentifier(parsed.error.param),
      code: boundedProviderIdentifier(parsed.error.code),
      type: boundedProviderIdentifier(parsed.error.type),
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

function boundedProviderIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(value) ? value : undefined;
}

function isContextLimitError(status: number, metadata: StructuredProviderError | undefined): boolean {
  if (status === 413) return true;
  const identifiers = [metadata?.code, metadata?.type, metadata?.param]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());
  return identifiers.some((value) => [
    'context_length_exceeded',
    'context_window_exceeded',
    'exceed_context_size_error',
    'input_too_long',
    'prompt_too_long',
    'request_too_large',
  ].includes(value));
}

function nonEmptyStreamText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function connectionTimeoutResult(profile: RuntimeModelProfile, timeoutMs: number): ModelConnectionResult {
  return {
    ok: false,
    status: 'offline',
    message: `Model connection test timed out after ${timeoutMs}ms.`,
    model: profile.model,
    clientConcurrency: profile.maxConcurrency,
  };
}

function assertFinalAnswer(answer: string, finishReason: string | undefined): void {
  if (answer.trim().length > 0) return;
  if (finishReason === 'length') {
    throw new Error(
      'Model reached the output-token limit before producing a final answer. Increase the profile output limit or start a new chat.',
    );
  }
  throw new Error('Model stream ended without producing a final answer.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Turn was cancelled.', 'AbortError');
  }
}
