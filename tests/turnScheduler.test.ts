import { describe, expect, it } from 'vitest';
import {
  ModelTurnScheduler,
  type ScheduledTurn,
  type SchedulerCallbacks,
} from '../src/agent/turnScheduler';

describe('ModelTurnScheduler', () => {
  it('runs same-model turns in FIFO order at limit one', async () => {
    const first = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1']);
    expect(harness.queued).toContainEqual(['turn-2', 1]);

    first.resolve();
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1', 'turn-2']);
  });

  it('uses independent capacity for different models', async () => {
    const modelOne = deferred<void>();
    const modelTwo = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => modelOne.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-2', () => modelTwo.promise));
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1', 'turn-2']);

    modelOne.resolve();
    modelTwo.resolve();
    await flushMicrotasks();
  });

  it('shares one capacity limit across different models from the same provider', async () => {
    const first = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-a', () => first.promise, 'provider-1'));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-b', async () => undefined, 'provider-1'));
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1']);
    expect(harness.queued).toContainEqual(['turn-2', 1]);

    first.resolve();
    await flushMicrotasks();
    expect(harness.started).toEqual(['turn-1', 'turn-2']);
  });

  it('cancels a queued turn before it starts and releases its thread', async () => {
    const first = deferred<void>();
    let secondRan = false;
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => {
      secondRan = true;
    }));
    await flushMicrotasks();

    expect(harness.scheduler.cancel('turn-2')).toBe(true);
    expect(harness.scheduler.cancel('turn-2')).toBe(false);
    await flushMicrotasks();

    expect(secondRan).toBe(false);
    expect(harness.cancelled).toEqual([['turn-2', false]]);
    expect(harness.scheduler.hasActiveThread('thread-2')).toBe(false);

    first.resolve();
    await flushMicrotasks();
  });

  it('aborts a running turn and reports cancellation exactly once', async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', (signal) => {
      observedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }));
    await flushMicrotasks();

    expect(harness.scheduler.cancel('turn-1')).toBe(true);
    expect(harness.scheduler.cancel('turn-1')).toBe(false);
    await flushMicrotasks();

    expect(observedSignal?.aborted).toBe(true);
    expect(harness.cancelled).toEqual([['turn-1', true]]);
    expect(harness.scheduler.hasActiveThread('thread-1')).toBe(false);
  });

  it('releases a slot when run rejects', async () => {
    const first = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    first.reject(new Error('provider failed'));
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1', 'turn-2']);
    expect(harness.cancelled).toEqual([]);
  });

  it('starts queued work when a model limit increases', async () => {
    let limit = 1;
    const first = deferred<void>();
    const second = deferred<void>();
    const harness = createHarness(() => limit);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', () => second.promise));
    await flushMicrotasks();
    expect(harness.started).toEqual(['turn-1']);

    limit = 2;
    harness.scheduler.updateLimit('model-1');
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1', 'turn-2']);

    first.resolve();
    second.resolve();
    await flushMicrotasks();
  });

  it('does not abort running work when a model limit decreases', async () => {
    let limit = 2;
    const first = deferred<void>();
    const second = deferred<void>();
    const harness = createHarness(() => limit);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', () => second.promise));
    harness.scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => undefined));
    await flushMicrotasks();
    expect(harness.started).toEqual(['turn-1', 'turn-2']);

    limit = 1;
    harness.scheduler.updateLimit('model-1');
    first.resolve();
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1', 'turn-2']);
    expect(harness.cancelled).toEqual([]);

    second.resolve();
    await flushMicrotasks();
    expect(harness.started).toEqual(['turn-1', 'turn-2', 'turn-3']);
  });

  it('rejects a second turn for a running thread', () => {
    const first = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));

    expect(() => harness.scheduler.enqueue(
      task('turn-2', 'thread-1', 'model-2', async () => undefined),
    )).toThrow(/thread.*active/i);

    first.resolve();
  });

  it('rejects a second turn for a queued thread', () => {
    const blocker = deferred<void>();
    const harness = createHarness(() => 1);

    harness.scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', async () => undefined));

    expect(() => harness.scheduler.enqueue(
      task('turn-2', 'thread-1', 'model-2', async () => undefined),
    )).toThrow(/thread.*active/i);

    blocker.resolve();
  });

  it('clamps effective limits to one and emits deterministic valid queue positions', async () => {
    const first = deferred<void>();
    const harness = createHarness(() => 0);

    harness.scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    harness.scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    harness.scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(harness.started).toEqual(['turn-1']);
    expect(harness.positionSnapshots.at(-1)).toEqual([
      ['turn-2', 1],
      ['turn-3', 2],
    ]);
    expect(harness.positionSnapshots.flatMap((snapshot) => snapshot.map(([, position]) => position)))
      .toEqual(expect.arrayContaining([1, 2]));
    expect(harness.positionSnapshots.flat().every(([, position]) => position >= 1)).toBe(true);

    expect(harness.scheduler.cancel('turn-2')).toBe(true);
    await flushMicrotasks();
    expect(harness.positionSnapshots.at(-1)).toEqual([['turn-3', 1]]);

    first.resolve();
    await flushMicrotasks();
    expect(harness.started).toEqual(['turn-1', 'turn-3']);
    expect(harness.positionSnapshots.at(-1)).toEqual([]);
  });

  it('finishes an asynchronous queued callback before starting that turn', async () => {
    const first = deferred<void>();
    const queuedCallback = deferred<void>();
    const events: string[] = [];
    const scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: async (turn) => {
        await queuedCallback.promise;
        events.push(`queued:${turn.turnId}`);
      },
      onStarted: (turn) => events.push(`started:${turn.turnId}`),
      onCancelled: () => undefined,
      onQueuePositions: () => undefined,
    });

    scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    first.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['started:turn-1']);

    queuedCallback.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['started:turn-1', 'queued:turn-2', 'started:turn-2']);
  });

  it('serializes asynchronous queue position updates for each model', async () => {
    const first = deferred<void>();
    const firstQueuedUpdate = deferred<void>();
    const applied: Array<Array<[string, number]>> = [];
    const scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: () => undefined,
      onStarted: () => undefined,
      onCancelled: () => undefined,
      onQueuePositions: async (_modelProfileId, positions) => {
        const snapshot = [...positions.entries()];
        if (snapshot.length === 1) {
          await firstQueuedUpdate.promise;
        }
        applied.push(snapshot);
      },
    });

    scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(applied).toEqual([[]]);

    firstQueuedUpdate.resolve();
    await flushMicrotasks();
    expect(applied).toEqual([
      [],
      [['turn-2', 1]],
      [['turn-2', 1], ['turn-3', 2]],
    ]);

    first.resolve();
    await flushMicrotasks();
  });

  it('applies pending queue position updates before starting queued work', async () => {
    const first = deferred<void>();
    const queuedPosition = deferred<void>();
    const events: string[] = [];
    const scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: (turn) => events.push(`queued:${turn.turnId}`),
      onStarted: (turn) => events.push(`started:${turn.turnId}`),
      onCancelled: () => undefined,
      onQueuePositions: async (_modelProfileId, positions) => {
        if (positions.size === 1) {
          await queuedPosition.promise;
          events.push('position:queued');
        }
      },
    });

    scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    first.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['started:turn-1', 'queued:turn-2']);

    queuedPosition.resolve();
    await flushMicrotasks();
    expect(events).toEqual([
      'started:turn-1',
      'queued:turn-2',
      'position:queued',
      'started:turn-2',
    ]);
  });

  it('promotes queued turns in FIFO order when their queued callbacks resolve out of order', async () => {
    let limit = 1;
    const blocker = deferred<void>();
    const secondQueued = deferred<void>();
    const thirdQueued = deferred<void>();
    const started: string[] = [];
    const ran: string[] = [];
    const scheduler = new ModelTurnScheduler(() => limit, {
      onQueued: (turn) => {
        if (turn.turnId === 'turn-2') return secondQueued.promise;
        if (turn.turnId === 'turn-3') return thirdQueued.promise;
      },
      onStarted: (turn) => started.push(turn.turnId),
      onCancelled: () => undefined,
      onQueuePositions: () => undefined,
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => {
      ran.push('turn-2');
    }));
    scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => {
      ran.push('turn-3');
    }));
    await flushMicrotasks();

    limit = 3;
    scheduler.updateLimit('model-1');
    thirdQueued.resolve();
    await flushMicrotasks();

    expect(started).toEqual(['blocker']);
    expect(ran).toEqual([]);

    secondQueued.resolve();
    await flushMicrotasks();
    expect(started).toEqual(['blocker', 'turn-2', 'turn-3']);
    expect(ran).toEqual(['turn-2', 'turn-3']);

    blocker.resolve();
    await flushMicrotasks();
  });

  it('does not let a blocked model promotion stall another model', async () => {
    const blocker = deferred<void>();
    const queuedCallback = deferred<void>();
    const started: string[] = [];
    const scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: (turn) => turn.modelProfileId === 'model-1' ? queuedCallback.promise : undefined,
      onStarted: (turn) => started.push(turn.turnId),
      onCancelled: () => undefined,
      onQueuePositions: () => undefined,
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('model-1-queued', 'thread-1', 'model-1', async () => undefined));
    scheduler.enqueue(task('model-2-turn', 'thread-2', 'model-2', async () => undefined));
    await flushMicrotasks();

    expect(started).toEqual(['blocker', 'model-2-turn']);

    queuedCallback.resolve();
    blocker.resolve();
    await flushMicrotasks();
  });

  it('cancels a reserved pre-start turn as queued and drains the released slot', async () => {
    let limit = 1;
    let blockPromotedPositions = false;
    const blocker = deferred<void>();
    const promotedPositions = deferred<void>();
    const started: string[] = [];
    const ran: string[] = [];
    const cancelled: Array<[string, boolean]> = [];
    const scheduler = new ModelTurnScheduler(() => limit, {
      onQueued: () => undefined,
      onStarted: (turn) => started.push(turn.turnId),
      onCancelled: (turn, wasRunning) => cancelled.push([turn.turnId, wasRunning]),
      onQueuePositions: async (_modelProfileId, positions) => {
        if (blockPromotedPositions && positions.size === 1 && positions.has('turn-3')) {
          await promotedPositions.promise;
        }
      },
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', abortableRun('turn-2', ran)));
    scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => {
      ran.push('turn-3');
    }));
    await flushMicrotasks();

    blockPromotedPositions = true;
    limit = 2;
    scheduler.updateLimit('model-1');
    expect(scheduler.cancel('turn-2')).toBe(true);
    expect(scheduler.cancel('turn-2')).toBe(false);
    await flushMicrotasks();

    promotedPositions.resolve();
    await flushMicrotasks();

    expect(started).not.toContain('turn-2');
    expect(ran).not.toContain('turn-2');
    expect(cancelled).toContainEqual(['turn-2', false]);
    expect(started).toContain('turn-3');

    blocker.resolve();
    await flushMicrotasks();
  });

  it('requeues all excess reservations when the live limit drops to one', async () => {
    let limit = 1;
    let blockNextEmptyModelOneSnapshot = false;
    const blocker = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const promotionWindow = deferred<void>();
    const started: string[] = [];
    const ran: string[] = [];
    const queued: string[] = [];
    const cancelled: Array<[string, boolean]> = [];
    const positions: Array<Array<[string, number]>> = [];
    const scheduler = new ModelTurnScheduler(() => limit, {
      onQueued: (turn) => queued.push(turn.turnId),
      onStarted: (turn) => started.push(turn.turnId),
      onCancelled: (turn, wasRunning) => cancelled.push([turn.turnId, wasRunning]),
      onQueuePositions: async (modelProfileId, snapshot) => {
        if (modelProfileId !== 'model-1') return;
        if (blockNextEmptyModelOneSnapshot && snapshot.size === 0) {
          blockNextEmptyModelOneSnapshot = false;
          await promotionWindow.promise;
        }
        positions.push([...snapshot.entries()]);
      },
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => {
      ran.push('turn-2');
      await second.promise;
    }));
    scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => {
      ran.push('turn-3');
      await third.promise;
    }));
    await flushMicrotasks();

    blockNextEmptyModelOneSnapshot = true;
    limit = 3;
    scheduler.updateLimit('model-1');
    limit = 1;
    scheduler.updateLimit('model-1');
    scheduler.enqueue(task('model-2-turn', 'thread-model-2', 'model-2', async () => undefined));
    await flushMicrotasks();

    expect(started).toEqual(['blocker', 'model-2-turn']);

    promotionWindow.resolve();
    await flushMicrotasks();

    expect(started).toEqual(['blocker', 'model-2-turn']);
    expect(ran).toEqual([]);
    expect(positions.at(-1)).toEqual([['turn-2', 1], ['turn-3', 2]]);
    expect(queued).toEqual(['turn-2', 'turn-3']);
    expect(cancelled).toEqual([]);
    expect(scheduler.hasActiveThread('thread-2')).toBe(true);
    expect(scheduler.hasActiveThread('thread-3')).toBe(true);
    expect(() => scheduler.enqueue(
      task('duplicate', 'thread-2', 'model-2', async () => undefined),
    )).toThrow(/thread.*active/i);

    limit = 3;
    scheduler.updateLimit('model-1');
    await flushMicrotasks();
    expect(started).toEqual(['blocker', 'model-2-turn', 'turn-2', 'turn-3']);
    expect(ran).toEqual(['turn-2', 'turn-3']);
    expect(queued).toEqual(['turn-2', 'turn-3']);
    expect(cancelled).toEqual([]);

    blocker.resolve();
    second.resolve();
    third.resolve();
    await flushMicrotasks();
  });

  it('starts only live capacity after a reservation-window limit drop to two', async () => {
    let limit = 1;
    let blockNextEmptySnapshot = false;
    const blocker = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const promotionWindow = deferred<void>();
    const started: string[] = [];
    const ran: string[] = [];
    const queued: string[] = [];
    const cancelled: Array<[string, boolean]> = [];
    const positions: Array<Array<[string, number]>> = [];
    const scheduler = new ModelTurnScheduler(() => limit, {
      onQueued: (turn) => queued.push(turn.turnId),
      onStarted: (turn) => started.push(turn.turnId),
      onCancelled: (turn, wasRunning) => cancelled.push([turn.turnId, wasRunning]),
      onQueuePositions: async (_modelProfileId, snapshot) => {
        if (blockNextEmptySnapshot && snapshot.size === 0) {
          blockNextEmptySnapshot = false;
          await promotionWindow.promise;
        }
        positions.push([...snapshot.entries()]);
      },
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => {
      ran.push('turn-2');
      await second.promise;
    }));
    scheduler.enqueue(task('turn-3', 'thread-3', 'model-1', async () => {
      ran.push('turn-3');
      await third.promise;
    }));
    await flushMicrotasks();

    blockNextEmptySnapshot = true;
    limit = 3;
    scheduler.updateLimit('model-1');
    limit = 2;
    scheduler.updateLimit('model-1');
    promotionWindow.resolve();
    await flushMicrotasks();

    expect(started).toEqual(['blocker', 'turn-2']);
    expect(ran).toEqual(['turn-2']);
    expect(positions.at(-1)).toEqual([['turn-3', 1]]);
    expect(queued).toEqual(['turn-2', 'turn-3']);
    expect(cancelled).toEqual([]);
    expect(scheduler.hasActiveThread('thread-3')).toBe(true);

    blocker.resolve();
    await flushMicrotasks();
    expect(started).toEqual(['blocker', 'turn-2', 'turn-3']);
    expect(ran).toEqual(['turn-2', 'turn-3']);
    expect(queued).toEqual(['turn-2', 'turn-3']);
    expect(cancelled).toEqual([]);

    second.resolve();
    third.resolve();
    await flushMicrotasks();
  });

  it('does not bypass an asynchronous onQueued callback during reentrant limit updates', async () => {
    let limit = 1;
    const blocker = deferred<void>();
    const queuedCallback = deferred<void>();
    const events: string[] = [];
    let scheduler!: ModelTurnScheduler;
    scheduler = new ModelTurnScheduler(() => limit, {
      onQueued: (turn) => {
        if (turn.turnId !== 'turn-2') return;
        events.push('queued:enter');
        limit = 2;
        scheduler.updateLimit('model-1');
        return queuedCallback.promise.then(() => {
          events.push('queued:exit');
        });
      },
      onStarted: (turn) => events.push(`started:${turn.turnId}`),
      onCancelled: () => undefined,
      onQueuePositions: () => undefined,
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(events).toEqual(['started:blocker', 'queued:enter']);

    queuedCallback.resolve();
    await flushMicrotasks();
    expect(events).toEqual([
      'started:blocker',
      'queued:enter',
      'queued:exit',
      'started:turn-2',
    ]);

    blocker.resolve();
    await flushMicrotasks();
  });

  it('finishes reentrant onQueued before reporting its queued cancellation', async () => {
    const blocker = deferred<void>();
    const queuedCallback = deferred<void>();
    const events: string[] = [];
    const cancelResults: boolean[] = [];
    let scheduler!: ModelTurnScheduler;
    scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: (turn) => {
        events.push('queued:enter');
        cancelResults.push(scheduler.cancel(turn.turnId));
        return queuedCallback.promise.then(() => {
          events.push('queued:exit');
        });
      },
      onStarted: (turn) => events.push(`started:${turn.turnId}`),
      onCancelled: (turn, wasRunning) => events.push(`cancelled:${turn.turnId}:${wasRunning}`),
      onQueuePositions: () => undefined,
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(cancelResults).toEqual([true]);
    expect(events).toEqual(['started:blocker', 'queued:enter']);

    queuedCallback.resolve();
    await flushMicrotasks();
    expect(events).toEqual([
      'started:blocker',
      'queued:enter',
      'queued:exit',
      'cancelled:turn-2:false',
    ]);

    blocker.resolve();
    await flushMicrotasks();
  });

  it('orders a reentrant queue cancellation before its newer position snapshot', async () => {
    const blocker = deferred<void>();
    const staleSnapshot = deferred<void>();
    const applied: Array<Array<[string, number]>> = [];
    let cancelled = false;
    let scheduler!: ModelTurnScheduler;
    scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: () => undefined,
      onStarted: () => undefined,
      onCancelled: () => undefined,
      onQueuePositions: (_modelProfileId, positions) => {
        const snapshot = [...positions.entries()];
        if (!cancelled && positions.has('turn-2')) {
          cancelled = true;
          expect(scheduler.cancel('turn-2')).toBe(true);
          return staleSnapshot.promise.then(() => {
            applied.push(snapshot);
          });
        }
        applied.push(snapshot);
      },
    });

    scheduler.enqueue(task('blocker', 'thread-0', 'model-1', () => blocker.promise));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
    await flushMicrotasks();

    expect(applied).toEqual([[]]);

    staleSnapshot.resolve();
    await flushMicrotasks();
    expect(applied).toEqual([
      [],
      [['turn-2', 1]],
      [],
    ]);

    blocker.resolve();
    await flushMicrotasks();
  });

  it('contains callback failures without leaking a slot or an unhandled rejection', async () => {
    const first = deferred<void>();
    const started: string[] = [];
    const ran: string[] = [];
    const scheduler = new ModelTurnScheduler(() => 1, {
      onQueued: async () => {
        throw new Error('queued callback failed');
      },
      onStarted: (turn) => {
        started.push(turn.turnId);
        throw new Error('started callback failed');
      },
      onCancelled: async () => {
        throw new Error('cancelled callback failed');
      },
      onQueuePositions: async () => {
        throw new Error('positions callback failed');
      },
    });

    scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', (signal) => {
      ran.push('turn-1');
      return abortable(signal, first.promise);
    }));
    scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => {
      ran.push('turn-2');
    }));
    await flushMicrotasks();

    expect(scheduler.cancel('turn-1')).toBe(true);
    await flushMicrotasks();

    expect(started).toEqual(['turn-1', 'turn-2']);
    expect(ran).toEqual(['turn-1', 'turn-2']);
  });
});

function createHarness(limitFor: (modelProfileId: string) => number) {
  const started: string[] = [];
  const queued: Array<[string, number]> = [];
  const cancelled: Array<[string, boolean]> = [];
  const positionSnapshots: Array<Array<[string, number]>> = [];
  const callbacks: SchedulerCallbacks = {
    onQueued: (turn, position) => queued.push([turn.turnId, position]),
    onStarted: (turn) => started.push(turn.turnId),
    onCancelled: (turn, wasRunning) => cancelled.push([turn.turnId, wasRunning]),
    onQueuePositions: (_modelProfileId, positions) => {
      positionSnapshots.push([...positions.entries()]);
    },
  };

  return {
    scheduler: new ModelTurnScheduler(limitFor, callbacks),
    started,
    queued,
    cancelled,
    positionSnapshots,
  };
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

function task(
  turnId: string,
  threadId: string,
  modelProfileId: string,
  run: (signal: AbortSignal) => Promise<void>,
  capacityKey = modelProfileId,
): ScheduledTurn {
  return { turnId, threadId, modelProfileId, capacityKey, title: turnId, run };
}

function abortableRun(turnId: string, ran: string[]): (signal: AbortSignal) => Promise<void> {
  return (signal) => {
    ran.push(turnId);
    return abortable(signal, new Promise<void>(() => undefined));
  };
}

function abortable(signal: AbortSignal, promise: Promise<void>): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
    void promise.then(resolve, reject);
  });
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}
