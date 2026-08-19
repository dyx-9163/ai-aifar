import type { RuntimeModelProfile } from './database.js';
import type { MetricSource, ModelConnectionResult, ModelRunMetrics, ModelRunPhase } from '../shared/domain.js';
import { safeErrorText } from '../shared/redaction.js';
import { validateReasoningSelection } from './modelCapabilities.js';
import { inspectModelConnection } from './modelConnection.js';
import { createStreamTextNormalizer } from './streamTextNormalizer.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

export type ChatMessageContent = string | ChatContentPart[];

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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

const BASE_MODEL_RUN_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_MODEL_RUN_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 150;
const REASONING_TOKEN_TIMEOUT_MS = 450;
const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_ERROR_BYTES = 8_192;
const CONTINUE_AFTER_LENGTH_PROMPT =
  'Continue from exactly where the previous answer stopped. Do not repeat any previous text. Continue until the task is complete.';
const CONTEXT_COMPRESSION_NOTICE = '[Local context compaction active]';
const APPROX_CONTEXT_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_TOKEN_WINDOW = 16_384;
const LONG_CONTEXT_TOKEN_WINDOW = 32_768;
const CONTEXT_COMPRESSION_THRESHOLD = 0.75;
const MIN_CONTINUATION_SECTION_TOKENS = 768;
const MAX_REASONING_RECOVERY_ATTEMPTS = 1;
const OUTPUT_LIMIT_GUIDANCE =
  'Model reached the output-token limit before producing a final answer. Increase the profile output limit or start a new chat.';
const REASONING_RECOVERY_PROMPT =
  'A previous attempt used its entire output budget on internal reasoning and never wrote the answer. Answer the latest user request directly and concisely now; keep any reasoning minimal and always finish with the concrete answer.';

export async function streamChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
  nowMs: () => number = () => Date.now(),
  timeoutMs?: number,
): Promise<ModelRunMetrics> {
  validateReasoningSelection(profile);
  const effectiveTimeoutMs = timeoutMs ?? defaultModelRunTimeoutMs(profile);
  const startedAt = nowMs();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const requestSignal = linkedTimeoutSignal(signal, effectiveTimeoutMs);
  try {
    const operation = (async () => {
      throwIfAborted(requestSignal.signal);
      let firstTokenAt: number | undefined;
      const trackFirstToken = () => {
        firstTokenAt ??= nowMs();
      };
      let allAnswerText = '';
      let attemptMessages = initialRequestMessages(profile, messages);
      let streamedMetrics: StreamedMetrics = {};
      let attemptIndex = 0;
      let contextCompressionLevel = 0;
      let reasoningRecoveriesUsed = 0;

      while (true) {
        throwIfAborted(requestSignal.signal);
        const answerLengthAtAttemptStart = allAnswerText.length;
        let answerDeltasInAttempt = 0;
        let response: Response;
        try {
          if (isContextCompactedMessages(attemptMessages)) {
            await handlers.onPhase('compressing');
          }
          response = await requestChatCompletion(profile, attemptMessages, headers, requestSignal.signal, fetchImpl);
        } catch (error) {
          if ((isContextLimitFailure(error) || isCompressedProviderFailure(error, attemptMessages)) && contextCompressionLevel < 3) {
            contextCompressionLevel += 1;
            attemptMessages = allAnswerText
              ? continuationMessages(profile, messages, allAnswerText, {
                  forceCompress: true,
                  compressionLevel: contextCompressionLevel,
                })
              : initialRequestMessages(profile, messages, {
                  forceCompress: true,
                  compressionLevel: contextCompressionLevel,
                });
            continue;
          }
          if (isCompressedProviderFailure(error, attemptMessages)) {
            throw new Error(
              'Model service failed while processing compressed context. The request was compressed, but the local model server still returned HTTP 500.',
            );
          }
          throw error;
        }

        if (!response.body) {
          throw new Error('Model response did not include a readable stream.');
        }

        const attemptMetrics = await readSseDeltas(
          response.body,
          {
            onAnswerDelta: async (text) => {
              trackFirstToken();
              const update = attemptIndex > 0 && answerDeltasInAttempt === 0
                ? appendContinuationAnswerDelta(allAnswerText, text)
                : appendAnswerDelta(allAnswerText, text);
              answerDeltasInAttempt += 1;
              allAnswerText = update.text;
              if (update.delta) {
                await handlers.onAnswerDelta(update.delta);
              }
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
          allAnswerText.length > 0,
        );
        streamedMetrics = mergeStreamMetrics(streamedMetrics, attemptMetrics);
        if (attemptMetrics.finishReason !== 'length') {
          break;
        }
        if (allAnswerText.length <= answerLengthAtAttemptStart) {
          if (
            allAnswerText.length === 0 &&
            attemptMetrics.reasoningObserved &&
            reasoningRecoveriesUsed < MAX_REASONING_RECOVERY_ATTEMPTS
          ) {
            // Reasoning consumed the whole output budget before any answer existed;
            // ask once for a direct answer instead of surfacing an error.
            reasoningRecoveriesUsed += 1;
            attemptIndex += 1;
            attemptMessages = [
              ...initialRequestMessages(profile, messages, {
                forceCompress: true,
                compressionLevel: contextCompressionLevel,
              }),
              { role: 'user', content: REASONING_RECOVERY_PROMPT },
            ];
            continue;
          }
          if (allAnswerText.length === 0) throw new Error(OUTPUT_LIMIT_GUIDANCE);
          throw new Error('Model reached the output-token limit without making final-answer progress while continuing.');
        }
        attemptMessages = continuationMessages(profile, messages, allAnswerText);
        attemptIndex += 1;
        contextCompressionLevel = 0;
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
    })();
    return await Promise.race([operation, requestSignal.aborted]);
  } catch (error) {
    if (requestSignal.timedOut() && !signal.aborted) {
      throw new Error(`Model request timed out after ${effectiveTimeoutMs}ms.`);
    }
    if (signal.aborted) throw error;
    throw new Error(safeErrorText(error, profile.apiKey ? [profile.apiKey] : [], 500));
  } finally {
    requestSignal.dispose();
  }
}

function defaultModelRunTimeoutMs(profile: RuntimeModelProfile): number {
  const perTokenMs = profile.reasoning.mode === 'disabled'
    ? DEFAULT_TOKEN_TIMEOUT_MS
    : REASONING_TOKEN_TIMEOUT_MS;
  return Math.min(
    MAX_MODEL_RUN_TIMEOUT_MS,
    Math.max(BASE_MODEL_RUN_TIMEOUT_MS, profile.maxOutputTokens * perTokenMs),
  );
}

function initialRequestMessages(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  options: { forceCompress?: boolean; compressionLevel?: number } = {},
): ChatMessage[] {
  if (!options.forceCompress && estimatedMessagesTokens(messages) <= contextCompressionSoftLimit(profile)) {
    return messages;
  }
  return compressedInitialRequestMessages(profile, messages, options.compressionLevel ?? 0);
}

function compressedInitialRequestMessages(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  compressionLevel: number,
): ChatMessage[] {
  const compressionFactor = Math.pow(0.62, Math.max(0, compressionLevel));
  const softLimit = Math.max(
    MIN_CONTINUATION_SECTION_TOKENS * 2,
    Math.floor(contextCompressionSoftLimit(profile) * compressionFactor),
  );
  const systemBudget = Math.max(512, Math.floor(softLimit * 0.12));
  const userBudget = Math.max(MIN_CONTINUATION_SECTION_TOKENS, Math.floor(softLimit * 0.58));
  const historyBudget = Math.max(384, softLimit - systemBudget - userBudget);
  const latestUser = findLatestUserMessage(messages);
  const systemMessages = compactSystemMessages(messages.filter((message) => message.role === 'system'), systemBudget);
  const historyMessages = messages.filter((message) => message.role !== 'system' && message !== latestUser);
  const historySummary = compactHistorySummary(historyMessages, historyBudget);

  return [
    ...systemMessages,
    {
      role: 'user',
      content: [
        CONTEXT_COMPRESSION_NOTICE,
        `The request is near roughly ${Math.round(CONTEXT_COMPRESSION_THRESHOLD * 100)}% of the estimated model context, so earlier chat history was compacted locally before this request.`,
        'Follow the latest user request below. Use the compacted history only as background; do not repeat it back unless needed.',
        'Do not mention this compaction unless the user asks about it.',
        historySummary,
      ].filter(Boolean).join('\n\n'),
    },
    ...(latestUser
      ? [{
          role: 'user' as const,
          content: compactLatestUserMessageContent(
            '[Latest user request, compacted if needed]',
            latestUser.content,
            charsForTokens(userBudget),
          ),
        }]
      : []),
  ];
}

function continuationMessages(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  answerText: string,
  options: { forceCompress?: boolean; compressionLevel?: number } = {},
): ChatMessage[] {
  const fullContinuation: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: answerText },
    { role: 'user', content: CONTINUE_AFTER_LENGTH_PROMPT },
  ];
  if (!options.forceCompress && estimatedMessagesTokens(fullContinuation) <= contextCompressionSoftLimit(profile)) {
    return fullContinuation;
  }
  return compressedContinuationMessages(profile, messages, answerText, options.compressionLevel ?? 0);
}

function compressedContinuationMessages(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  answerText: string,
  compressionLevel: number,
): ChatMessage[] {
  const compressionFactor = Math.pow(0.62, Math.max(0, compressionLevel));
  const softLimit = Math.max(
    MIN_CONTINUATION_SECTION_TOKENS * 3,
    Math.floor(contextCompressionSoftLimit(profile) * compressionFactor),
  );
  const systemBudget = Math.max(512, Math.floor(softLimit * 0.12));
  const userBudget = Math.max(MIN_CONTINUATION_SECTION_TOKENS, Math.floor(softLimit * 0.34));
  const answerTailBudget = Math.max(MIN_CONTINUATION_SECTION_TOKENS, Math.floor(softLimit * 0.42));
  const historyBudget = Math.max(384, softLimit - systemBudget - userBudget - answerTailBudget);
  const latestUser = findLatestUserMessage(messages);
  const systemMessages = compactSystemMessages(messages.filter((message) => message.role === 'system'), systemBudget);
  const historyMessages = messages.filter((message) => message.role !== 'system' && message !== latestUser);
  const historySummary = compactHistorySummary(historyMessages, historyBudget);
  const latestUserMessage = latestUser
    ? {
        role: 'user' as const,
        content: compactLatestUserMessageContent(
          '[Latest user request, compacted if needed]',
          latestUser.content,
          charsForTokens(userBudget),
        ),
      }
    : undefined;

  return [
    ...systemMessages,
    {
      role: 'user',
      content: [
        CONTEXT_COMPRESSION_NOTICE,
        `The request is near roughly ${Math.round(CONTEXT_COMPRESSION_THRESHOLD * 100)}% of the estimated model context, so older context was compacted locally before continuing.`,
        'Use the latest user request and assistant tail below. Continue the same answer from the exact stopping point; do not restart or repeat earlier text.',
        'Do not mention this compaction unless the user asks about it.',
        historySummary,
      ].filter(Boolean).join('\n\n'),
    },
    ...(latestUserMessage ? [latestUserMessage] : []),
    {
      role: 'assistant',
      content: [
        '[Tail of the assistant answer generated so far]',
        compactTail(answerText, charsForTokens(answerTailBudget)),
      ].join('\n'),
    },
    { role: 'user', content: CONTINUE_AFTER_LENGTH_PROMPT },
  ];
}

function contextCompressionSoftLimit(profile: RuntimeModelProfile): number {
  const contextWindow = profile.capabilities.longContext ? LONG_CONTEXT_TOKEN_WINDOW : DEFAULT_CONTEXT_TOKEN_WINDOW;
  const reservedForOutput = Math.max(1_024, profile.maxOutputTokens);
  const usableInputWindow = Math.max(2_048, contextWindow - reservedForOutput - 512);
  return Math.floor(usableInputWindow * CONTEXT_COMPRESSION_THRESHOLD);
}

function estimatedMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateContentTokens(message.content) + 4, 0);
}

function estimateTextTokens(text: string): number {
  let asciiChars = 0;
  let wideChars = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiChars += 1;
    } else {
      wideChars += 1;
    }
  }
  return Math.ceil((asciiChars / APPROX_CONTEXT_CHARS_PER_TOKEN) + wideChars);
}

function estimateContentTokens(content: ChatMessageContent): number {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }
  return content.reduce((total, part) => {
    if (part.type === 'text') {
      return total + estimateTextTokens(part.text);
    }
    return total + 1_024;
  }, 0);
}

function charsForTokens(tokens: number): number {
  return Math.max(256, Math.floor(tokens * APPROX_CONTEXT_CHARS_PER_TOKEN));
}

function compactSystemMessages(messages: ChatMessage[], tokenBudget: number): ChatMessage[] {
  if (messages.length === 0) {
    return [];
  }
  const perMessageBudget = Math.max(256, Math.floor(charsForTokens(tokenBudget) / messages.length));
  return messages.map((message) => ({
    role: 'system' as const,
    content: compactMiddle(contentTextForCompaction(message.content), perMessageBudget),
  }));
}

function findLatestUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index];
    }
  }
  return undefined;
}

function compactHistorySummary(messages: ChatMessage[], tokenBudget: number): string {
  if (messages.length === 0) {
    return '';
  }
  const charBudget = charsForTokens(tokenBudget);
  const snippets: string[] = [];
  let remaining = charBudget;
  for (let index = messages.length - 1; index >= 0 && remaining > 160; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const perMessageBudget = Math.max(160, Math.floor(remaining / 2));
    const snippet = `${message.role.toUpperCase()}: ${compactMiddle(contentTextForCompaction(message.content), perMessageBudget)}`;
    snippets.unshift(snippet);
    remaining -= snippet.length;
  }
  return [
    `[Compacted earlier messages: ${messages.length}]`,
    ...snippets,
  ].join('\n');
}

function compactMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = '\n...[compacted]...\n';
  const side = Math.max(64, Math.floor((maxChars - marker.length) / 2));
  return `${text.slice(0, side)}${marker}${text.slice(-side)}`;
}

function compactTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `...[earlier generated answer compacted]...\n${text.slice(-maxChars)}`;
}

function compactLatestUserMessageContent(note: string, content: ChatMessageContent, maxChars: number): ChatMessageContent {
  if (typeof content === 'string') {
    return `${note}\n${compactMiddle(content, maxChars)}`;
  }
  const compacted = compactLatestUserContent(content, maxChars);
  return [
    { type: 'text', text: note },
    ...(Array.isArray(compacted) ? compacted : [{ type: 'text' as const, text: compacted }]),
  ];
}

function compactLatestUserContent(content: ChatMessageContent, maxChars: number): ChatMessageContent {
  if (typeof content === 'string') {
    return compactMiddle(content, maxChars);
  }
  let remaining = maxChars;
  return content.map((part) => {
    if (part.type === 'image_url') {
      return part;
    }
    const text = compactMiddle(part.text, Math.max(256, remaining));
    remaining = Math.max(0, remaining - text.length);
    return { type: 'text' as const, text };
  });
}

function contentTextForCompaction(content: ChatMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return part.text;
    }
    return '[Image attachment]';
  }).join('\n');
}

function isContextLimitFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Model request exceeds the available context');
}

function isCompressedProviderFailure(error: unknown, messages: ChatMessage[]): boolean {
  if (!isContextCompactedMessages(messages)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Model service failed to process the request (HTTP 500)');
}

function isContextCompactedMessages(messages: ChatMessage[]): boolean {
  return messages.some((message) => contentTextForCompaction(message.content).includes(CONTEXT_COMPRESSION_NOTICE));
}

function appendAnswerDelta(existing: string, incoming: string): { text: string; delta: string } {
  if (!incoming) return { text: existing, delta: '' };
  return { text: existing + incoming, delta: incoming };
}

function appendContinuationAnswerDelta(existing: string, incoming: string): { text: string; delta: string } {
  if (!incoming) return { text: existing, delta: '' };
  if (!existing) return { text: incoming, delta: incoming };
  if (incoming.startsWith(existing)) {
    const delta = incoming.slice(existing.length);
    return { text: existing + delta, delta };
  }
  for (let overlap = Math.min(existing.length, incoming.length); overlap > 0; overlap -= 1) {
    if (existing.endsWith(incoming.slice(0, overlap))) {
      const delta = incoming.slice(overlap);
      return { text: existing + delta, delta };
    }
  }
  return { text: existing + incoming, delta: incoming };
}

function mergeStreamMetrics(left: StreamedMetrics, right: StreamedMetrics): StreamedMetrics {
  const merged: StreamedMetrics = {
    ...left,
    ...right,
  };
  if (left.reasoningObserved || right.reasoningObserved) merged.reasoningObserved = true;
  merged.promptTokens = sumOptional(left.promptTokens, right.promptTokens);
  merged.completionTokens = sumOptional(left.completionTokens, right.completionTokens);
  merged.totalTokens = sumOptional(left.totalTokens, right.totalTokens);
  merged.reasoningTokens = sumOptional(left.reasoningTokens, right.reasoningTokens);
  merged.serverTokensPerSecond = weightedRate(left, right);
  return merged;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function weightedRate(left: StreamedMetrics, right: StreamedMetrics): number | undefined {
  if (left.serverTokensPerSecond === undefined) return right.serverTokensPerSecond;
  if (right.serverTokensPerSecond === undefined) return left.serverTokensPerSecond;
  const leftTokens = left.completionTokens ?? 1;
  const rightTokens = right.completionTokens ?? 1;
  return ((left.serverTokensPerSecond * leftTokens) + (right.serverTokensPerSecond * rightTokens)) / (leftTokens + rightTokens);
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
  allowLengthWithoutAnswer = false,
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
      assertFinalAnswer(answer.value(), metrics.finishReason, allowLengthWithoutAnswer || Boolean(metrics.reasoningObserved));
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
        assertFinalAnswer(answer.value(), metrics.finishReason, allowLengthWithoutAnswer || Boolean(metrics.reasoningObserved));
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

  if (profile.capabilities.reasoning.inputMode === 'toggle') {
    body.chat_template_kwargs = { enable_thinking: profile.reasoning.mode !== 'disabled' };
  }
  if (
    profile.capabilities.reasoning.inputMode === 'effort'
    && profile.reasoning.mode !== 'disabled'
  ) {
    body.reasoning_effort = profile.reasoning.effort;
  }
  if (profile.capabilities.reasoning.inputMode === 'custom') {
    mergeCustomRequestBody(body, profile.capabilities.reasoning.customRequestBody);
  }

  return body;
}

function mergeCustomRequestBody(body: Record<string, unknown>, custom: Record<string, unknown> | undefined): void {
  if (!custom) return;
  for (const [key, value] of Object.entries(custom)) {
    if (key === 'model' || key === 'messages' || key === 'stream') {
      continue;
    }
    const existing = body[key];
    body[key] = isPlainObject(existing) && isPlainObject(value)
      ? { ...existing, ...value }
      : value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function assertFinalAnswer(answer: string, finishReason: string | undefined, allowLengthWithoutAnswer = false): void {
  if (answer.trim().length > 0) return;
  if (finishReason === 'length' && allowLengthWithoutAnswer) return;
  if (finishReason === 'length') {
    throw new Error(OUTPUT_LIMIT_GUIDANCE);
  }
  throw new Error('Model stream ended without producing a final answer.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Turn was cancelled.', 'AbortError');
  }
}
