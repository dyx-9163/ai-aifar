export interface AgentScopeManagedRuntime {
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

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

export class AgentScopeLifecycle {
  private readonly loaded = deferred<AgentScopeManagedRuntime | null>();
  private runtime: AgentScopeManagedRuntime | null = null;
  private startup: Promise<void> | null = null;
  private shutdown: Promise<void> | null = null;
  private stopping = false;

  start(load: () => Promise<AgentScopeManagedRuntime | null>): Promise<void> {
    if (this.startup) {
      return this.startup;
    }
    if (this.stopping) {
      return Promise.resolve();
    }

    this.startup = (async () => {
      let runtime: AgentScopeManagedRuntime | null;
      try {
        runtime = await load();
      } catch (error) {
        this.loaded.resolve(null);
        throw error;
      }

      this.runtime = runtime;
      this.loaded.resolve(runtime);
      if (!runtime || this.stopping) {
        return;
      }
      await runtime.start();
    })();
    return this.startup;
  }

  stop(): Promise<void> {
    if (this.shutdown) {
      return this.shutdown;
    }

    this.stopping = true;
    if (!this.startup) {
      this.shutdown = Promise.resolve();
      return this.shutdown;
    }

    this.shutdown = (async () => {
      const runtime = this.runtime ?? await this.loaded.promise;
      await runtime?.stop();
    })();
    return this.shutdown;
  }
}

export function completeQuitAfterShutdown(
  shutdown: Promise<void>,
  finalize: () => void,
): Promise<void> {
  const finish = () => {
    try {
      finalize();
    } catch {
      // Quit finalization must not surface internal lifecycle data as an unhandled rejection.
    }
  };
  return shutdown.then(finish, finish);
}
