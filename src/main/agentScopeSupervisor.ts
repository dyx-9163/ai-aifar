import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import path from 'node:path';
import {
  parseAgentScopeReady,
  type AgentScopeBootstrapReady,
  type AgentScopeRuntimeState,
} from './agentScopeProtocol';
import type { AgentScopeRuntimePaths } from './agentScopeRuntimePaths';

const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_READINESS_BYTES = 16 * 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const POST_KILL_CLOSE_TIMEOUT_MS = 1_000;
const STABILITY_RESET_MS = 60_000;
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000] as const;

type TimerHandle = unknown;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type DegradedReason = Extract<AgentScopeRuntimeState, { state: 'degraded' }>['reason'];

const DEGRADED_DETAILS: Record<DegradedReason, string> = {
  'missing-runtime': 'AgentScope runtime is unavailable.',
  'invalid-manifest': 'AgentScope runtime manifest validation failed.',
  'protocol-mismatch': 'AgentScope runtime readiness validation failed.',
  'health-failed': 'AgentScope runtime health check failed.',
  'start-timeout': 'AgentScope runtime startup timed out.',
  exited: 'AgentScope runtime exited unexpectedly.',
};

export interface AgentScopeEventSource {
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
}

export interface AgentScopeWritable extends AgentScopeEventSource {
  write(value: string): boolean;
  end(): void;
}

export interface AgentScopeReadable extends AgentScopeEventSource {}

export interface AgentScopeChildProcess extends AgentScopeEventSource {
  readonly pid?: number;
  readonly stdin: AgentScopeWritable;
  readonly stdout: AgentScopeReadable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AgentScopeSpawnOptions {
  cwd: string;
  shell: false;
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'ignore'];
  env: Record<string, string>;
}

export type AgentScopeSpawn = (
  command: string,
  args: readonly string[],
  options: AgentScopeSpawnOptions,
) => AgentScopeChildProcess;

export interface AgentScopeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  json(): Promise<unknown>;
}

export type AgentScopeFetch = (
  url: string,
  init?: RequestInit,
) => Promise<AgentScopeFetchResponse>;

export interface AgentScopeSupervisorDependencies {
  spawn: AgentScopeSpawn;
  fetch: AgentScopeFetch;
  randomBytes(size: number): Uint8Array;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
  now(): number;
  logger?: (level: LogLevel, message: string) => void;
}

export interface AgentScopeSupervisorOptions {
  runtimePaths: AgentScopeRuntimePaths;
  userDataDir: string;
  logDir: string;
  dependencies?: Partial<AgentScopeSupervisorDependencies>;
}

type StateListener = (state: AgentScopeRuntimeState) => void;

interface OwnedChild {
  readonly child: AgentScopeChildProcess;
  readonly generation: number;
  readonly attempt: number;
  readonly completion: Promise<AgentScopeRuntimeState>;
  readonly resolveCompletion: (state: AgentScopeRuntimeState) => void;
  readonly closePromise: Promise<void>;
  readonly resolveClose: () => void;
  readonly cancellationPromise: Promise<void>;
  readonly resolveCancellation: () => void;
  readonly abortController: AbortController;
  readonly onStdoutData: (chunk: unknown) => void;
  readonly onStdoutEnd: () => void;
  readonly onChildExit: (code: unknown, signal: unknown) => void;
  readonly onChildClose: (code: unknown, signal: unknown) => void;
  readonly onChildError: (error: unknown) => void;
  readonly onStdinError: (error: unknown) => void;
  stdoutBytes: Buffer;
  readinessAccepted: boolean;
  ready: boolean;
  exited: boolean;
  reaped: boolean;
  closed: boolean;
  intentional: boolean;
  failureInProgress: boolean;
  completionSettled: boolean;
  cancellationSettled: boolean;
  token: string;
  startupTimer?: TimerHandle;
  stabilityTimer?: TimerHandle;
  healthySince?: number;
  startupDeadline: number;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function cloneState(state: AgentScopeRuntimeState): AgentScopeRuntimeState {
  return { ...state };
}

function defaultDependencies(): AgentScopeSupervisorDependencies {
  return {
    spawn: nodeSpawn as unknown as AgentScopeSpawn,
    fetch: (url, init) => globalThis.fetch(url, init),
    randomBytes: (size) => new Uint8Array(nodeRandomBytes(size)),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

function isExactHealth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  const keys = Object.keys(health);
  if (
    keys.length !== 4 ||
    !Object.hasOwn(health, 'ok') ||
    !Object.hasOwn(health, 'protocol_version') ||
    !Object.hasOwn(health, 'runtime_version') ||
    !Object.hasOwn(health, 'agentscope_version')
  ) {
    return false;
  }
  return (
    health.ok === true &&
    health.protocol_version === '1' &&
    health.runtime_version === '1.0.0' &&
    health.agentscope_version === '2.0.6'
  );
}

function isExactLoopbackHealthResponseUrl(value: string, expectedPort: number): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === String(expectedPort) &&
      url.pathname === '/v1/health' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export class AgentScopeSupervisor {
  private readonly runtimePaths: AgentScopeRuntimePaths;
  private readonly userDataDir: string;
  private readonly logDir: string;
  private readonly dependencies: AgentScopeSupervisorDependencies;
  private readonly listeners = new Set<StateListener>();
  private runtimeState: AgentScopeRuntimeState = { state: 'stopped' };
  private generation = 0;
  private desiredRunning = false;
  private restartCursor = 0;
  private ownedChild?: OwnedChild;
  private restartTimer?: TimerHandle;
  private startPromise?: Promise<AgentScopeRuntimeState>;
  private stopPromise?: Promise<void>;

  constructor(options: AgentScopeSupervisorOptions) {
    this.runtimePaths = options.runtimePaths;
    this.userDataDir = options.userDataDir;
    this.logDir = options.logDir;
    this.dependencies = { ...defaultDependencies(), ...options.dependencies };
  }

  start(): Promise<AgentScopeRuntimeState> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.runtimeState.state === 'ready') return Promise.resolve(this.status());
    if (this.startPromise) return this.startPromise;
    if (this.ownedChild || this.restartTimer !== undefined) return Promise.resolve(this.status());

    const completion = createDeferred<AgentScopeRuntimeState>();
    const guarded = completion.promise.finally(() => {
      if (this.startPromise === guarded) this.startPromise = undefined;
    });
    this.startPromise = guarded;
    this.desiredRunning = true;
    this.restartCursor = 0;
    const generation = ++this.generation;
    void this.launch(generation, 1).then(
      completion.resolve,
      () => completion.resolve(this.setDegraded('exited')),
    );
    return guarded;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const completion = createDeferred<void>();
    const guarded = completion.promise.finally(() => {
      if (this.stopPromise === guarded) this.stopPromise = undefined;
    });
    this.stopPromise = guarded;
    this.desiredRunning = false;
    ++this.generation;
    this.clearRestartTimer();
    void this.performStop().then(completion.resolve, () => {
      if (!this.ownedChild) completion.resolve();
    });
    return guarded;
  }

  status(): AgentScopeRuntimeState {
    return cloneState(this.runtimeState);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  private async launch(generation: number, attempt: number): Promise<AgentScopeRuntimeState> {
    if (!this.isCurrentGeneration(generation)) return this.status();
    this.setState({ state: 'starting', attempt });
    if (!this.isCurrentGeneration(generation)) return this.status();
    this.log('info', 'AgentScope runtime is starting.');

    let token = '';
    let bootstrapLine = '';
    try {
      const entropy = this.dependencies.randomBytes(32);
      if (entropy.byteLength !== 32) throw new Error('Invalid entropy length.');
      token = Buffer.from(entropy).toString('base64url');
      bootstrapLine = `${JSON.stringify({
        token,
        user_data_dir: this.userDataDir,
        log_dir: this.logDir,
      })}\n`;
      if (Buffer.byteLength(bootstrapLine, 'utf8') > MAX_BOOTSTRAP_BYTES) {
        throw new Error('Bootstrap line exceeds its bound.');
      }
    } catch {
      return this.isCurrentGeneration(generation)
        ? this.setDegraded('protocol-mismatch')
        : this.status();
    }
    if (!this.isCurrentGeneration(generation)) return this.status();

    let child: AgentScopeChildProcess;
    try {
      child = this.dependencies.spawn(
        this.runtimePaths.pythonPath,
        ['-P', '-m', 'private_ai_agentscope.bootstrap'],
        {
          cwd: this.runtimePaths.root,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            PYTHONPATH: `${this.runtimePaths.applicationPath}${path.delimiter}${this.runtimePaths.sitePackagesPath}`,
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1',
          },
        },
      );
    } catch {
      token = '';
      bootstrapLine = '';
      return this.isCurrentGeneration(generation) ? this.setDegraded('exited') : this.status();
    }

    const context = this.createOwnedChild(child, generation, attempt, token);
    this.ownedChild = context;
    this.attachChild(context);
    context.startupTimer = this.dependencies.setTimeout(() => {
      void this.failContext(context, 'start-timeout');
    }, START_TIMEOUT_MS);

    if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) {
      bootstrapLine = '';
      void this.failContext(context, 'protocol-mismatch');
      return context.completion;
    }

    try {
      child.stdin.write(bootstrapLine);
    } catch {
      void this.failContext(context, 'exited');
    } finally {
      bootstrapLine = '';
    }
    return context.completion;
  }

  private createOwnedChild(
    child: AgentScopeChildProcess,
    generation: number,
    attempt: number,
    token: string,
  ): OwnedChild {
    const completion = createDeferred<AgentScopeRuntimeState>();
    const close = createDeferred<void>();
    const cancellation = createDeferred<void>();
    const context = {} as OwnedChild;
    Object.assign(context, {
      child,
      generation,
      attempt,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      closePromise: close.promise,
      resolveClose: close.resolve,
      cancellationPromise: cancellation.promise,
      resolveCancellation: cancellation.resolve,
      abortController: new AbortController(),
      onStdoutData: (chunk: unknown) => this.handleStdoutData(context, chunk),
      onStdoutEnd: () => this.handleStdoutEnd(context),
      onChildExit: (code: unknown, signal: unknown) => this.handleChildExit(context, code, signal),
      onChildClose: (code: unknown, signal: unknown) =>
        this.handleChildClose(context, code, signal),
      onChildError: (_error: unknown) => this.handleOwnedError(context),
      onStdinError: (_error: unknown) => this.handleOwnedError(context),
      stdoutBytes: Buffer.alloc(0),
      readinessAccepted: false,
      ready: false,
      exited: false,
      reaped: false,
      closed: false,
      intentional: false,
      failureInProgress: false,
      completionSettled: false,
      cancellationSettled: false,
      token,
      startupDeadline: this.dependencies.now() + START_TIMEOUT_MS,
    } satisfies Partial<OwnedChild>);
    return context;
  }

  private attachChild(context: OwnedChild): void {
    context.child.stdout.on('data', context.onStdoutData);
    context.child.stdout.on('end', context.onStdoutEnd);
    context.child.stdin.on('error', context.onStdinError);
    context.child.on('error', context.onChildError);
    context.child.on('exit', context.onChildExit);
    context.child.on('close', context.onChildClose);
  }

  private detachChild(context: OwnedChild): void {
    if (context.closed || !context.reaped) return;
    context.closed = true;
    this.cancelContextOperations(context);
    context.child.stdin.removeListener('error', context.onStdinError);
    context.child.removeListener('error', context.onChildError);
    context.child.removeListener('exit', context.onChildExit);
    context.child.removeListener('close', context.onChildClose);
    if (this.ownedChild === context) this.ownedChild = undefined;
  }

  private cancelContextOperations(context: OwnedChild): void {
    context.abortController.abort();
    if (!context.cancellationSettled) {
      context.cancellationSettled = true;
      context.resolveCancellation();
    }
    context.child.stdout.removeListener('data', context.onStdoutData);
    context.child.stdout.removeListener('end', context.onStdoutEnd);
    this.clearContextTimers(context);
    context.stdoutBytes = Buffer.alloc(0);
    context.token = '';
  }

  private handleOwnedError(context: OwnedChild): void {
    if (
      context.closed ||
      this.ownedChild !== context ||
      context.intentional ||
      context.failureInProgress ||
      context.exited ||
      context.reaped ||
      !this.isCurrentGeneration(context.generation)
    ) {
      return;
    }
    void this.failContext(context, 'exited');
  }

  private handleStdoutData(context: OwnedChild, input: unknown): void {
    if (!this.isActiveContext(context) || context.failureInProgress) return;
    const chunk = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input as Uint8Array);
    if (chunk.byteLength === 0) return;
    if (context.readinessAccepted) {
      void this.failContext(context, 'protocol-mismatch');
      return;
    }
    if (context.stdoutBytes.byteLength + chunk.byteLength > MAX_READINESS_BYTES) {
      void this.failContext(context, 'protocol-mismatch');
      return;
    }
    context.stdoutBytes = Buffer.concat([context.stdoutBytes, chunk]);
    const newlineIndex = context.stdoutBytes.indexOf(0x0a);
    if (newlineIndex < 0) return;
    if (newlineIndex !== context.stdoutBytes.byteLength - 1) {
      void this.failContext(context, 'protocol-mismatch');
      return;
    }

    context.readinessAccepted = true;
    let ready: AgentScopeBootstrapReady;
    try {
      ready = parseAgentScopeReady(context.stdoutBytes.subarray(0, newlineIndex).toString('utf8'));
      if (ready.pid !== context.child.pid) throw new Error('Readiness PID mismatch.');
    } catch {
      void this.failContext(context, 'protocol-mismatch');
      return;
    } finally {
      context.stdoutBytes = Buffer.alloc(0);
    }
    void this.verifyHealth(context, ready);
  }

  private handleStdoutEnd(context: OwnedChild): void {
    if (!context.readinessAccepted && this.isActiveContext(context) && !context.failureInProgress) {
      void this.failContext(context, 'protocol-mismatch');
    }
  }

  private async verifyHealth(
    context: OwnedChild,
    ready: AgentScopeBootstrapReady,
  ): Promise<void> {
    const target = `http://127.0.0.1:${ready.port}/v1/health`;
    try {
      const healthResponse = await this.waitForContext(
        context,
        this.dependencies.fetch(target, {
          headers: { Authorization: `Bearer ${context.token}` },
          redirect: 'error',
          signal: context.abortController.signal,
        }),
      );
      const health = await this.waitForContext(context, healthResponse.json());
      if (
        !healthResponse.ok ||
        !Number.isInteger(healthResponse.status) ||
        healthResponse.status < 200 ||
        healthResponse.status >= 300 ||
        !isExactLoopbackHealthResponseUrl(healthResponse.url, ready.port) ||
        !isExactHealth(health)
      ) {
        throw new Error('Health validation failed.');
      }
    } catch {
      if (
        this.isActiveContext(context) &&
        !context.failureInProgress &&
        !context.exited &&
        !context.reaped
      ) {
        await this.failContext(context, 'health-failed');
      }
      return;
    }

    if (
      !this.isActiveContext(context) ||
      context.failureInProgress ||
      context.exited ||
      context.reaped
    ) {
      return;
    }
    context.token = '';
    context.ready = true;
    this.clearTimer(context.startupTimer);
    context.startupTimer = undefined;
    this.setState({
      state: 'ready',
      pid: ready.pid,
      port: ready.port,
      runtimeVersion: ready.runtime_version,
      agentScopeVersion: ready.agentscope_version,
    });
    if (!this.isActiveContext(context) || context.failureInProgress) return;
    this.log('info', 'AgentScope runtime is ready.');
    this.scheduleStabilityReset(context);
    this.settleCompletion(context, this.status());
  }

  private handleChildExit(context: OwnedChild, _code: unknown, _signal: unknown): void {
    if (context.exited) return;
    context.exited = true;
    this.cancelContextOperations(context);

    if (context.intentional || context.failureInProgress || !this.isCurrentGeneration(context.generation)) return;

    this.settleCompletion(context, this.setDegraded('exited'));
  }

  private handleChildClose(context: OwnedChild, _code: unknown, _signal: unknown): void {
    if (context.reaped) return;
    context.reaped = true;
    context.resolveClose();
    this.cancelContextOperations(context);

    if (context.intentional || context.failureInProgress || !this.isCurrentGeneration(context.generation)) {
      this.detachChild(context);
      return;
    }

    const shouldRestart = this.desiredRunning;
    this.settleCompletion(context, this.setDegraded('exited'));
    this.detachChild(context);
    if (shouldRestart) this.scheduleRestart(context.generation);
  }

  private async failContext(context: OwnedChild, reason: DegradedReason): Promise<void> {
    if (context.failureInProgress || context.closed) return;
    context.failureInProgress = true;
    this.cancelContextOperations(context);
    const state = this.setDegraded(reason);
    this.log('warn', 'AgentScope runtime startup failed.');
    try {
      context.child.stdin.end();
    } catch {
      // The fixed degraded state is intentionally independent of dependency error text.
    }
    if (!context.exited) {
      try {
        context.child.kill('SIGKILL');
      } catch {
        // Process termination errors are deliberately redacted and cannot change ownership.
      }
    }
    if (!context.reaped) {
      const remainingStartupMs = Math.max(0, context.startupDeadline - this.dependencies.now());
      await this.waitForClose(context, remainingStartupMs);
    }
    this.detachChild(context);
    this.settleCompletion(context, state);
  }

  private scheduleRestart(generation: number): void {
    if (!this.isCurrentGeneration(generation) || this.restartTimer !== undefined) return;
    const delay = RESTART_DELAYS_MS[this.restartCursor];
    if (delay === undefined) return;
    this.restartCursor += 1;
    this.log('warn', 'AgentScope runtime restart is scheduled.');
    this.restartTimer = this.dependencies.setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.isCurrentGeneration(generation) || this.ownedChild) return;
      void this.launch(generation, this.restartCursor + 1);
    }, delay);
  }

  private scheduleStabilityReset(context: OwnedChild): void {
    context.healthySince = this.dependencies.now();
    const checkStability = () => {
      if (!this.isActiveContext(context) || !context.ready) return;
      const elapsed = this.dependencies.now() - (context.healthySince ?? this.dependencies.now());
      const remaining = STABILITY_RESET_MS - elapsed;
      if (remaining > 0) {
        context.stabilityTimer = this.dependencies.setTimeout(checkStability, remaining);
        return;
      }
      context.stabilityTimer = undefined;
      this.restartCursor = 0;
    };
    context.stabilityTimer = this.dependencies.setTimeout(checkStability, STABILITY_RESET_MS);
  }

  private async performStop(): Promise<void> {
    const context = this.ownedChild;
    if (!context) {
      this.setState({ state: 'stopped' });
      return;
    }

    context.intentional = true;
    this.cancelContextOperations(context);
    try {
      context.child.stdin.end();
    } catch {
      // EOF is best effort; the bounded force-kill path below still owns cleanup.
    }

    if (!context.reaped) await this.waitForClose(context, STOP_TIMEOUT_MS);
    if (!context.reaped) {
      this.setDegraded('exited');
      if (!context.exited) {
        try {
          context.child.kill('SIGKILL');
        } catch {
          // The supervisor still releases only this exact owned generation.
        }
      }
      if (!context.reaped) await this.waitForClose(context, POST_KILL_CLOSE_TIMEOUT_MS);
    }
    this.detachChild(context);
    if (context.reaped) {
      this.setState({ state: 'stopped' });
      this.settleCompletion(context, this.status());
      this.log('info', 'AgentScope runtime is stopped.');
      return;
    }
    this.settleCompletion(context, this.status());
  }

  private async waitForClose(context: OwnedChild, timeoutMs: number): Promise<void> {
    if (context.reaped || timeoutMs <= 0) return;
    let timer: TimerHandle | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = this.dependencies.setTimeout(resolve, timeoutMs);
    });
    await Promise.race([context.closePromise, timeout]);
    this.clearTimer(timer);
  }

  private async waitForContext<T>(context: OwnedChild, operation: Promise<T>): Promise<T> {
    return Promise.race([
      operation,
      context.cancellationPromise.then(() => {
        throw new Error('AgentScope operation was cancelled.');
      }),
    ]);
  }

  private settleCompletion(context: OwnedChild, state: AgentScopeRuntimeState): void {
    if (context.completionSettled) return;
    context.completionSettled = true;
    context.resolveCompletion(cloneState(state));
  }

  private clearContextTimers(context: OwnedChild): void {
    this.clearTimer(context.startupTimer);
    this.clearTimer(context.stabilityTimer);
    context.startupTimer = undefined;
    context.stabilityTimer = undefined;
  }

  private clearRestartTimer(): void {
    this.clearTimer(this.restartTimer);
    this.restartTimer = undefined;
  }

  private clearTimer(timer: TimerHandle | undefined): void {
    if (timer !== undefined) this.dependencies.clearTimeout(timer);
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.desiredRunning && generation === this.generation;
  }

  private isActiveContext(context: OwnedChild): boolean {
    return this.ownedChild === context && !context.closed && this.isCurrentGeneration(context.generation);
  }

  private setDegraded(reason: DegradedReason): AgentScopeRuntimeState {
    const state: AgentScopeRuntimeState = {
      state: 'degraded',
      reason,
      detail: DEGRADED_DETAILS[reason],
    };
    this.setState(state);
    return state;
  }

  private setState(state: AgentScopeRuntimeState): void {
    this.runtimeState = cloneState(state);
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneState(this.runtimeState));
      } catch {
        // Subscribers cannot inject their exception details into supervisor logs or state.
      }
    }
  }

  private log(level: LogLevel, message: string): void {
    try {
      this.dependencies.logger?.(level, message);
    } catch {
      // Logging cannot affect lifecycle ownership or expose dependency error details.
    }
  }
}
