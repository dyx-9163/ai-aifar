import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import { openDatabase, type AppDatabase, type RuntimeModelProfile } from '../src/agent/database';
import type { ModelStreamHandlers } from '../src/agent/modelProvider';
import { createWorkerTurnRuntime, type WorkerTurnRuntime } from '../src/agent/worker';

const tempDirectories: string[] = [];
const openDatabases: AppDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // A successful test may already have closed the database explicitly.
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('worker turn runtime', () => {
  it('acknowledges immediately after persisting one queued turn and one user message', () => {
    const harness = createHarness(async () => new Promise(() => undefined));
    const thread = harness.database.createThread('Immediate acknowledgement');

    const acknowledgement = harness.runtime.startTurn({
      type: 'turn.start',
      threadId: thread.id,
      text: 'hello',
      modelProfileId: harness.profile.id,
    });

    expect(acknowledgement).toEqual({ turnId: 'turn-1' });
    expect(harness.database.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'turn-1',
      status: 'queued',
      incomplete: true,
    }));
    expect(harness.database.getSnapshot().items[thread.id]).toMatchObject([
      { id: 'item-turn-1-user', role: 'user', text: 'hello' },
    ]);
    expect(harness.database.getSnapshot().items[thread.id]).toHaveLength(1);
    harness.database.close();
  });

  it('orders queued, started, provider streams, and completion with fixed logical items', async () => {
    const first = deferred<void>();
    const harness = createHarness(async (_profile, messages, handlers, signal) => {
      if (messages.at(-1)?.content === 'block') {
        await abortable(signal, first.promise);
        return metrics();
      }
      await handlers.onPhase('reasoning');
      await handlers.onRawReasoningDelta('raw-1');
      await handlers.onRawReasoningDelta('raw-2');
      await handlers.onReasoningSummaryDelta('summary');
      await handlers.onPhase('answering');
      await handlers.onAnswerDelta('answer-1');
      await handlers.onAnswerDelta('answer-2');
      return metrics();
    });
    const blocker = harness.database.createThread('Blocker');
    const queued = harness.database.createThread('Queued');
    harness.runtime.startTurn({ type: 'turn.start', threadId: blocker.id, text: 'block', modelProfileId: harness.profile.id });
    const { turnId } = harness.runtime.startTurn({ type: 'turn.start', threadId: queued.id, text: 'run', modelProfileId: harness.profile.id });
    await flushMicrotasks();

    expect(typesFor(harness.events, turnId)).toEqual(['turn.queued']);
    first.resolve();
    await eventually(() => expect(typesFor(harness.events, turnId)).toEqual([
      'turn.queued',
      'turn.started',
      'tool.started',
      'model.progress',
      'reasoning.raw.delta',
      'reasoning.raw.delta',
      'reasoning.summary.delta',
      'model.progress',
      'answer.delta',
      'answer.delta',
      'model.metrics',
      'turn.completed',
    ]));

    const snapshot = harness.database.getSnapshot();
    expect(snapshot.turns.find((turn) => turn.id === turnId)).toMatchObject({ status: 'completed', incomplete: false });
    expect(snapshot.items[queued.id]).toMatchObject([
      { id: `item-${turnId}-user`, text: 'run' },
      { id: `item-${turnId}-reasoning-raw`, text: 'raw-1raw-2', incomplete: false },
      { id: `item-${turnId}-reasoning-summary`, text: 'summary', incomplete: false },
      { id: `item-${turnId}-assistant`, text: 'answer-1answer-2', incomplete: false },
    ]);
    harness.database.close();
  });

  it('runs different model profiles concurrently while rejecting a second turn in the same thread', async () => {
    const running: string[] = [];
    const releases = new Map<string, ReturnType<typeof deferred<void>>>();
    const harness = createHarness(async (profile, _messages, _handlers, signal) => {
      running.push(profile.id);
      const release = deferred<void>();
      releases.set(profile.id, release);
      await abortable(signal, release.promise);
      return metrics();
    });
    const secondProfile = saveProfile(harness.database, 'model-2', 'Model 2', 1);
    const firstThread = harness.database.createThread('First');
    const secondThread = harness.database.createThread('Second');
    harness.runtime.startTurn({ type: 'turn.start', threadId: firstThread.id, text: 'one', modelProfileId: harness.profile.id });
    harness.runtime.startTurn({ type: 'turn.start', threadId: secondThread.id, text: 'two', modelProfileId: secondProfile.id });
    expect(() => harness.runtime.startTurn({
      type: 'turn.start',
      threadId: firstThread.id,
      text: 'duplicate',
      modelProfileId: secondProfile.id,
    })).toThrow('already has an active turn');

    await eventually(() => expect(running).toEqual([harness.profile.id, secondProfile.id]));
    releases.get(harness.profile.id)?.resolve();
    releases.get(secondProfile.id)?.resolve();
    await eventually(() => expect(harness.database.getSnapshot().turns.filter((turn) => turn.status === 'completed')).toHaveLength(2));
    harness.database.close();
  });

  it('creates distinct default turn ids for starts in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_797_465_600_000);
    const harness = createHarness(async () => new Promise(() => undefined), undefined, false);
    const secondProfile = saveProfile(harness.database, 'model-2', 'Model 2', 1);
    const firstThread = harness.database.createThread('First');
    const secondThread = harness.database.createThread('Second');

    const first = harness.runtime.startTurn({
      type: 'turn.start', threadId: firstThread.id, text: 'one', modelProfileId: harness.profile.id,
    });
    const second = harness.runtime.startTurn({
      type: 'turn.start', threadId: secondThread.id, text: 'two', modelProfileId: secondProfile.id,
    });

    expect(first.turnId).not.toBe(second.turnId);
    harness.database.close();
  });

  it('keeps a demo approval turn active until the recorded response completes it', async () => {
    const harness = createHarness(async () => metrics());
    const thread = harness.database.createThread('Approval');
    const { turnId } = harness.runtime.startTurn({
      type: 'turn.start',
      threadId: thread.id,
      text: '修改配置文件',
      modelProfileId: harness.profile.id,
    });
    await eventually(() => expect(typesFor(harness.events, turnId)).toContain('approval.required'));

    expect(() => harness.runtime.startTurn({
      type: 'turn.start',
      threadId: thread.id,
      text: 'must wait',
      modelProfileId: harness.profile.id,
    })).toThrow('already has an active turn');
    expect(harness.runtime.respondApproval(`approval-${turnId}`, true)).toBe(true);
    expect(harness.runtime.respondApproval(`approval-${turnId}`, true)).toBe(false);

    await eventually(() => expect(typesFor(harness.events, turnId).at(-1)).toBe('turn.completed'));
    expect(harness.database.getSnapshot().items[thread.id]).toContainEqual(expect.objectContaining({
      id: `item-${turnId}-assistant`,
      text: 'Approval accepted. Demo mode still keeps the filesystem unchanged.',
      incomplete: false,
    }));
    harness.database.close();
  });

  it('cancels a queued turn once and keeps streamed content incomplete', async () => {
    const blocker = deferred<void>();
    const harness = createHarness(async (_profile, messages, handlers, signal) => {
      if (messages.at(-1)?.content === 'block') {
        await abortable(signal, blocker.promise);
      } else {
        await handlers.onAnswerDelta('must-not-run');
      }
      return metrics();
    });
    const firstThread = harness.database.createThread('First');
    const queuedThread = harness.database.createThread('Queued');
    harness.runtime.startTurn({ type: 'turn.start', threadId: firstThread.id, text: 'block', modelProfileId: harness.profile.id });
    const { turnId } = harness.runtime.startTurn({ type: 'turn.start', threadId: queuedThread.id, text: 'queued', modelProfileId: harness.profile.id });
    await flushMicrotasks();

    expect(harness.runtime.cancelTurn(turnId)).toBe(true);
    expect(harness.runtime.cancelTurn(turnId)).toBe(false);
    await eventually(() => expect(typesFor(harness.events, turnId).filter((type) => type === 'turn.cancelled')).toHaveLength(1));
    expect(harness.database.getSnapshot().turns.find((turn) => turn.id === turnId)).toMatchObject({
      status: 'cancelled',
      incomplete: true,
    });
    expect(harness.database.getSnapshot().items[queuedThread.id]).toMatchObject([
      { id: `item-${turnId}-user`, text: 'queued' },
    ]);
    blocker.resolve();
    harness.database.close();
  });

  it('cancels a running turn idempotently without a failed or completed terminal', async () => {
    const harness = createHarness(async (_profile, _messages, handlers, signal) => {
      await handlers.onAnswerDelta('partial');
      await abortable(signal, new Promise<void>(() => undefined));
      return metrics();
    });
    const thread = harness.database.createThread('Running');
    const { turnId } = harness.runtime.startTurn({ type: 'turn.start', threadId: thread.id, text: 'run', modelProfileId: harness.profile.id });
    await eventually(() => expect(typesFor(harness.events, turnId)).toContain('answer.delta'));

    expect(harness.runtime.cancelTurn(turnId)).toBe(true);
    expect(harness.runtime.cancelTurn(turnId)).toBe(false);
    await eventually(() => expect(typesFor(harness.events, turnId).at(-1)).toBe('turn.cancelled'));

    expect(typesFor(harness.events, turnId).filter((type) => type === 'turn.cancelled')).toHaveLength(1);
    expect(typesFor(harness.events, turnId)).not.toContain('turn.failed');
    expect(typesFor(harness.events, turnId)).not.toContain('turn.completed');
    expect(harness.database.getSnapshot().turns.find((turn) => turn.id === turnId)).toMatchObject({ status: 'cancelled', incomplete: true });
    expect(harness.database.getSnapshot().items[thread.id]).toContainEqual(expect.objectContaining({
      id: `item-${turnId}-assistant`, text: 'partial', incomplete: true,
    }));
    harness.database.close();
  });

  it('persists and emits a visible redacted provider failure once', async () => {
    const harness = createHarness(async (profile) => {
      throw new Error(`Authorization: Bearer ${profile.apiKey}; upstream exploded`);
    }, 'super-secret-key');
    const thread = harness.database.createThread('Failure');
    const { turnId } = harness.runtime.startTurn({ type: 'turn.start', threadId: thread.id, text: 'fail', modelProfileId: harness.profile.id });
    await eventually(() => expect(typesFor(harness.events, turnId).at(-1)).toBe('turn.failed'));

    const failed = harness.events.find((event) => event.type === 'turn.failed' && event.turnId === turnId);
    expect(failed).toMatchObject({ type: 'turn.failed' });
    expect(failed && 'error' in failed ? failed.error : '').toContain('upstream exploded');
    expect(JSON.stringify(failed)).not.toContain('super-secret-key');
    expect(harness.database.getSnapshot().turns.find((turn) => turn.id === turnId)).toMatchObject({
      status: 'failed',
      incomplete: true,
      error: expect.not.stringContaining('super-secret-key'),
    });
    harness.database.close();
  });

  it('ignores provider deltas and terminals that arrive after completion', async () => {
    let capturedHandlers: ModelStreamHandlers | undefined;
    const harness = createHarness(async (_profile, _messages, handlers) => {
      capturedHandlers = handlers;
      await handlers.onAnswerDelta('final');
      return metrics();
    });
    const thread = harness.database.createThread('Late events');
    const { turnId } = harness.runtime.startTurn({ type: 'turn.start', threadId: thread.id, text: 'run', modelProfileId: harness.profile.id });
    await eventually(() => expect(typesFor(harness.events, turnId).at(-1)).toBe('turn.completed'));

    await capturedHandlers?.onAnswerDelta('late');
    await capturedHandlers?.onRawReasoningDelta('late reasoning');
    await flushMicrotasks();

    const snapshot = harness.database.getSnapshot();
    expect(snapshot.items[thread.id].find((item) => item.id === `item-${turnId}-assistant`)).toMatchObject({ text: 'final' });
    expect(snapshot.items[thread.id].some((item) => item.kind === 'reasoning')).toBe(false);
    expect(typesFor(harness.events, turnId).at(-1)).toBe('turn.completed');
    harness.database.close();
  });
});

function createHarness(
  streamModel: (
    profile: RuntimeModelProfile,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    handlers: ModelStreamHandlers,
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof metrics>>,
  apiKey?: string,
  deterministicIds = true,
): {
  database: AppDatabase;
  profile: RuntimeModelProfile;
  runtime: WorkerTurnRuntime;
  events: AgentEvent[];
} {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-worker-'));
  tempDirectories.push(directory);
  const database = openDatabase(join(directory, 'app.db'));
  openDatabases.push(database);
  const profile = saveProfile(database, 'model-1', 'Model 1', 1, apiKey);
  const events: AgentEvent[] = [];
  let nextTurn = 1;
  let clock = 0;
  const runtime = createWorkerTurnRuntime({
    database,
    postEvent: (event) => events.push(event),
    streamModel,
    createTurnId: deterministicIds ? () => `turn-${nextTurn++}` : undefined,
    now: () => new Date(Date.UTC(2026, 7, 17, 0, 0, clock++)).toISOString(),
  });
  return { database, profile: database.getModelProfileForRuntime(profile.id)!, runtime, events };
}

function saveProfile(database: AppDatabase, id: string, name: string, maxConcurrency: number, apiKey?: string): RuntimeModelProfile {
  database.saveModelProfile({
    id,
    name,
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: id,
    apiKey,
    capabilities: {
      reasoning: { inputMode: 'toggle', outputModes: ['raw', 'summary'] },
      concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
    },
    reasoning: { mode: 'enabled', protocol: 'qwen', display: 'auto' },
    maxConcurrency,
  });
  return database.getModelProfileForRuntime(id)!;
}

function metrics() {
  return {
    reasoningRequested: 'enabled' as const,
    reasoningProtocol: 'qwen' as const,
    reasoningObserved: true,
    durationMs: 1,
    speedSource: 'client' as const,
    usageSource: 'server' as const,
  };
}

function typesFor(events: AgentEvent[], turnId: string): string[] {
  return events.filter((event) => event.type !== 'snapshot' && event.turnId === turnId).map((event) => event.type);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
    void promise.then(resolve, reject);
  });
}

function abortError(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (index === 99) throw error;
      await flushMicrotasks();
    }
  }
}
