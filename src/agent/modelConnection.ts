import type {
  ModelConnectionMismatchResult,
  ModelConnectionOfflineResult,
  ModelConnectionResult,
  ModelConnectionSlotsUnverifiedResult,
} from '../shared/domain.js';
import type { RuntimeModelProfile } from './database.js';

export type ModelConnectionFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function inspectModelConnection(
  profile: RuntimeModelProfile,
  fetchImpl: ModelConnectionFetch,
  signal: AbortSignal,
): Promise<ModelConnectionResult> {
  const headers: Record<string, string> = {};
  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  signal.throwIfAborted();
  let modelsResponse: Response;
  try {
    modelsResponse = await withExplicitAbort(
      fetchImpl(`${profile.baseUrl.replace(/\/$/, '')}/models`, { headers, signal }),
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return offlineFailure(profile, 'Model endpoint is unavailable.');
  }
  signal.throwIfAborted();

  if (!modelsResponse.ok) {
    return offlineFailure(profile, `Model endpoint is unavailable (HTTP ${modelsResponse.status}).`);
  }

  let modelPayload: unknown;
  try {
    modelPayload = await withExplicitAbort(modelsResponse.json(), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return offlineFailure(profile, 'Model endpoint returned unusable model metadata.');
  }
  signal.throwIfAborted();
  const modelIds = readModelIds(modelPayload);
  if (!modelIds) {
    return offlineFailure(profile, 'Model endpoint returned unusable model metadata.');
  }
  if (!modelIds.includes(profile.model)) {
    return modelMismatchFailure(profile);
  }

  const baseResult = {
    ok: true as const,
    model: profile.model,
    clientConcurrency: profile.maxConcurrency,
  };
  if (profile.deploymentType === 'cloud') {
    return {
      ...baseResult,
      status: 'provider-managed',
      message: `Connected to ${profile.name} (${profile.model}); concurrency is managed by the cloud provider.`,
    };
  }

  const slotFallbackResult = { ...baseResult, clientConcurrency: 1 };
  if (profile.runtimeType !== 'llama.cpp') {
    return slotsUnverified(profile, slotFallbackResult);
  }

  try {
    signal.throwIfAborted();
    const slotsUrl = `${new URL(profile.baseUrl).origin}/slots`;
    const slotsResponse = await withExplicitAbort(fetchImpl(slotsUrl, { headers, signal }), signal);
    signal.throwIfAborted();
    if (!slotsResponse.ok) return slotsUnverified(profile, slotFallbackResult);
    const slots: unknown = await withExplicitAbort(slotsResponse.json(), signal);
    signal.throwIfAborted();
    const serviceSlots = readServiceSlotCount(slots);
    if (serviceSlots === undefined) return slotsUnverified(profile, slotFallbackResult);

    return {
      ...baseResult,
      clientConcurrency: serviceSlots,
      status: 'connected',
      message: `Connected to ${profile.name} (${profile.model}); detected ${serviceSlots} llama.cpp service slots.`,
      serviceSlots,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return slotsUnverified(profile, slotFallbackResult);
  }
}

function readModelIds(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const ids: string[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') return undefined;
    ids.push(entry.id);
  }
  return ids;
}

function readServiceSlotCount(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const identities = new Set<string>();
  for (const slot of value) {
    if (!isRecord(slot)) return undefined;
    const id = slot.id;
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isInteger(id))) return undefined;
    const identity = `${typeof id}:${String(id)}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
  }
  return value.length;
}

function withExplicitAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Connection test was cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function slotsUnverified(
  profile: RuntimeModelProfile,
  baseResult: { ok: true; model: string; clientConcurrency: number },
): ModelConnectionSlotsUnverifiedResult {
  return {
    ...baseResult,
    status: 'slots-unverified',
    message: `Connected to ${profile.name} (${profile.model}), but service slot concurrency could not be verified.`,
  };
}

function offlineFailure(
  profile: RuntimeModelProfile,
  message: string,
): ModelConnectionOfflineResult {
  return {
    ok: false,
    status: 'offline',
    message,
    model: profile.model,
    clientConcurrency: profile.maxConcurrency,
  };
}

function modelMismatchFailure(profile: RuntimeModelProfile): ModelConnectionMismatchResult {
  return {
    ok: false,
    status: 'model-mismatch',
    message: 'Configured model is not advertised by the model endpoint.',
    model: profile.model,
    clientConcurrency: profile.maxConcurrency,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
