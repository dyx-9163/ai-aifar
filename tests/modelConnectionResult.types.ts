import type { ModelConnectionResult } from '../src/shared/domain';

type ResultBase = { message: string; model: string; clientConcurrency: number };
type Exact<Actual, Expected> =
  [Actual] extends [Expected]
    ? [Expected] extends [Actual]
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type ConnectedResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'connected' }>,
  ResultBase & { ok: true; status: 'connected'; serviceSlots: number }
>>;
type ConcurrencyWarningResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'concurrency-warning' }>,
  ResultBase & { ok: true; status: 'concurrency-warning'; serviceSlots: number }
>>;
type ProviderManagedResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'provider-managed' }>,
  ResultBase & { ok: true; status: 'provider-managed' }
>>;
type SlotsUnverifiedResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'slots-unverified' }>,
  ResultBase & { ok: true; status: 'slots-unverified' }
>>;
type OfflineResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'offline' }>,
  ResultBase & { ok: false; status: 'offline' }
>>;
type ModelMismatchResultIsExact = Assert<Exact<
  Extract<ModelConnectionResult, { status: 'model-mismatch' }>,
  ResultBase & { ok: false; status: 'model-mismatch' }
>>;

export type ModelConnectionResultTypeAssertions =
  | ConnectedResultIsExact
  | ProviderManagedResultIsExact
  | ConcurrencyWarningResultIsExact
  | SlotsUnverifiedResultIsExact
  | OfflineResultIsExact
  | ModelMismatchResultIsExact;
