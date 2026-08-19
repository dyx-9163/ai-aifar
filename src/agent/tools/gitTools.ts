/**
 * Read-only Git tools: `git_status` and `git_diff` (P0 §6.6).
 *
 * These give the agent a structured view of the working tree so it can
 * distinguish pre-existing user modifications from its own changes and run
 * final reviews. Only read-only inspection is exposed: committing, pushing,
 * branching and history rewrites stay outside the automatic tool surface.
 *
 * Both tools run through `runWorkspaceProcess`, so timeouts, output byte
 * caps and cancellation behave exactly like `run_command`.
 */

import path from 'node:path';
import { resolveWithinRoot } from '../workspace/pathSecurity.js';
import { requireToolString, toToolBoolean, toolInputError } from './toolInput.js';
import { runWorkspaceProcess } from './runCommand.js';
import type { ToolExecutionExtras, WorkspaceToolContext } from './toolRouter.js';

const GIT_TOOL_TIMEOUT_MS = 15_000;

export interface GitStatusEntry {
  /** Workspace-relative path using forward slashes. */
  path: string;
  /** Source path for renames and copies. */
  originalPath?: string;
  /** Porcelain v1 index (staged) status character. */
  index: string;
  /** Porcelain v1 worktree (unstaged) status character. */
  worktree: string;
}

export interface GitStatusOutput {
  isGitRepository: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** True when the worktree has no staged, unstaged or untracked entries. */
  clean?: boolean;
  entries?: GitStatusEntry[];
}

export interface GitDiffOutput {
  staged: boolean;
  /** Unified diff text, empty when there are no changes. */
  diff: string;
}

/**
 * Parses `git status --porcelain=v1 --branch -z` output. Entries are
 * NUL-separated; rename/copy entries carry an extra NUL-separated origin
 * path immediately after the renamed path.
 */
export function parsePorcelainStatus(raw: string): Pick<GitStatusOutput, 'branch' | 'upstream' | 'ahead' | 'behind'> & {
  entries: GitStatusEntry[];
} {
  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const result: Pick<GitStatusOutput, 'branch' | 'upstream' | 'ahead' | 'behind'> & { entries: GitStatusEntry[] } = {
    entries: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('## ')) {
      const header = token.slice(3);
      const counts = /\[([^\]]*)\]/.exec(header);
      if (counts) {
        const ahead = /ahead (\d+)/.exec(counts[1]);
        const behind = /behind (\d+)/.exec(counts[1]);
        if (ahead) result.ahead = Number(ahead[1]);
        if (behind) result.behind = Number(behind[1]);
      }
      const names = header.replace(/\s*\[[^\]]*\]/, '');
      if (names !== '(no commits yet)') {
        const [branch, upstream] = names.split('...');
        if (branch) result.branch = branch;
        if (upstream) result.upstream = upstream;
      }
      continue;
    }
    if (token.startsWith('#')) continue;
    // Porcelain v1 entries look like "XY path" with a separator space.
    if (token.length < 4 || token[2] !== ' ') continue;
    const entry: GitStatusEntry = {
      path: token.slice(3),
      index: token[0],
      worktree: token[1],
    };
    if (entry.index === 'R' || entry.index === 'C') {
      const originalPath = tokens[index + 1];
      if (originalPath !== undefined) {
        entry.originalPath = originalPath;
        index += 1;
      }
    }
    result.entries.push(entry);
  }
  return result;
}

async function runGit(
  rootPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  const outcome = await runWorkspaceProcess('git', ['-C', rootPath, ...args], {
    cwd: rootPath,
    timeoutMs: GIT_TOOL_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    truncated: outcome.truncated,
  };
}

function assertGitSucceeded(outcome: { exitCode: number | null; stderr: string; timedOut: boolean }, command: string): void {
  if (outcome.timedOut && outcome.exitCode === null) {
    throw toolInputError('git-timeout', `${command} exceeded the ${GIT_TOOL_TIMEOUT_MS}ms timeout.`);
  }
  if (outcome.exitCode !== 0) {
    throw toolInputError(
      'git-failed',
      `${command} failed (exit ${outcome.exitCode ?? 'unknown'}): ${outcome.stderr.trim()}`,
    );
  }
}

function isNotARepository(outcome: { exitCode: number | null; stderr: string }): boolean {
  return outcome.exitCode !== 0 && /not a git repository/i.test(outcome.stderr);
}

export async function runGitStatus(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
  extras: ToolExecutionExtras = {},
): Promise<{ output: GitStatusOutput; truncated: boolean }> {
  void rawInput;
  const outcome = await runGit(
    context.canonicalRootPath,
    ['status', '--porcelain=v1', '--branch', '--untracked-files=normal', '-z'],
    extras.signal,
  );
  if (isNotARepository(outcome)) {
    return { output: { isGitRepository: false }, truncated: false };
  }
  assertGitSucceeded(outcome, 'git status');
  const parsed = parsePorcelainStatus(outcome.stdout);
  const output: GitStatusOutput = {
    isGitRepository: true,
    clean: parsed.entries.length === 0,
    entries: parsed.entries,
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
    ...(parsed.ahead !== undefined ? { ahead: parsed.ahead } : {}),
    ...(parsed.behind !== undefined ? { behind: parsed.behind } : {}),
  };
  return { output, truncated: false };
}

export async function runGitDiff(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
  extras: ToolExecutionExtras = {},
): Promise<{ output: GitDiffOutput; truncated: boolean }> {
  const staged = toToolBoolean(rawInput, 'staged', false);
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');

  const pathInput = requireToolString(rawInput, 'path', { optional: true });
  if (pathInput !== undefined) {
    const absolute = resolveWithinRoot(context.canonicalRootPath, pathInput);
    const relative = path.relative(context.canonicalRootPath, absolute).split(path.sep).join('/');
    args.push('--', relative === '' ? '.' : relative);
  }

  const outcome = await runGit(context.canonicalRootPath, args, extras.signal);
  if (isNotARepository(outcome)) {
    throw toolInputError('not-a-git-repository', 'The workspace is not a Git repository.');
  }
  assertGitSucceeded(outcome, 'git diff');
  return { output: { staged, diff: outcome.stdout }, truncated: outcome.truncated };
}
