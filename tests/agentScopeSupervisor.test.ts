import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentScopeSupervisor,
  type AgentScopeChildProcess,
  type AgentScopeFetch,
  type AgentScopeSpawn,
} from '../src/main/agentScopeSupervisor';
import type { AgentScopeRuntimePaths } from '../src/main/agentScopeRuntimePaths';

const ZERO_ENTROPY_TOKEN_SHA256 =
  '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';
const READY_PORT = 49152;
const READY_PID = 4242;

const readyLine = (replacement: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: 'agentscope.ready',
    protocol_version: '1',
    runtime_version: '1.0.0',
    agentscope_version: '2.0.6',
    port: READY_PORT,
    pid: READY_PID,
    ...replacement,
  })}\n`;

const validHealth = () => ({
  ok: true,
  protocol_version: '1',
  runtime_version: '1.0.0',
  agentscope_version: '2.0.6',
});

function secretMetadata(secret: string) {
  const decoded = Buffer.from(secret, 'base64url');
  return {
    characterLength: secret.length,
    decodedByteLength: decoded.byteLength,
    canonicalBase64Url: decoded.toString('base64url') === secret,
    sha256: createHash('sha256').update(secret).digest('hex'),
  };
}

function containsSecret(value: unknown, secret: string): boolean {
  return secret.length > 0 && JSON.stringify(value).includes(secret);
}

function stateMatches(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

function stateIncludes(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(record[key], value));
}

function safeStateKind(state: unknown): string {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 'invalid';
  const kind = (state as Record<string, unknown>).state;
  return kind === 'stopped' || kind === 'starting' || kind === 'ready' || kind === 'degraded'
    ? kind
    : 'invalid';
}

function inspectBootstrapLine(line: string): {
  token: string;
  diagnostics: {
    parsed: boolean;
    exactKeys: boolean;
    userDataDirMatches: boolean;
    logDirMatches: boolean;
  };
} {
  const sanitizedFailure = {
    token: '',
    diagnostics: {
      parsed: false,
      exactKeys: false,
      userDataDirMatches: false,
      logDirMatches: false,
    },
  };
  try {
    const decoded = JSON.parse(line) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return sanitizedFailure;
    }
    const record = decoded as Record<string, unknown>;
    return {
      token: typeof record.token === 'string' ? record.token : '',
      diagnostics: {
        parsed: true,
        exactKeys:
          Object.keys(record).length === 3 &&
          Object.hasOwn(record, 'token') &&
          Object.hasOwn(record, 'user_data_dir') &&
          Object.hasOwn(record, 'log_dir'),
        userDataDirMatches: record.user_data_dir === path.resolve('C:\\PrivateAI\\user-data'),
        logDirMatches: record.log_dir === path.resolve('C:\\PrivateAI\\logs'),
      },
    };
  } catch {
    return sanitizedFailure;
  }
}

function sanitizeSpawnCall(
  call: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined,
  secret: string,
) {
  const env = call?.options.env as Record<string, string> | undefined;
  return {
    commandMatches: call?.command === runtimePaths.pythonPath,
    argsMatch:
      call?.args.length === 2 &&
      call.args[0] === '-m' &&
      call.args[1] === 'private_ai_agentscope.bootstrap',
    shellDisabled: call?.options.shell === false,
    windowHidden: call?.options.windowsHide === true,
    stdioMatches:
      Array.isArray(call?.options.stdio) &&
      call.options.stdio.length === 3 &&
      call.options.stdio[0] === 'pipe' &&
      call.options.stdio[1] === 'pipe' &&
      call.options.stdio[2] === 'ignore',
    environmentMatches:
      env !== undefined &&
      Object.keys(env).length === 5 &&
      env.PYTHONPATH ===
        `${runtimePaths.applicationPath}${path.delimiter}${runtimePaths.sitePackagesPath}` &&
      env.PYTHONNOUSERSITE === '1' &&
      env.PYTHONDONTWRITEBYTECODE === '1' &&
      env.PYTHONUTF8 === '1' &&
      env.PYTHONUNBUFFERED === '1' &&
      !Object.hasOwn(env, 'PYTHONHOME'),
    containsSecret: containsSecret(call, secret),
  };
}

function sanitizeFetchCall(
  call: { url: string; init: RequestInit | undefined } | undefined,
  bootstrapToken: string,
) {
  const authorization = new Headers(call?.init?.headers).get('Authorization') ?? '';
  const bearerPrefix = 'Bearer ';
  const authorizationToken = authorization.startsWith(bearerPrefix)
    ? authorization.slice(bearerPrefix.length)
    : '';
  return {
    urlMatches: call?.url === `http://127.0.0.1:${READY_PORT}/v1/health`,
    redirectBlocked: call?.init?.redirect === 'error',
    hasAbortSignal: call?.init?.signal instanceof AbortSignal,
    bearerScheme: authorization.startsWith(bearerPrefix),
    matchesBootstrapToken: authorizationToken === bootstrapToken,
    authorizationToken: secretMetadata(authorizationToken),
  };
}

class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  endCalls = 0;
  onEnd?: () => void;

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }

  end(): void {
    this.endCalls += 1;
    this.onEnd?.();
  }
}

class FakeStdout extends EventEmitter {}

class FakeChild extends EventEmitter implements AgentScopeChildProcess {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeStdout();
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  exited = false;
  closed = false;

  constructor(
    readonly pid: number = READY_PID,
    private readonly exitWhenKilled = true,
    private readonly killResult = true,
    private readonly closeWhenExited = true,
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.killResult && this.exitWhenKilled) {
      this.exit(1, typeof signal === 'number' ? null : (signal ?? null));
    }
    return this.killResult;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    if (this.closeWhenExited) this.close(code, signal);
  }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, signal);
  }
}

interface FakeResponse {
  ok: boolean;
  status: number;
  url: string;
  json(): Promise<unknown>;
}

const response = (body: unknown = validHealth(), url = `http://127.0.0.1:${READY_PORT}/v1/health`): FakeResponse => ({
  ok: true,
  status: 200,
  url,
  json: async () => body,
});

const runtimePaths: AgentScopeRuntimePaths = {
  root: path.resolve('C:\\PrivateAI\\resources\\agentscope-runtime'),
  manifest: path.resolve('C:\\PrivateAI\\resources\\agentscope-runtime\\runtime-manifest.json'),
  pythonPath: path.resolve('C:\\PrivateAI\\resources\\agentscope-runtime\\python\\python.exe'),
  applicationPath: path.resolve('C:\\PrivateAI\\resources\\agentscope-runtime\\app'),
  sitePackagesPath: path.resolve(
    'C:\\PrivateAI\\resources\\agentscope-runtime\\python\\Lib\\site-packages',
  ),
  filePaths: [],
};

interface HarnessOptions {
  children?: FakeChild[];
  fetch?: AgentScopeFetch;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

function makeHarness(options: HarnessOptions = {}) {
  const children = options.children ?? [new FakeChild()];
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }> = [];
  let nextChild = 0;
  const spawn: AgentScopeSpawn = (command, args, spawnOptions) => {
    spawnCalls.push({
      command,
      args,
      options: spawnOptions as unknown as Record<string, unknown>,
    });
    const child = children[nextChild++];
    if (!child) throw new Error('Unexpected overlapping or extra child process.');
    return child;
  };
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: AgentScopeFetch = options.fetch ?? (async (url, init) => {
    fetchCalls.push({ url, init });
    return response();
  });
  const randomByteRequests: number[] = [];
  const supervisor = new AgentScopeSupervisor({
    runtimePaths,
    userDataDir: path.resolve('C:\\PrivateAI\\user-data'),
    logDir: path.resolve('C:\\PrivateAI\\logs'),
    dependencies: {
      spawn,
      fetch: async (url, init) => {
        if (options.fetch) fetchCalls.push({ url, init });
        return fetch(url, init);
      },
      randomBytes: (size) => {
        randomByteRequests.push(size);
        return new Uint8Array(32);
      },
      logger: options.logger,
      now: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
  });
  return { children, fetchCalls, randomByteRequests, spawnCalls, supervisor };
}

async function finishReadyStart(
  supervisor: AgentScopeSupervisor,
  child: FakeChild,
): Promise<ReturnType<AgentScopeSupervisor['status']>> {
  const starting = supervisor.start();
  child.stdout.emit('data', Buffer.from(readyLine()));
  return starting;
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentScopeSupervisor secure startup', () => {
  it('uses constant sanitized diagnostics when bootstrap inspection cannot parse', () => {
    const inspected = inspectBootstrapLine('{');

    expect({
      tokenIsEmpty: inspected.token.length === 0,
      diagnostics: inspected.diagnostics,
    }).toEqual({
      tokenIsEmpty: true,
      diagnostics: {
        parsed: false,
        exactKeys: false,
        userDataDirMatches: false,
        logDirMatches: false,
      },
    });
  });

  it('writes one bounded config line from exactly 32 random bytes and starts the direct minimal process', async () => {
    const logs: string[] = [];
    const { children, fetchCalls, randomByteRequests, spawnCalls, supervisor } = makeHarness({
      logger: (level, message) => logs.push(`${level}:${message}`),
    });

    const state = await finishReadyStart(supervisor, children[0]);

    expect(randomByteRequests).toEqual([32]);
    expect(children[0].stdin.writes.length).toBe(1);
    const bootstrapLine = children[0].stdin.writes[0] ?? '';
    const bootstrap = inspectBootstrapLine(bootstrapLine);
    const bootstrapToken = bootstrap.token;
    expect({
      endsWithNewline: bootstrapLine.endsWith('\n'),
      bounded: Buffer.byteLength(bootstrapLine, 'utf8') <= 16 * 1024,
      bootstrap: bootstrap.diagnostics,
      token: secretMetadata(bootstrapToken),
    }).toEqual({
      endsWithNewline: true,
      bounded: true,
      bootstrap: {
        parsed: true,
        exactKeys: true,
        userDataDirMatches: true,
        logDirMatches: true,
      },
      token: {
        characterLength: 43,
        decodedByteLength: 32,
        canonicalBase64Url: true,
        sha256: ZERO_ENTROPY_TOKEN_SHA256,
      },
    });
    expect(spawnCalls.length).toBe(1);
    const sanitizedSpawn = sanitizeSpawnCall(spawnCalls[0], bootstrapToken);
    expect(containsSecret(sanitizedSpawn, bootstrapToken)).toBe(false);
    expect(sanitizedSpawn).toEqual({
      commandMatches: true,
      argsMatch: true,
      shellDisabled: true,
      windowHidden: true,
      stdioMatches: true,
      environmentMatches: true,
      containsSecret: false,
    });
    expect(stateMatches(state, {
      state: 'ready',
      pid: READY_PID,
      port: READY_PORT,
      runtimeVersion: '1.0.0',
      agentScopeVersion: '2.0.6',
    })).toBe(true);
    expect(fetchCalls.length).toBe(1);
    const sanitizedFetch = sanitizeFetchCall(fetchCalls[0], bootstrapToken);
    expect(containsSecret(sanitizedFetch, bootstrapToken)).toBe(false);
    expect(sanitizedFetch).toEqual({
      urlMatches: true,
      redirectBlocked: true,
      hasAbortSignal: true,
      bearerScheme: true,
      matchesBootstrapToken: true,
      authorizationToken: {
        characterLength: 43,
        decodedByteLength: 32,
        canonicalBase64Url: true,
        sha256: ZERO_ENTROPY_TOKEN_SHA256,
      },
    });
    expect({
      stateContainsSecret: containsSecret(state, bootstrapToken),
      logsContainSecret: containsSecret(logs, bootstrapToken),
    }).toEqual({ stateContainsSecret: false, logsContainSecret: false });
  });

  it('notifies active subscribers of transitions and honors unsubscribe', async () => {
    const child = new FakeChild();
    child.stdin.onEnd = () => child.exit(0);
    const { supervisor } = makeHarness({ children: [child] });
    const observed: string[] = [];
    const unsubscribe = supervisor.subscribe((state) => observed.push(safeStateKind(state)));

    await finishReadyStart(supervisor, child);
    unsubscribe();
    await supervisor.stop();

    expect(observed).toEqual(['starting', 'ready']);
  });

  it('coalesces concurrent and repeated starts without overlapping children', async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { randomByteRequests, spawnCalls, supervisor } = makeHarness({ children });

    const firstStart = supervisor.start();
    const concurrentStart = supervisor.start();
    expect(spawnCalls.length).toBe(1);
    children[0].stdout.emit('data', Buffer.from(readyLine()));

    const [firstState, concurrentState, repeatedState] = await Promise.all([
      firstStart,
      concurrentStart,
      firstStart.then(() => supervisor.start()),
    ]);

    expect(stateIncludes(firstState, { state: 'ready' })).toBe(true);
    expect(stateIncludes(concurrentState, { state: 'ready' })).toBe(true);
    expect(stateIncludes(repeatedState, { state: 'ready' })).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect(randomByteRequests).toEqual([32]);
  });

  it('publishes the start guard before a starting subscriber can re-enter start', async () => {
    const { children, randomByteRequests, spawnCalls, supervisor } = makeHarness();
    let reentrantStart: Promise<ReturnType<AgentScopeSupervisor['status']>> | undefined;
    let didReenter = false;
    supervisor.subscribe((state) => {
      if (state.state === 'starting' && !didReenter) {
        didReenter = true;
        reentrantStart = supervisor.start();
      }
    });

    const outerStart = supervisor.start();

    expect(reentrantStart).toBe(outerStart);
    expect(spawnCalls.length).toBe(1);
    expect(randomByteRequests).toEqual([32]);
    children[0].stdout.emit('data', Buffer.from(readyLine()));
    expect(stateIncludes(await outerStart, { state: 'ready' })).toBe(true);
  });

  it('publishes the stop guard before a stopped subscriber can re-enter stop', async () => {
    const { supervisor } = makeHarness();
    let stoppedNotifications = 0;
    let reentrantStop: Promise<void> | undefined;
    let didReenter = false;
    supervisor.subscribe((state) => {
      if (state.state === 'stopped') {
        stoppedNotifications += 1;
        if (!didReenter) {
          didReenter = true;
          reentrantStop = supervisor.stop();
        }
      }
    });

    const outerStop = supervisor.stop();

    expect(reentrantStop).toBe(outerStop);
    await outerStop;
    expect(stoppedNotifications).toBe(1);
  });

  it('does not leave a stability timer when a subscriber stops during the ready transition', async () => {
    const child = new FakeChild();
    child.stdin.onEnd = () => child.exit(0);
    const { supervisor } = makeHarness({ children: [child] });
    let stopping: Promise<void> | undefined;
    supervisor.subscribe((state) => {
      if (state.state === 'ready') stopping = supervisor.stop();
    });

    const state = await finishReadyStart(supervisor, child);
    await stopping;

    expect(stateMatches(state, { state: 'stopped' })).toBe(true);
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot spawn or revive a generation stopped from the starting transition', async () => {
    const { randomByteRequests, spawnCalls, supervisor } = makeHarness();
    let stopping: Promise<void> | undefined;
    supervisor.subscribe((state) => {
      if (state.state === 'starting') stopping = supervisor.stop();
    });

    const state = await supervisor.start();
    await stopping;

    expect(stateMatches(state, { state: 'stopped' })).toBe(true);
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
    expect(randomByteRequests).toEqual([]);
    expect(spawnCalls.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['oversized readiness', `${'x'.repeat(16 * 1024)}x`],
    ['two readiness lines', `${readyLine()}${readyLine()}`],
    ['invalid JSON', '{\n'],
    ['wrong protocol', readyLine({ protocol_version: '2' })],
    ['wrong runtime version', readyLine({ runtime_version: '1.0.1' })],
    ['wrong AgentScope version', readyLine({ agentscope_version: '2.0.5' })],
    ['wrong PID', readyLine({ pid: READY_PID + 1 })],
    ['zero port', readyLine({ port: 0 })],
    ['large port', readyLine({ port: 65536 })],
  ])('fails closed and cleans up for %s', async (_label, stdout) => {
    const { children, supervisor } = makeHarness();
    const starting = supervisor.start();

    children[0].stdout.emit('data', Buffer.from(stdout));
    const state = await starting;

    expect(stateMatches(state, {
      state: 'degraded',
      reason: 'protocol-mismatch',
      detail: 'AgentScope runtime readiness validation failed.',
    })).toBe(true);
    expect(children[0].stdin.endCalls).toBe(1);
    expect(children[0].killCalls).toEqual(['SIGKILL']);
    expect(children[0].stdout.listenerCount('data')).toBe(0);
    expect(children[0].listenerCount('exit')).toBe(0);
  });

  it('rejects stdout data arriving after the single readiness line', async () => {
    let resolveFetch!: (value: FakeResponse) => void;
    const pendingFetch = new Promise<FakeResponse>((resolve) => {
      resolveFetch = resolve;
    });
    const { children, supervisor } = makeHarness({ fetch: async () => pendingFetch });
    const starting = supervisor.start();

    children[0].stdout.emit('data', Buffer.from(readyLine()));
    children[0].stdout.emit('data', Buffer.from('unexpected'));
    resolveFetch(response());
    const state = await starting;

    expect(stateIncludes(state, { state: 'degraded', reason: 'protocol-mismatch' })).toBe(true);
    expect(children[0].killCalls).toEqual(['SIGKILL']);
  });

  it.each([
    ['redirected effective URL', response(validHealth(), 'http://example.com/v1/health')],
    ['wrong response path', response(validHealth(), `http://127.0.0.1:${READY_PORT}/elsewhere`)],
    ['wrong health protocol', response({ ...validHealth(), protocol_version: '2' })],
    ['wrong health runtime', response({ ...validHealth(), runtime_version: '1.0.1' })],
    ['wrong AgentScope version', response({ ...validHealth(), agentscope_version: '2.0.5' })],
    ['unhealthy status', response({ ...validHealth(), ok: false })],
    ['unknown health key', response({ ...validHealth(), extra: true })],
    ['HTTP failure', { ...response(), ok: false, status: 401 }],
    ['missing HTTP status', { ...response(), status: undefined } as unknown as FakeResponse],
  ])('fails closed and cleans up for %s', async (_label, healthResponse) => {
    const { children, fetchCalls, supervisor } = makeHarness({
      fetch: async () => healthResponse,
    });

    const state = await finishReadyStart(supervisor, children[0]);

    expect(fetchCalls[0]?.url).toBe(`http://127.0.0.1:${READY_PORT}/v1/health`);
    expect(fetchCalls[0]?.init?.redirect).toBe('error');
    expect(stateMatches(state, {
      state: 'degraded',
      reason: 'health-failed',
      detail: 'AgentScope runtime health check failed.',
    })).toBe(true);
    expect(children[0].stdin.endCalls).toBe(1);
    expect(children[0].killCalls).toEqual(['SIGKILL']);
  });

  it('bounds startup to 15 seconds and terminates the owned child', async () => {
    const { children, supervisor } = makeHarness();
    const starting = supervisor.start();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(children[0].killCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const state = await starting;

    expect(stateMatches(state, {
      state: 'degraded',
      reason: 'start-timeout',
      detail: 'AgentScope runtime startup timed out.',
    })).toBe(true);
    expect(children[0].stdin.endCalls).toBe(1);
    expect(children[0].killCalls).toEqual(['SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an unresolved health request when startup times out', async () => {
    let healthSignal: AbortSignal | undefined;
    const { children, supervisor } = makeHarness({
      fetch: async (_url, init) => {
        healthSignal = init?.signal ?? undefined;
        return new Promise<FakeResponse>(() => undefined);
      },
    });
    const starting = supervisor.start();
    children[0].stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();

    await vi.advanceTimersByTimeAsync(15_000);
    const state = await starting;

    expect(stateIncludes(state, { state: 'degraded', reason: 'start-timeout' })).toBe(true);
    expect(healthSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts dependency failures from state, logs, and serialized diagnostics', async () => {
    const logs: string[] = [];
    let observedToken = '';
    const { children, supervisor } = makeHarness({
      logger: (level, message) => logs.push(`${level}:${message}`),
      fetch: async (_url, init) => {
        observedToken = String((init?.headers as Record<string, string>).Authorization).slice(7);
        throw new Error('provider failed');
      },
    });

    let lifecycleRejected = false;
    let state: ReturnType<AgentScopeSupervisor['status']>;
    try {
      state = await finishReadyStart(supervisor, children[0]);
    } catch {
      lifecycleRejected = true;
      state = supervisor.status();
    }
    const serialized = JSON.stringify({ state, logs });

    const bootstrapToken = inspectBootstrapLine(children[0].stdin.writes[0] ?? '').token;
    expect({
      dependencyReceivedBootstrapToken: observedToken === bootstrapToken,
      dependencyToken: secretMetadata(observedToken),
      diagnosticsContainSecret: containsSecret(serialized, observedToken),
      lifecycleRejected,
    }).toEqual({
      dependencyReceivedBootstrapToken: true,
      dependencyToken: {
        characterLength: 43,
        decodedByteLength: 32,
        canonicalBase64Url: true,
        sha256: ZERO_ENTROPY_TOKEN_SHA256,
      },
      diagnosticsContainSecret: false,
      lifecycleRejected: false,
    });
    expect(stateIncludes(state, { state: 'degraded', reason: 'health-failed' })).toBe(true);
  });
});

describe('AgentScopeSupervisor restart and stop ownership', () => {
  it('reaps an error-plus-close startup failure even when exit never fires', async () => {
    const child = new FakeChild(READY_PID, false);
    const { supervisor } = makeHarness({ children: [child] });
    const starting = supervisor.start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });

    child.emit('error', new Error('spawn failed'));
    await flushPromises();
    expect(startSettled).toBe(false);
    expect(child.listenerCount('close')).toBe(1);

    child.close(1);
    const state = await starting;
    expect(stateIncludes(state, { state: 'degraded', reason: 'exited' })).toBe(true);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('settles coalesced and queued starts on exit before readiness while retaining ownership until close', async () => {
    const exitedChild = new FakeChild(READY_PID, true, true, false);
    const replacement = new FakeChild();
    replacement.stdin.onEnd = () => replacement.exit(0);
    const { spawnCalls, supervisor } = makeHarness({ children: [exitedChild, replacement] });
    const starting = supervisor.start();
    const coalescedStart = supervisor.start();
    const queuedStart = starting.then(() => supervisor.start());

    exitedChild.exit(7);
    const [state, coalescedState, queuedState] = await Promise.all([
      starting,
      coalescedStart,
      queuedStart,
    ]);

    for (const observed of [state, coalescedState, queuedState]) {
      expect(stateMatches(observed, {
        state: 'degraded',
        reason: 'exited',
        detail: 'AgentScope runtime exited unexpectedly.',
      })).toBe(true);
    }
    expect(exitedChild.listenerCount('close')).toBe(1);
    expect(exitedChild.listenerCount('error')).toBe(1);
    expect(exitedChild.stdin.listenerCount('error')).toBe(1);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spawnCalls.length).toBe(1);

    exitedChild.close(7);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(2);
    replacement.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();
    expect(stateIncludes(supervisor.status(), { state: 'ready' })).toBe(true);
    await supervisor.stop();
  });

  it('settles exited startup during unresolved health without waiting for close', async () => {
    const exitedChild = new FakeChild(READY_PID, true, true, false);
    let healthSignal: AbortSignal | undefined;
    const { spawnCalls, supervisor } = makeHarness({
      children: [exitedChild],
      fetch: async (_url, init) => {
        healthSignal = init?.signal ?? undefined;
        return new Promise<FakeResponse>(() => undefined);
      },
    });
    const starting = supervisor.start();
    const coalescedStart = supervisor.start();
    exitedChild.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();

    exitedChild.exit(9);
    const [state, coalescedState] = await Promise.all([starting, coalescedStart]);

    expect(stateMatches(state, {
      state: 'degraded',
      reason: 'exited',
      detail: 'AgentScope runtime exited unexpectedly.',
    })).toBe(true);
    expect(stateMatches(coalescedState, {
      state: 'degraded',
      reason: 'exited',
      detail: 'AgentScope runtime exited unexpectedly.',
    })).toBe(true);
    expect(healthSignal?.aborted).toBe(true);
    expect(exitedChild.listenerCount('close')).toBe(1);
    expect(exitedChild.listenerCount('error')).toBe(1);
    expect(exitedChild.stdin.listenerCount('error')).toBe(1);
    expect(spawnCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(spawnCalls.length).toBe(1);
    exitedChild.close(9);
    await supervisor.stop();
  });

  it('cannot publish ready when resolved health races with exit before success publication', async () => {
    const exitedChild = new FakeChild(READY_PID, true, true, false);
    const replacement = new FakeChild();
    replacement.stdin.onEnd = () => replacement.exit(0);
    let resolveHealth!: (value: unknown) => void;
    let jsonRequested = false;
    const healthBody = new Promise<unknown>((resolve) => {
      resolveHealth = resolve;
    });
    const { spawnCalls, supervisor } = makeHarness({
      children: [exitedChild, replacement],
      fetch: async () => ({
        ok: true,
        status: 200,
        url: `http://127.0.0.1:${READY_PORT}/v1/health`,
        json: () => {
          jsonRequested = true;
          return healthBody;
        },
      }),
    });
    const observed: string[] = [];
    supervisor.subscribe((state) => observed.push(safeStateKind(state)));
    const starting = supervisor.start();
    const coalescedStart = supervisor.start();
    const queuedStart = starting.then(() => supervisor.start());
    exitedChild.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();
    expect(jsonRequested).toBe(true);

    resolveHealth(validHealth());
    exitedChild.exit(9);
    const [state, coalescedState, queuedState] = await Promise.all([
      starting,
      coalescedStart,
      queuedStart,
    ]);
    await flushPromises();

    for (const result of [state, coalescedState, queuedState]) {
      expect(stateMatches(result, {
        state: 'degraded',
        reason: 'exited',
        detail: 'AgentScope runtime exited unexpectedly.',
      })).toBe(true);
    }
    expect(observed.includes('ready')).toBe(false);
    expect(stateIncludes(supervisor.status(), { state: 'degraded', reason: 'exited' })).toBe(
      true,
    );
    expect(exitedChild.listenerCount('close')).toBe(1);
    expect(exitedChild.listenerCount('error')).toBe(1);
    expect(exitedChild.stdin.listenerCount('error')).toBe(1);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spawnCalls.length).toBe(1);

    exitedChild.close(9);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(2);
    replacement.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();
    expect(stateIncludes(supervisor.status(), { state: 'ready' })).toBe(true);
    await supervisor.stop();
  });

  it('retains error listeners and stop ownership between asynchronous exit and close', async () => {
    const child = new FakeChild(READY_PID, true, true, false);
    const { supervisor } = makeHarness({ children: [child] });
    await finishReadyStart(supervisor, child);
    let stopSettled = false;
    const stopping = supervisor.stop().then(() => {
      stopSettled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(child.exited).toBe(true);
    expect(stopSettled).toBe(false);
    expect(child.listenerCount('close')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);
    expect(child.stdin.listenerCount('error')).toBe(1);
    child.stdin.emit('error', new Error('late EPIPE'));
    child.emit('error', new Error('late child error'));
    expect(stateIncludes(supervisor.status(), { state: 'stopped' })).toBe(false);

    child.close(1, 'SIGKILL');
    await stopping;
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
  });

  it('defers an unexpected restart and safely absorbs errors until close follows exit', async () => {
    const exitedChild = new FakeChild(READY_PID, true, true, false);
    const replacement = new FakeChild();
    replacement.stdin.onEnd = () => replacement.exit(0);
    const { spawnCalls, supervisor } = makeHarness({ children: [exitedChild, replacement] });
    await finishReadyStart(supervisor, exitedChild);

    exitedChild.exit(7);
    exitedChild.stdin.emit('error', new Error('late EPIPE'));
    exitedChild.emit('error', new Error('late child error'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stateIncludes(supervisor.status(), { state: 'degraded', reason: 'exited' })).toBe(
      true,
    );
    expect(exitedChild.listenerCount('error')).toBe(1);
    expect(exitedChild.stdin.listenerCount('error')).toBe(1);
    expect(exitedChild.listenerCount('close')).toBe(1);
    expect(spawnCalls.length).toBe(1);

    exitedChild.close(7);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(2);
    replacement.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();
    expect(stateIncludes(supervisor.status(), { state: 'ready' })).toBe(true);
    await supervisor.stop();
  });

  it('retains failed-start ownership until an asynchronously killed child actually exits', async () => {
    const failedChild = new FakeChild(READY_PID, false);
    const replacement = new FakeChild();
    const { spawnCalls, supervisor } = makeHarness({ children: [failedChild, replacement] });
    const starting = supervisor.start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });

    failedChild.stdout.emit('data', Buffer.from('{\n'));
    await flushPromises();

    expect(failedChild.killCalls).toEqual(['SIGKILL']);
    expect(startSettled).toBe(false);
    expect(failedChild.listenerCount('exit')).toBe(1);
    expect(spawnCalls.length).toBe(1);
    const repeatedStart = supervisor.start();
    await flushPromises();
    expect(spawnCalls.length).toBe(1);

    failedChild.exit(1, 'SIGKILL');
    const [state, repeatedState] = await Promise.all([starting, repeatedStart]);
    expect(stateIncludes(state, { state: 'degraded', reason: 'protocol-mismatch' })).toBe(true);
    expect(
      stateIncludes(repeatedState, { state: 'degraded', reason: 'protocol-mismatch' }),
    ).toBe(true);
    expect(failedChild.listenerCount('exit')).toBe(0);
  });

  it('settles failed startup at 15 seconds but retains ownership when kill returns false without close', async () => {
    const failedChild = new FakeChild(READY_PID, false, false);
    const replacement = new FakeChild();
    replacement.stdin.onEnd = () => replacement.exit(0);
    const { spawnCalls, supervisor } = makeHarness({ children: [failedChild, replacement] });
    const starting = supervisor.start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });
    failedChild.stdout.emit('data', Buffer.from('{\n'));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(startSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const state = await starting;

    expect(stateIncludes(state, { state: 'degraded', reason: 'protocol-mismatch' })).toBe(true);
    expect(failedChild.listenerCount('close')).toBe(1);
    expect(failedChild.listenerCount('error')).toBe(1);
    expect(spawnCalls.length).toBe(1);
    expect(stateIncludes(await supervisor.start(), { state: 'degraded' })).toBe(true);
    expect(spawnCalls.length).toBe(1);

    failedChild.close(1);
    const restarted = supervisor.start();
    expect(spawnCalls.length).toBe(2);
    replacement.stdout.emit('data', Buffer.from(readyLine()));
    expect(stateIncludes(await restarted, { state: 'ready' })).toBe(true);
    await supervisor.stop();
  });

  it('restarts after 1, 3, and 10 seconds without overlap, then exhausts the budget', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
    const { spawnCalls, supervisor } = makeHarness({ children });
    await finishReadyStart(supervisor, children[0]);

    children[0].exit(7);
    expect(stateIncludes(supervisor.status(), { state: 'degraded', reason: 'exited' })).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(2);
    await finishRestart(children[1]);

    children[1].exit(7);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(spawnCalls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(3);
    await finishRestart(children[2]);

    children[2].exit(7);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(spawnCalls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(4);
    await finishRestart(children[3]);

    children[3].exit(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnCalls.length).toBe(4);
    expect(stateMatches(supervisor.status(), {
      state: 'degraded',
      reason: 'exited',
      detail: 'AgentScope runtime exited unexpectedly.',
    })).toBe(true);

    async function finishRestart(child: FakeChild): Promise<void> {
      child.stdout.emit('data', Buffer.from(readyLine()));
      await flushPromises();
      expect(stateIncludes(supervisor.status(), { state: 'ready' })).toBe(true);
    }
  });

  it('resets the restart budget only after 60 continuous healthy seconds', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    const { spawnCalls, supervisor } = makeHarness({ children });
    await finishReadyStart(supervisor, children[0]);

    await vi.advanceTimersByTimeAsync(59_999);
    children[0].exit(7);
    await vi.advanceTimersByTimeAsync(1_000);
    children[1].stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();

    await vi.advanceTimersByTimeAsync(60_000);
    children[1].exit(7);
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls.length).toBe(3);
  });

  it('stops responsively via stdin EOF, cancels restart, and never force-kills', async () => {
    const child = new FakeChild();
    child.stdin.onEnd = () => child.exit(0);
    const { spawnCalls, supervisor } = makeHarness({ children: [child] });
    await finishReadyStart(supervisor, child);

    await Promise.all([supervisor.stop(), supervisor.stop()]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual([]);
    expect(spawnCalls.length).toBe(1);
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('atomically aborts unresolved health before sending intentional stdin EOF', async () => {
    const child = new FakeChild(READY_PID, false);
    let healthSignal: AbortSignal | undefined;
    let signalWasAbortedAtEof = false;
    child.stdin.onEnd = () => {
      signalWasAbortedAtEof = healthSignal?.aborted === true;
    };
    const { supervisor } = makeHarness({
      children: [child],
      fetch: async (_url, init) => {
        healthSignal = init?.signal ?? undefined;
        return new Promise<FakeResponse>(() => undefined);
      },
    });
    const starting = supervisor.start();
    child.stdout.emit('data', Buffer.from(readyLine()));
    await flushPromises();

    const stopping = supervisor.stop();

    expect(healthSignal?.aborted).toBe(true);
    expect(signalWasAbortedAtEof).toBe(true);
    child.exit(0);
    await Promise.all([starting, stopping]);
  });

  it('ignores intentional stdin and child errors while retaining ownership until exit', async () => {
    const child = new FakeChild(READY_PID, false);
    const { supervisor } = makeHarness({ children: [child] });
    await finishReadyStart(supervisor, child);

    const stopping = supervisor.stop();
    child.stdin.emit('error', new Error('intentional EPIPE'));
    child.emit('error', new Error('late process error'));
    await flushPromises();

    expect(child.killCalls).toEqual([]);
    expect(child.listenerCount('exit')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);
    expect(child.stdin.listenerCount('error')).toBe(1);
    expect(stateIncludes(supervisor.status(), { state: 'stopped' })).toBe(false);

    child.exit(0);
    await stopping;
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
  });

  it('waits five seconds before force-killing only the unresponsive owned child', async () => {
    const owned = new FakeChild();
    const unrelated = new FakeChild(9999);
    const { supervisor } = makeHarness({ children: [owned] });
    await finishReadyStart(supervisor, owned);

    const stopping = supervisor.stop();
    expect(owned.stdin.endCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(owned.killCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(owned.killCalls).toEqual(['SIGKILL']);
    expect(unrelated.killCalls).toEqual([]);
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
  });

  it('does not report stopped until an asynchronous force-kill is reaped', async () => {
    const owned = new FakeChild(READY_PID, false);
    const { supervisor } = makeHarness({ children: [owned] });
    await finishReadyStart(supervisor, owned);
    let stopSettled = false;
    const stopping = supervisor.stop().then(() => {
      stopSettled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(owned.killCalls).toEqual(['SIGKILL']);
    expect(stopSettled).toBe(false);
    expect(stateIncludes(supervisor.status(), { state: 'stopped' })).toBe(false);
    expect(owned.listenerCount('exit')).toBe(1);

    owned.exit(1, 'SIGKILL');
    await stopping;
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
    expect(owned.listenerCount('exit')).toBe(0);
  });

  it('bounds kill-false stop and queued start as degraded while retaining ownership until close', async () => {
    const owned = new FakeChild(READY_PID, false, false);
    const replacement = new FakeChild();
    replacement.stdin.onEnd = () => replacement.exit(0);
    const { spawnCalls, supervisor } = makeHarness({ children: [owned, replacement] });
    await finishReadyStart(supervisor, owned);
    let stopSettled = false;
    const stopping = supervisor.stop().then(() => {
      stopSettled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const queuedStart = supervisor.start();
    await flushPromises();

    expect(owned.killCalls).toEqual(['SIGKILL']);
    expect(stopSettled).toBe(false);
    expect(stateIncludes(supervisor.status(), { state: 'stopped' })).toBe(false);
    expect(owned.listenerCount('close')).toBe(1);
    expect(spawnCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(stopSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stateIncludes(supervisor.status(), { state: 'degraded' })).toBe(true);
    expect(stateIncludes(await queuedStart, { state: 'degraded' })).toBe(true);
    expect(owned.listenerCount('close')).toBe(1);
    expect(owned.listenerCount('error')).toBe(1);
    expect(spawnCalls.length).toBe(1);

    owned.close(0);
    const restarted = supervisor.start();
    expect(spawnCalls.length).toBe(2);
    replacement.stdout.emit('data', Buffer.from(readyLine()));
    expect(stateIncludes(await restarted, { state: 'ready' })).toBe(true);
    await supervisor.stop();
  });

  it('cancels a pending restart and cannot revive the stopped generation', async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnCalls, supervisor } = makeHarness({ children });
    await finishReadyStart(supervisor, children[0]);
    children[0].exit(7);

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnCalls.length).toBe(1);
    expect(stateMatches(supervisor.status(), { state: 'stopped' })).toBe(true);
  });
});
