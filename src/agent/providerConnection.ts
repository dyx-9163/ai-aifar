import type { ModelProviderInput, ProviderConnectionResult } from '../shared/domain.js';
import { normalizeModelBaseUrl } from '../shared/modelProfileUrl.js';
import { safeErrorText } from '../shared/redaction.js';
import type { AppDatabase, RuntimeModelProfile, RuntimeModelProvider } from './database.js';
import { streamModelResponse, type FetchLike } from './modelProvider.js';

export async function testProviderConnection(
  provider: RuntimeModelProvider,
  modelId: string,
  fetchImpl: FetchLike = fetch,
  signal: AbortSignal,
): Promise<ProviderConnectionResult> {
  const model = modelId.trim();
  if (!model) throw new Error('Model ID is required.');
  const profile = connectionTestProfile(provider, model);
  let answer = '';
  try {
    await streamModelResponse(
      profile,
      [{ role: 'user', content: 'Reply with OK.' }],
      {
        onAnswerDelta: (text) => { answer += text; },
        onRawReasoningDelta: () => undefined,
        onReasoningSummaryDelta: () => undefined,
        onPhase: () => undefined,
      },
      signal,
      fetchImpl,
      undefined,
      Math.min(provider.requestTimeoutMs, 30_000),
    );
    if (!answer.trim()) throw new Error('Provider returned no answer content.');
    return { ok: true, status: 'connected', message: 'Provider inference test succeeded.', model };
  } catch (error) {
    const message = safeErrorText(
      error,
      [provider.apiKey ?? '', ...Object.values(provider.customHeaders ?? {})],
      300,
      'Provider connection test failed.',
    );
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { ok: false, status: 'cancelled', message: 'Provider connection test was cancelled.', model };
    }
    const status = /HTTP (?:401|403)|credentials/i.test(message)
      ? 'authentication-failed'
      : /HTTP 404|protocol/i.test(message)
        ? 'protocol-mismatch'
        : 'offline';
    return { ok: false, status, message, model };
  }
}

export function runtimeProviderFromInput(
  input: ModelProviderInput,
  database: Pick<AppDatabase, 'getModelProviderForRuntime'>,
): RuntimeModelProvider {
  const existing = input.id ? database.getModelProviderForRuntime(input.id) : undefined;
  const now = new Date().toISOString();
  const customHeaders = mergeDraftHeaders(existing?.customHeaders, input.customHeaders);
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  return {
    id: input.id ?? 'unsaved-provider',
    name: input.name.trim(),
    baseUrl: normalizeModelBaseUrl(input.baseUrl.trim()),
    protocol: input.protocol,
    apiKey,
    apiKeyConfigured: Boolean(apiKey),
    maxConcurrency: input.maxConcurrency,
    requestTimeoutMs: input.requestTimeoutMs,
    allowImages: input.allowImages,
    toolCallingMode: input.toolCallingMode,
    thinkingMode: input.thinkingMode,
    customRequestBody: input.customRequestBody,
    customHeaders,
    customHeaderNames: Object.keys(customHeaders).sort(),
    catalogPath: input.catalogPath?.trim() || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function connectionTestProfile(provider: RuntimeModelProvider, model: string): RuntimeModelProfile {
  const now = new Date().toISOString();
  return {
    id: `connection-test:${provider.id}:${model}`,
    providerId: provider.id,
    providerName: provider.name,
    name: model,
    provider: 'openai-compatible',
    deploymentType: 'cloud',
    runtimeType: 'openai-compatible',
    baseUrl: provider.baseUrl,
    model,
    apiKey: provider.apiKey,
    apiKeyConfigured: provider.apiKeyConfigured,
    capabilities: {
      text: true,
      vision: provider.allowImages,
      longContext: false,
      reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: ['raw', 'summary'] },
      concurrency: { defaultLimit: provider.maxConcurrency, configurable: true },
      streaming: true,
      usage: { tokens: true, reasoningTokens: true },
      nativeTools: provider.toolCallingMode === 'native',
    },
    reasoning: { mode: 'disabled', protocol: 'none', display: 'auto' },
    maxConcurrency: provider.maxConcurrency,
    maxOutputTokens: 16,
    responseSpeed: 'standard',
    isDefault: false,
    protocol: provider.protocol,
    requestTimeoutMs: provider.requestTimeoutMs,
    allowImages: provider.allowImages,
    toolCallingMode: provider.toolCallingMode,
    thinkingMode: provider.thinkingMode,
    customRequestBody: provider.customRequestBody,
    customHeaders: provider.customHeaders,
    catalogPath: provider.catalogPath,
    createdAt: now,
    updatedAt: now,
  };
}

function mergeDraftHeaders(
  existing: Record<string, string> | undefined,
  submitted: Record<string, string> | undefined,
): Record<string, string> {
  if (submitted === undefined) return { ...existing };
  return Object.fromEntries(Object.entries(submitted).map(([name, value]) => [
    name.trim(), value.trim() || existing?.[name.trim()] || '',
  ]).filter(([name, value]) => Boolean(name && value)));
}
