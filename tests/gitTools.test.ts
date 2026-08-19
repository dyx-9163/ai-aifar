import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolCall } from '../src/shared/toolProtocol';
import {
  classifyToolCall,
  executeAgentToolCall,
  type WorkspaceToolContext,
} from '../src/agent/tools/toolRouter';
import {
  parsePorcelainStatus,
  type GitDiffOutput,
  type GitStatusOutput,
} from '../src/agent/tools/gitTools';

let tempDirectories: string[] = [];
let workspaceRoot = '';
let context: WorkspaceToolContext = { canonicalRootPath: '', trustLevel: 'read-write' };

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-git-tools-'));
  tempDirectories.push(directory);
  return directory;
}

function buildCall(toolName: string, input: unknown): AgentToolCall {
  return { callId: 'call-1', turnId: 'turn-1', toolName: toolName as AgentToolCall['toolName'], input };
}

async function runTool(toolName: string, input: unknown, trust: 'read-only' | 'read-write' = 'read-write') {
  return executeAgentToolCall(buildCall(toolName, input), { ...context, trustLevel: trust });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? String(result.error)}`);
  }
  return result.stdout;
}

function initRepo(root: string): void {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'agent@example.com');
  git(root, 'config', 'user.name', 'Test Agent');
  git(root, 'config', 'commit.gpgsign', 'false');
}

function commitBaseline(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'README.md'), '# baseline\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'baseline');
}

beforeEach(() => {
  workspaceRoot = createTempDir();
  context = { canonicalRootPath: realpathSync.native(workspaceRoot), trustLevel: 'read-write' };
});

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('parsePorcelainStatus', () => {
  it('parses branch header with ahead/behind counts and entries', () => {
    const parsed = parsePorcelainStatus('## main...origin/main [ahead 2, behind 1]\u0000 M src/a.ts\u0000?? new.ts\u0000');
    expect(parsed.branch).toBe('main');
    expect(parsed.upstream).toBe('origin/main');
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.entries).toEqual([
      { path: 'src/a.ts', index: ' ', worktree: 'M' },
      { path: 'new.ts', index: '?', worktree: '?' },
    ]);
  });

  it('consumes the origin path of rename entries', () => {
    const parsed = parsePorcelainStatus('## main\u0000R  b.ts\u0000a.ts\u0000M  c.ts\u0000');
    expect(parsed.entries).toEqual([
      { path: 'b.ts', originalPath: 'a.ts', index: 'R', worktree: ' ' },
      { path: 'c.ts', index: 'M', worktree: ' ' },
    ]);
  });

  it('leaves the branch undefined before the first commit', () => {
    const parsed = parsePorcelainStatus('## (no commits yet)\u0000?? x.ts\u0000');
    expect(parsed.branch).toBeUndefined();
    expect(parsed.entries).toEqual([{ path: 'x.ts', index: '?', worktree: '?' }]);
  });
});

describe('git_status tool', () => {
  it('reports a plain directory as not a git repository', async () => {
    const result = await runTool('git_status', {});
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ isGitRepository: false });
  });

  it('reports a clean repository with its branch', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    const result = await runTool('git_status', {});
    expect(result.status).toBe('success');
    const output = result.output as GitStatusOutput;
    expect(output.isGitRepository).toBe(true);
    expect(output.branch).toBe('main');
    expect(output.clean).toBe(true);
    expect(output.entries).toEqual([]);
  });

  it('lists unstaged, staged and untracked changes separately', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    appendFileSync(join(workspaceRoot, 'src', 'main.ts'), 'export const extra = 1;\n');
    writeFileSync(join(workspaceRoot, 'README.md'), '# changed\n');
    git(workspaceRoot, 'add', 'README.md');
    writeFileSync(join(workspaceRoot, 'notes.txt'), 'untracked\n');

    const result = await runTool('git_status', {});
    const output = result.output as GitStatusOutput;
    expect(output.clean).toBe(false);
    expect(output.entries).toContainEqual({ path: 'src/main.ts', index: ' ', worktree: 'M' });
    expect(output.entries).toContainEqual({ path: 'README.md', index: 'M', worktree: ' ' });
    expect(output.entries).toContainEqual({ path: 'notes.txt', index: '?', worktree: '?' });
  });

  it('runs without approval in a read-only workspace', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    const policy = classifyToolCall(buildCall('git_status', {}), { ...context, trustLevel: 'read-only' });
    expect(policy).toEqual({ kind: 'allow' });
    const result = await runTool('git_status', {}, 'read-only');
    expect(result.status).toBe('success');
  });
});

describe('git_diff tool', () => {
  it('rejects a workspace that is not a git repository', async () => {
    const result = await runTool('git_diff', {});
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not-a-git-repository');
    expect(result.error?.retryable).toBe(false);
  });

  it('returns an empty diff on a clean repository', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    const result = await runTool('git_diff', {});
    expect(result.status).toBe('success');
    expect((result.output as GitDiffOutput).diff).toBe('');
  });

  it('shows working-tree changes with added and removed lines', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    writeFileSync(join(workspaceRoot, 'src', 'main.ts'), 'export const answer = 43;\n');

    const result = await runTool('git_diff', {});
    const output = result.output as GitDiffOutput;
    expect(output.staged).toBe(false);
    expect(output.diff).toContain('src/main.ts');
    expect(output.diff).toContain('-export const answer = 42;');
    expect(output.diff).toContain('+export const answer = 43;');
  });

  it('shows staged changes only when "staged" is true', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    writeFileSync(join(workspaceRoot, 'README.md'), '# staged change\n');
    git(workspaceRoot, 'add', 'README.md');

    const unstaged = await runTool('git_diff', {});
    expect((unstaged.output as GitDiffOutput).diff).toBe('');

    const staged = await runTool('git_diff', { staged: true });
    const output = staged.output as GitDiffOutput;
    expect(output.staged).toBe(true);
    expect(output.diff).toContain('README.md');
    expect(output.diff).toContain('-# baseline');
    expect(output.diff).toContain('+# staged change');
  });

  it('limits the diff to a requested path', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    writeFileSync(join(workspaceRoot, 'src', 'main.ts'), 'export const answer = 99;\n');
    writeFileSync(join(workspaceRoot, 'README.md'), '# other change\n');

    const result = await runTool('git_diff', { path: 'src/main.ts' });
    const output = result.output as GitDiffOutput;
    expect(output.diff).toContain('src/main.ts');
    expect(output.diff).not.toContain('README.md');
  });

  it('rejects path filters escaping the workspace root', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    const result = await runTool('git_diff', { path: '../outside' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('outside-workspace');
  });

  it('runs without approval in a read-only workspace', async () => {
    initRepo(workspaceRoot);
    commitBaseline(workspaceRoot);
    const policy = classifyToolCall(buildCall('git_diff', {}), { ...context, trustLevel: 'read-only' });
    expect(policy).toEqual({ kind: 'allow' });
    const result = await runTool('git_diff', {}, 'read-only');
    expect(result.status).toBe('success');
  });
});
