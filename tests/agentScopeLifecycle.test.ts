import { describe, expect, it } from 'vitest';
import {
  AgentScopeLifecycle,
  completeQuitAfterShutdown,
  type AgentScopeManagedRuntime,
} from '../src/main/agentScopeLifecycle';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function managedRuntime(options: {
  start?: () => Promise<unknown>;
  stop?: () => Promise<void>;
} = {}): AgentScopeManagedRuntime {
  return {
    start: options.start ?? (() => Promise.resolve()),
    stop: options.stop ?? (() => Promise.resolve()),
  };
}

describe('AgentScopeLifecycle', () => {
  it('makes shutdown the sole stop owner when quit races deferred runtime loading', async () => {
    const loaded = deferred<AgentScopeManagedRuntime | null>();
    let starts = 0;
    let stops = 0;
    const runtime = managedRuntime({
      start: async () => {
        starts += 1;
      },
      stop: async () => {
        stops += 1;
      },
    });
    const lifecycle = new AgentScopeLifecycle();

    const startup = lifecycle.start(() => loaded.promise);
    const firstShutdown = lifecycle.stop();
    const repeatedShutdown = lifecycle.stop();
    loaded.resolve(runtime);

    await Promise.all([startup, firstShutdown, repeatedShutdown]);
    expect(starts).toBe(0);
    expect(stops).toBe(1);
    expect(repeatedShutdown).toBe(firstShutdown);
  });

  it('stops an attached runtime without waiting for its pending startup', async () => {
    const startupGate = deferred<unknown>();
    let starts = 0;
    let stops = 0;
    const runtime = managedRuntime({
      start: () => {
        starts += 1;
        return startupGate.promise;
      },
      stop: async () => {
        stops += 1;
        startupGate.resolve(undefined);
      },
    });
    const lifecycle = new AgentScopeLifecycle();

    const startup = lifecycle.start(async () => runtime);
    await Promise.resolve();
    expect(starts).toBe(1);

    const shutdown = lifecycle.stop();
    await shutdown;
    await startup;

    expect(stops).toBe(1);
  });

  it('coalesces repeated shutdown after the runtime is attached', async () => {
    const stopGate = deferred<void>();
    let stops = 0;
    const runtime = managedRuntime({
      stop: () => {
        stops += 1;
        return stopGate.promise;
      },
    });
    const lifecycle = new AgentScopeLifecycle();
    await lifecycle.start(async () => runtime);

    const firstShutdown = lifecycle.stop();
    const repeatedShutdown = lifecycle.stop();
    expect(repeatedShutdown).toBe(firstShutdown);
    expect(stops).toBe(1);

    stopGate.resolve();
    await Promise.all([firstShutdown, repeatedShutdown]);
  });
});

describe('completeQuitAfterShutdown', () => {
  it('consumes shutdown rejection and finalizes quit exactly once', async () => {
    let finalizes = 0;

    await expect(
      completeQuitAfterShutdown(
        Promise.reject(new Error('raw internal token=bootstrap-secret')),
        () => {
          finalizes += 1;
        },
      ),
    ).resolves.toBeUndefined();

    expect(finalizes).toBe(1);
  });
});
