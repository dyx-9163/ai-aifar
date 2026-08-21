import type { ModelCatalogResult } from '../shared/domain.js';
import { safeErrorText } from '../shared/redaction.js';
import type { RuntimeModelProvider } from './database.js';

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const MODEL_CATALOG_TIMEOUT_MS = 15_000;
export const MAX_MODEL_CATALOG_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_CATALOG_ENTRIES = 10_000;

export async function discoverProviderModels(
  provider: RuntimeModelProvider,
  fetchImpl: FetchLike = fetch,
  signal: AbortSignal,
): Promise<ModelCatalogResult> {
  const endpoint = providerEndpoint(provider.baseUrl, provider.catalogPath ?? 'models');
  const response = await fetchWithTimeout(
    endpoint,
    { method: 'GET', headers: providerCatalogHeaders(provider) },
    fetchImpl,
    signal,
  );
  if (response.status === 404 || response.status === 405) {
    return {
      status: 'unsupported',
      models: [],
      warning: 'Model discovery is not supported by this endpoint. Add model IDs manually.',
    };
  }

  const text = await readBoundedText(response, MAX_MODEL_CATALOG_BYTES);
  if (!response.ok) {
    const secrets = [provider.apiKey ?? '', ...Object.values(provider.customHeaders ?? {})];
    throw new Error(safeErrorText(
      `Provider model catalog request failed (${response.status}). ${text}`,
      secrets,
      500,
      'Provider model catalog request failed.',
    ));
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Provider returned an invalid model catalog response.');
  }
  return { status: 'available', models: normalizeCatalogPayload(payload, MAX_MODEL_CATALOG_ENTRIES) };
}

export function providerEndpoint(baseUrl: string, path: string): string {
  const endpoint = new URL(baseUrl);
  const relativePath = path.trim().replace(/^\/+|\/+$/g, '');
  if (!relativePath || /^[a-z][a-z\d+.-]*:/i.test(relativePath)) {
    throw new Error('Catalog path must be a relative path.');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/g, '')}/${relativePath}`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString().replace(/\/$/, '');
}

function providerCatalogHeaders(provider: RuntimeModelProvider): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...provider.customHeaders };
  if (provider.protocol === 'anthropic-messages') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  callerSignal: AbortSignal,
): Promise<Response> {
  if (callerSignal.aborted) throw callerSignal.reason ?? new DOMException('Cancelled', 'AbortError');
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutError = new Error('Provider model catalog request timed out.');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, MODEL_CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchImpl(endpoint, { ...init, signal: controller.signal }), timeout]);
  } catch (error) {
    if (callerSignal.aborted) throw callerSignal.reason ?? new DOMException('Cancelled', 'AbortError');
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Provider model catalog response is too large.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Provider model catalog response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function normalizeCatalogPayload(payload: unknown, maxEntries: number): string[] {
  const source = catalogEntries(payload);
  if (!source) throw new Error('Provider did not return a valid model list.');
  if (source.length > maxEntries) throw new Error('Provider returned too many catalog entries.');

  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    const id = typeof entry === 'string'
      ? entry.trim()
      : entry && typeof entry === 'object'
        ? modelIdFromObject(entry as Record<string, unknown>)
        : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

function catalogEntries(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.models)) return object.models;
  return undefined;
}

function modelIdFromObject(entry: Record<string, unknown>): string {
  const value = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '';
  return value.trim();
}
