/**
 * `run_command` tool: executes build/test/diagnostic commands for the agent.
 *
 * Safety rules (P0.3):
 * - Commands always run with the workspace root as working directory.
 * - Executable and arguments travel as an array; no shell is ever spawned, so
 *   shell metacharacters stay inert data.
 * - Only bare executable names are accepted (no paths).
 * - Timeouts, output byte caps and cancellation signals are enforced here.
 *
 * Policy (auto-run vs approval vs forbidden) is decided by `classifyCommand`
 * before execution, in the tool router.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { requireToolString, toToolInteger, toolInputError } from './toolInput.js';
import type { ToolExecutionExtras, WorkspaceToolContext } from './toolRouter.js';

export interface RunCommandOutput {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ParsedCommand {
  command: string;
  args: string[];
}

export type CommandVerdict = 'allow' | 'approval' | 'forbidden';

export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
export const RUN_COMMAND_MAX_TIMEOUT_MS = 180_000;
export const RUN_COMMAND_MAX_OUTPUT_BYTES = 32 * 1024;
const RUN_COMMAND_MAX_ARGS = 32;
const RUN_COMMAND_MAX_ARG_LENGTH = 500;
const BARE_COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;
/** Shell metacharacters never belong in verification-command arguments. */
const UNSAFE_ARG_PATTERN = /[&|<>^%"`\r\n]/;

/** Read-only git subcommands that can run without user approval. */
const GIT_AUTO_ALLOWED_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'ls-files',
  'describe',
  'rev-parse',
  'remote',
]);

/** Package manager script names considered verification work, auto-runnable. */
const AUTO_ALLOWED_SCRIPT_NAMES = new Set(['test', 'tests', 'typecheck', 'type-check', 'lint', 'build', 'check']);

/**
 * Executables that are never executed, even after approval: shells, network
 * transfer tools, privilege escalation and destructive system commands.
 */
const FORBIDDEN_EXECUTABLES = new Set([
  'sh',
  'bash',
  'zsh',
  'cmd',
  'powershell',
  'pwsh',
  'eval',
  'sudo',
  'su',
  'curl',
  'wget',
  'scp',
  'ssh',
  'telnet',
  'nc',
  'netcat',
  'rm',
  'rmdir',
  'del',
  'erase',
  'rd',
  'format',
  'mkfs',
  'fdisk',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'reg',
  'net',
  'sc',
]);

/** Validates model-supplied input into a spawn-ready command description. */
export function parseCommandInput(rawInput: Record<string, unknown>): ParsedCommand {
  const command = requireToolString(rawInput, 'command');
  if (!BARE_COMMAND_PATTERN.test(command)) {
    throw toolInputError('invalid-input', 'Tool input "command" must be a bare executable name (no paths or shell syntax).');
  }
  const rawArgs = rawInput.args;
  if (rawArgs === undefined) return { command, args: [] };
  if (!Array.isArray(rawArgs)) {
    throw toolInputError('invalid-input', 'Tool input "args" must be an array of strings.');
  }
  if (rawArgs.length > RUN_COMMAND_MAX_ARGS) {
    throw toolInputError('invalid-input', `At most ${RUN_COMMAND_MAX_ARGS} arguments are allowed.`);
  }
  const args = rawArgs.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw toolInputError('invalid-input', `Argument ${index + 1} must be a string.`);
    }
    if (entry.length > RUN_COMMAND_MAX_ARG_LENGTH) {
      throw toolInputError('invalid-input', `Argument ${index + 1} exceeds ${RUN_COMMAND_MAX_ARG_LENGTH} characters.`);
    }
    if (UNSAFE_ARG_PATTERN.test(entry)) {
      throw toolInputError('invalid-input', `Argument ${index + 1} contains shell metacharacters.`);
    }
    return entry;
  });
  return { command, args };
}

/**
 * Classifies a parsed command for the tool router. Safety is judged from the
 * executable plus its first arguments, never the executable name alone.
 */
export function classifyCommand(command: string, args: string[]): CommandVerdict {
  const name = command.toLowerCase();
  if (FORBIDDEN_EXECUTABLES.has(name)) return 'forbidden';

  if (name === 'git') {
    const subcommand = args[0]?.toLowerCase();
    return subcommand && GIT_AUTO_ALLOWED_SUBCOMMANDS.has(subcommand) ? 'allow' : 'approval';
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    const subcommand = args[0]?.toLowerCase();
    if (subcommand === 'test') return 'allow';
    if (subcommand === 'run') {
      const script = args[1]?.toLowerCase();
      return script && AUTO_ALLOWED_SCRIPT_NAMES.has(script) ? 'allow' : 'approval';
    }
    return 'approval';
  }
  // Anything unknown goes to the user instead of running blindly.
  return 'approval';
}

export async function runRunCommand(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
  extras: ToolExecutionExtras = {},
): Promise<{ output: RunCommandOutput; truncated: boolean }> {
  const parsed = parseCommandInput(rawInput);
  const timeoutMs = toToolInteger(
    rawInput,
    'timeoutMs',
    RUN_COMMAND_DEFAULT_TIMEOUT_MS,
    100,
    RUN_COMMAND_MAX_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  const run = await spawnWithWindowsFallback(parsed.command, parsed.args, {
    cwd: context.canonicalRootPath,
    timeoutMs,
    signal: extras.signal,
  });

  return {
    output: {
      command: parsed.command,
      args: parsed.args,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs: Math.max(0, Date.now() - startedAt),
      timedOut: run.timedOut,
    },
    truncated: run.truncated,
  };
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Windows ships package managers as `.cmd` shims that `spawn` cannot resolve
 * without a shell. `.exe`/bare names are tried first; `.cmd` failures arrive
 * either synchronously (EINVAL since CVE-2024-27980) or via the async `error`
 * event (ENOENT), and both fall through to the next candidate.
 */
async function spawnWithWindowsFallback(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnOutcome> {
  const candidates = process.platform === 'win32'
    ? [`${command}.exe`, command, `${command}.cmd`, `${command}.bat`]
    : [command];
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await spawnCommand(candidates[index], args, options);
    } catch (error) {
      const lastCandidate = index === candidates.length - 1;
      if (lastCandidate || !isMissingExecutable(error)) {
        if (isMissingExecutable(error)) {
          throw toolInputError('command-not-found', `Executable "${command}" is not available on this system.`);
        }
        throw error;
      }
    }
  }
  throw toolInputError('command-not-found', `Executable "${command}" is not available on this system.`);
}

function spawnCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const target = resolveSpawnTarget(command, args);
      child = spawn(target.command, target.args, { cwd: options.cwd, shell: false, windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };

    const append = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = RUN_COMMAND_MAX_OUTPUT_BYTES - (stream === 'stdout' ? stdoutBytes : stderrBytes);
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf-8');
      const sliced = text.length > remaining ? text.slice(0, remaining) : text;
      if (sliced.length < text.length) truncated = true;
      if (stream === 'stdout') {
        stdout += sliced;
        stdoutBytes += sliced.length;
      } else {
        stderr += sliced;
        stderrBytes += sliced.length;
      }
    };

    const killChild = (): void => {
      timedOut = true;
      child.kill();
    };
    const timer = setTimeout(killChild, options.timeoutMs);
    const onAbort = (): void => {
      killChild();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        killChild();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    child.on('error', fail);
    child.on('close', (code, signalName) => {
      if (signalName && !timedOut) timedOut = options.signal?.aborted === true;
      finish({ exitCode: code, stdout, stderr, timedOut, truncated });
    });
  });
}

/** ENOENT (missing file) and EINVAL (`.cmd` without shell) both mean retry. */
function isMissingExecutable(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'EINVAL';
}

/**
 * `.cmd`/`.bat` shims cannot be spawned without a shell on Windows, so they
 * run through `cmd /d /s /c` with every token individually quoted. Arguments
 * were already screened for shell metacharacters in `parseCommandInput`.
 */
function resolveSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map((part) => `"${part}"`).join(' ');
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
  }
  return { command, args };
}
