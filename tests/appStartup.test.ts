import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  loadAndRevealWindow,
  startDesktopRuntimes,
} from '../src/main/appStartup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

class FakeWindow extends EventEmitter {
  shown = false;
  destroyed = false;

  show(): void {
    this.shown = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

describe('desktop UI-first startup', () => {
  it('reveals the skeleton and yields one UI turn before starting background runtimes', async () => {
    const visible = deferred<void>();
    const uiTurn = deferred<void>();
    const events: string[] = [];

    const startup = startDesktopRuntimes({
      openWindow: async () => {
        events.push('window:loading');
        await visible.promise;
        events.push('window:visible');
      },
      deferBackgroundStart: async () => {
        events.push('window:paint');
        await uiTurn.promise;
      },
      startAgentRuntime: () => {
        events.push('agent:started');
      },
      startAgentScope: async () => {
        events.push('agentscope:started');
      },
      onAgentScopeFailure: () => {
        events.push('agentscope:failed');
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['window:loading']);

    visible.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['window:loading', 'window:visible', 'window:paint']);

    uiTurn.resolve();
    await startup;
    await Promise.resolve();
    expect(events).toEqual([
      'window:loading',
      'window:visible',
      'window:paint',
      'agent:started',
      'agentscope:started',
    ]);
  });

  it('keeps the window hidden until both loading and ready-to-show complete', async () => {
    const window = new FakeWindow();
    const loaded = deferred<void>();
    const revealing = loadAndRevealWindow(window, () => loaded.promise);

    window.emit('ready-to-show');
    await Promise.resolve();
    expect(window.shown).toBe(false);

    loaded.resolve();
    await revealing;
    expect(window.shown).toBe(true);
  });

  it('keeps a loaded window hidden until ready-to-show arrives', async () => {
    const window = new FakeWindow();
    const loaded = deferred<void>();
    const revealing = loadAndRevealWindow(window, () => loaded.promise);

    loaded.resolve();
    await Promise.resolve();
    expect(window.shown).toBe(false);

    window.emit('ready-to-show');
    await revealing;
    expect(window.shown).toBe(true);
  });
});
