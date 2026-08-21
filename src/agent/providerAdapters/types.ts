import type { ProviderProtocol } from '../../shared/domain.js';
import type { RuntimeModelProfile } from '../database.js';
import type {
  ChatMessage,
  FetchLike,
  ModelStreamHandlers,
  StreamedMetrics,
} from '../modelProvider.js';
import type { NativeToolSchema } from '../tools/toolSchemas.js';

export interface ProviderStreamInput {
  profile: RuntimeModelProfile;
  messages: ChatMessage[];
  handlers: ModelStreamHandlers;
  signal: AbortSignal;
  fetchImpl: FetchLike;
  headers: Record<string, string>;
  tools?: readonly NativeToolSchema[];
  allowLengthWithoutAnswer: boolean;
}

export type ProviderStreamResult = StreamedMetrics;

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export async function readProviderSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen = new Map<string, string>();
  let buffer = '';
  let eventName = 'message';
  let eventId: string | undefined;
  let data: string[] = [];

  const dispatch = async (): Promise<boolean> => {
    const payload = data.join('\n');
    const name = eventName;
    const id = eventId;
    data = [];
    eventName = 'message';
    eventId = undefined;
    if (!payload) return false;
    if (id) {
      const previous = seen.get(id);
      if (previous !== undefined) {
        if (previous !== `${name}\0${payload}`) throw new Error('Provider reused an SSE event identifier with conflicting data.');
        return false;
      }
      seen.set(id, `${name}\0${payload}`);
    }
    return Boolean(await onEvent({ event: name, data: payload, id }));
  };

  const consume = async (line: string): Promise<boolean> => {
    if (!line) return dispatch();
    if (line.startsWith(':')) return false;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = (separator < 0 ? '' : line.slice(separator + 1)).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'id' && !value.includes('\0')) eventId = value;
    else if (field === 'data') data.push(value);
    return false;
  };

  const abort = () => signal.reason ?? new DOMException('Turn was cancelled.', 'AbortError');
  try {
    while (true) {
      if (signal.aborted) throw abort();
      const result = await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
        const onAbort = () => reject(abort());
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
      if (result.done) {
        buffer += decoder.decode();
        if (buffer && await consume(buffer.replace(/\r$/, ''))) return;
        if (data.length > 0) await dispatch();
        return;
      }
      if (!result.value) continue;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (await consume(line.replace(/\r$/, ''))) return;
      }
    }
  } finally {
    try { void reader.cancel().catch(() => undefined); } catch { /* stream already closed */ }
    try { reader.releaseLock(); } catch { /* pending provider read */ }
  }
}

export function adapterHeaders(input: ProviderStreamInput, kind: 'openai' | 'anthropic'): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...input.profile.customHeaders,
  };
  if (kind === 'anthropic') {
    if (input.profile.apiKey) headers['x-api-key'] = input.profile.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (input.profile.apiKey) {
    headers.Authorization = `Bearer ${input.profile.apiKey}`;
  }
  return headers;
}

export function mergeCustomFields(
  body: Record<string, unknown>,
  custom: Record<string, unknown> | undefined,
  protectedFields: readonly string[],
): void {
  if (!custom) return;
  const protectedSet = new Set(protectedFields);
  for (const [key, value] of Object.entries(custom)) {
    if (protectedSet.has(key)) continue;
    const current = body[key];
    body[key] = isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
}

export function requireResponseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.ok) throw providerHttpError(response.status);
  if (!response.body) throw new Error('Model response did not include a readable stream.');
  return response.body;
}

export function providerHttpError(status: number): Error {
  if (status === 401 || status === 403) return new Error(`Model request was rejected (HTTP ${status}). Check the provider credentials.`);
  if (status === 404) return new Error('Model request failed with HTTP 404. Check the provider URL, protocol, and model.');
  if (status === 429) return new Error('Model service rate-limited the request (HTTP 429). Try again later.');
  if (status >= 500) return new Error(`Model service failed to process the request (HTTP ${status}).`);
  return new Error(`Model request failed with HTTP ${status}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
