import type { ModelProvider, ModelProviderInput, ProviderProtocol } from '../shared/domain.js';

export interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKey: string;
  apiKeyConfigured: boolean;
  maxConcurrency: number;
  requestTimeoutMs: number;
  allowImages: boolean;
  toolCallingMode: 'native' | 'text-fallback';
  thinkingMode: 'model-default' | 'custom';
  customRequestBodyText: string;
  customHeaders: Record<string, string>;
  catalogPath: string;
}

export function createProviderDraft(): ProviderDraft {
  return {
    id: undefined,
    name: '',
    baseUrl: '',
    protocol: 'openai-chat-completions',
    apiKey: '',
    apiKeyConfigured: false,
    maxConcurrency: 1,
    requestTimeoutMs: 300_000,
    allowImages: false,
    toolCallingMode: 'native',
    thinkingMode: 'model-default',
    customRequestBodyText: '',
    customHeaders: {},
    catalogPath: '',
  };
}

export function loadProviderDraft(provider: ModelProvider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    apiKey: '',
    apiKeyConfigured: provider.apiKeyConfigured,
    maxConcurrency: provider.maxConcurrency,
    requestTimeoutMs: provider.requestTimeoutMs,
    allowImages: provider.allowImages,
    toolCallingMode: provider.toolCallingMode,
    thinkingMode: provider.thinkingMode,
    customRequestBodyText: provider.customRequestBody
      ? JSON.stringify(provider.customRequestBody, null, 2)
      : '',
    customHeaders: Object.fromEntries(provider.customHeaderNames.map((name) => [name, ''])),
    catalogPath: provider.catalogPath ?? '',
  };
}

export function buildModelProviderInput(draft: ProviderDraft): ModelProviderInput {
  const issue = providerDraftValidationIssue(draft);
  if (issue) throw new Error(issue);
  const customRequestBody = draft.customRequestBodyText.trim()
    ? JSON.parse(draft.customRequestBodyText) as Record<string, unknown>
    : undefined;
  return {
    id: draft.id,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    protocol: draft.protocol,
    apiKey: draft.apiKey.trim() || undefined,
    maxConcurrency: draft.maxConcurrency,
    requestTimeoutMs: draft.requestTimeoutMs,
    allowImages: draft.allowImages,
    toolCallingMode: draft.toolCallingMode,
    thinkingMode: draft.thinkingMode,
    customRequestBody,
    customHeaders: Object.fromEntries(Object.entries(draft.customHeaders).map(([name, value]) => [name.trim(), value.trim()])),
    catalogPath: draft.catalogPath.trim() || undefined,
  };
}

export function providerDraftValidationIssue(draft: ProviderDraft): string | undefined {
  if (!draft.name.trim()) return 'Provider name is required.';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Provider URL must use HTTP or HTTPS.';
  } catch {
    return 'Provider URL is invalid.';
  }
  if (!Number.isInteger(draft.maxConcurrency) || draft.maxConcurrency < 1) return 'Concurrency must be a positive integer.';
  if (!Number.isInteger(draft.requestTimeoutMs) || draft.requestTimeoutMs < 1) return 'Timeout must be a positive integer.';
  if (draft.customRequestBodyText.trim()) {
    try {
      const value: unknown = JSON.parse(draft.customRequestBodyText);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Custom JSON must be an object.';
    } catch {
      return 'Custom JSON is invalid.';
    }
  }
  if (Object.keys(draft.customHeaders).some((name) => !name.trim())) return 'Custom header names cannot be blank.';
  return undefined;
}

export function providerDraftFingerprint(draft: ProviderDraft): string {
  return JSON.stringify({
    id: draft.id,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    protocol: draft.protocol,
    apiKey: draft.apiKey ? secretMarker(draft.apiKey) : draft.apiKeyConfigured ? 'saved' : 'none',
    maxConcurrency: draft.maxConcurrency,
    requestTimeoutMs: draft.requestTimeoutMs,
    allowImages: draft.allowImages,
    toolCallingMode: draft.toolCallingMode,
    thinkingMode: draft.thinkingMode,
    customRequestBody: secretMarker(draft.customRequestBodyText),
    customHeaders: Object.entries(draft.customHeaders)
      .map(([name, value]) => [name.trim(), value ? secretMarker(value) : 'saved'])
      .sort(([left], [right]) => left.localeCompare(right)),
    catalogPath: draft.catalogPath.trim(),
  });
}

export function createProviderOperationState() {
  return { discovery: 'idle' as const, connection: 'untested' as const };
}

function secretMarker(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `h${(hash >>> 0).toString(36)}:${value.length}`;
}
