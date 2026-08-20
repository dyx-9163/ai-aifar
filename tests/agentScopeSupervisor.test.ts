import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentScopeSupervisor,
  type AgentScopeChildProcess,
  type AgentScopeFetch,
  type AgentScopeSpawn,
} from '../src/main/agentScopeSupervisor';
import type { AgentScopeRuntimePaths } from '../src/main/agentScopeRuntimePaths';

const EXPECTED_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
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

  constructor(
    readonly pid: number = READY_PID,
    private readonly exitWhenKilled = true,
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.exitWhenKilled) this.exit(1, typeof signal === 'number' ? null : (signal ?? null));
    return true;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
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
  it('writes one bounded config line from exactly 32 random bytes and starts the direct minimal process', async () => {
    const logs: string[] = [];
    const { children, fetchCalls, randomByteRequests, spawnCalls, supervisor } = makeHarness({
      logger: (level, message) => logs.push(`${level}:${message}`),
    });

    const state = await finishReadyStart(supervisor, children[0]);

    expect(randomByteRequests).toEqual([32]);
    expect(children[0].stdin.writes).toHaveLength(1);
    expect(children[0].stdin.writes[0].endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(children[0].stdin.writes[0], 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(children[0].stdin.writes[0])).toEqual({
      token: EXPECTED_TOKEN,
      user_data_dir: path.resolve('C:\\PrivateAI\\user-data'),
      log_dir: path.resolve('C:\\PrivateAI\\logs'),
    });
    expect(spawnCalls).toEqual([
      {
        command: runtimePaths.pythonPath,
        args: ['-m', 'private_ai_agentscope.bootstrap'],
        options: {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            PYTHONPATH: `${runtimePaths.applicationPath}${path.delimiter}${runtimePaths.sitePackagesPath}`,
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1',
          },
        },
      },
    ]);
    expect(state).toEqual({
      state: 'ready',
      pid: READY_PID,
      port: READY_PORT,
      runtimeVersion: '1.0.0',
      agentScopeVersion: '2.0.6',
    });
    expect(fetchCalls).toEqual([
      {
        url: `http://127.0.0.1:${READY_PORT}/v1/health`,
        init: {
          headers: { Authorization: `Bearer ${EXPECTED_TOKEN}` },
          redirect: 'error',
          signal: expect.any(AbortSignal),
        },
      },
    ]);
    expect(JSON.stringify(spawnCalls)).not.toContain(EXPECTED_TOKEN);
    expect(JSON.stringify(state)).not.toContain(EXPECTED_TOKEN);
    expect(logs.join('\n')).not.toContain(EXPECTED_TOKEN);
  });

  it('notifies active subscribers of transitions and honors unsubscribe', async () => {
    const child = new FakeChild();
    child.stdin.onEnd = () => child.exit(0);
    const { supervisor } = makeHarness({ children: [child] });
    const observed: string[] = [];
    const unsubscribe = supervisor.subscribe((state) => observed.push(state.state));

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
    expect(spawnCalls).toHaveLength(1);
    children[0].stdout.emit('data', Buffer.from(readyLine()));

    const [firstState, concurrentState, repeatedState] = await Promise.all([
      firstStart,
      concurrentStart,
      firstStart.then(() => supervisor.start()),
    ]);

    expect(firstState.state).toBe('ready');
    expect(concurrentState.state).toBe('ready');
    expect(repeatedState.state).toBe('ready');
    expect(spawnCalls).toHaveLength(1);
    expect(randomByteRequests).toEqual([32]);
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

    expect(state).toEqual({ state: 'stopped' });
    expect(supervisor.status()).toEqual({ state: 'stopped' });
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

    expect(state).toEqual({ state: 'stopped' });
    expect(supervisor.status()).toEqual({ state: 'stopped' });
    expect(randomByteRequests).toEqual([]);
    expect(spawnCalls).toHaveLength(0);
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

    expect(state).toEqual({
      state: 'degraded',
      reason: 'protocol-mismatch',
      detail: 'AgentScope runtime readiness validation failed.',
    });
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

    expect(state).toMatchObject({ state: 'degraded', reason: 'protocol-mismatch' });
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
    expect(state).toEqual({
      state: 'degraded',
      reason: 'health-failed',
      detail: 'AgentScope runtime health check failed.',
    });
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

    expect(state).toEqual({
      state: 'degraded',
      reason: 'start-timeout',
      detail: 'AgentScope runtime startup timed out.',
    });
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

    expect(state).toMatchObject({ state: 'degraded', reason: 'start-timeout' });
    expect(healthSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts dependency errors from state, logs, and serialized diagnostics', async () => {
    const logs: string[] = [];
    let observedToken = '';
    const { children, supervisor } = makeHarness({
      logger: (level, message) => logs.push(`${level}:${message}`),
      fetch: async (_url, init) => {
        observedToken = String((init?.headers as Record<string, string>).Authorization).slice(7);
        throw new Error(`provider leaked ${observedToken}`);
      },
    });

    const state = await finishReadyStart(supervisor, children[0]);
    const serialized = JSON.stringify({ state, logs });

    expect(observedToken).toBe(EXPECTED_TOKEN);
    expect(serialized).not.toContain(EXPECTED_TOKEN);
    expect(state).toMatchObject({ state: 'degraded', reason: 'health-failed' });
  });
});

describe('AgentScopeSupervisor restart and stop ownership', () => {
  it('restarts after 1, 3, and 10 seconds without overlap, then exhausts the budget', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
    const { spawnCalls, supervisor } = makeHarness({ children });
    await finishReadyStart(supervisor, children[0]);

    children[0].exit(7);
    expect(supervisor.status()).toMatchObject({ state: 'degraded', reason: 'exited' });
    await vi.advanceTimersByTimeAsync(999);
    expect(spawnCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls).toHaveLength(2);
    await finishRestart(children[1]);

    children[1].exit(7);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(spawnCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls).toHaveLength(3);
    await finishRestart(children[2]);

    children[2].exit(7);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(spawnCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls).toHaveLength(4);
    await finishRestart(children[3]);

    children[3].exit(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnCalls).toHaveLength(4);
    expect(supervisor.status()).toEqual({
      state: 'degraded',
      reason: 'exited',
      detail: 'AgentScope runtime exited unexpectedly.',
    });

    async function finishRestart(child: FakeChild): Promise<void> {
      child.stdout.emit('data', Buffer.from(readyLine()));
      await flushPromises();
      expect(supervisor.status().state).toBe('ready');
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
    expect(spawnCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls).toHaveLength(3);
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
    expect(spawnCalls).toHaveLength(1);
    expect(supervisor.status()).toEqual({ state: 'stopped' });
    expect(vi.getTimerCount()).toBe(0);
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
    expect(supervisor.status()).toEqual({ state: 'stopped' });
  });

  it('cancels a pending restart and cannot revive the stopped generation', async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnCalls, supervisor } = makeHarness({ children });
    await finishReadyStart(supervisor, children[0]);
    children[0].exit(7);

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnCalls).toHaveLength(1);
    expect(supervisor.status()).toEqual({ state: 'stopped' });
  });
});
