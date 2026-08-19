import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolCall } from '../src/shared/toolProtocol';
import type { ApplyPatchBatchOutput } from '../src/agent/tools/applyPatch';
import {
  classifyCommand,
  parseCommandInput,
  type RunCommandOutput,
} from '../src/agent/tools/runCommand';
import {
  classifyToolCall,
  executeAgentToolCall,
  type RecordedFileChange,
  type ToolApprovalRequest,
  type WorkspaceToolContext,
} from '../src/agent/tools/toolRouter';

let tempDirectories: string[] = [];
let workspaceRoot = '';
let context: WorkspaceToolContext = { canonicalRootPath: '', trustLevel: 'read-write' };

const MAIN_TS = 'export const answer = 41;\nexport const label = "answer";\n';

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

function buildCall(toolName: string, input: unknown): AgentToolCall {
  return {
    callId: `call-${toolName}`,
    turnId: 'turn-test',
    toolName: toolName as AgentToolCall['toolName'],
    input,
  };
}

async function runTool(toolName: string, input: unknown, options: Parameters<typeof executeAgentToolCall>[2] = {}) {
  return executeAgentToolCall(buildCall(toolName, input), context, options);
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'private-ai-writetools-'));
  tempDirectories.push(workspaceRoot);
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'main.ts'), MAIN_TS);
  context = { canonicalRootPath: realpathSync.native(workspaceRoot), trustLevel: 'read-write' };
});

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('apply_patch', () => {
  it('creates a new file with an empty baseline hash', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/helper.ts',
      edits: [{ startLine: 1, endLine: 0, replacement: 'export const helper = true;' }],
    });
    expect(result.status).toBe('success');
    const output = result.output as ApplyPatchBatchOutput;
    expect(output.files[0]).toMatchObject({ path: 'src/helper.ts', action: 'created', totalLines: 1 });
    expect(readFileSync(join(workspaceRoot, 'src', 'helper.ts'), 'utf-8')).toBe('export const helper = true;');
  });

  it('treats a zero-based top-of-file insertion as line 1', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/zero.ts',
      edits: [{ startLine: 0, endLine: 0, replacement: 'export const zero = true;' }],
    });
    expect(result.status).toBe('success');
    expect(result.output).toMatchObject({ files: [{ path: 'src/zero.ts', action: 'created' }] });
    expect(readFileSync(join(workspaceRoot, 'src', 'zero.ts'), 'utf-8')).toBe('export const zero = true;');
  });

  it('executes writes automatically without any approval hook', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/gated.ts',
      edits: [{ startLine: 1, endLine: 0, replacement: 'export const gated = true;' }],
    });
    expect(result.status).toBe('success');
    expect(readFileSync(join(workspaceRoot, 'src', 'gated.ts'), 'utf-8')).toBe('export const gated = true;');
  });

  it('auto-executes writes even when an approval hook would reject', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 42;' }],
    }, { requestApproval: async () => false });
    expect(result.status).toBe('success');
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 42;\nexport const label = "answer";\n',
    );
  });

  it('classifies apply_patch as allow in read-write workspaces', () => {
    const policy = classifyToolCall(buildCall('apply_patch', {
      path: 'src/new.ts',
      edits: [{ startLine: 1, endLine: 0, replacement: 'export const fresh = true;' }],
    }), context);
    expect(policy).toEqual({ kind: 'allow' });
  });

  it('modifies a file when the baseline hash matches', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 42;' }],
    });
    expect(result.status).toBe('success');
    const output = result.output as ApplyPatchBatchOutput;
    expect(output.files[0].action).toBe('modified');
    expect(output.files[0].contentHash).not.toBe(sha256(MAIN_TS));
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 42;\nexport const label = "answer";\n',
    );
  });

  it('returns the new content hash so follow-up patches can chain', async () => {
    const first = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [{ startLine: 2, endLine: 2, replacement: 'export const label = "updated";' }],
    });
    expect(first.status).toBe('success');
    const second = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: (first.output as ApplyPatchBatchOutput).files[0].contentHash,
      edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
    });
    expect(second.status).toBe('success');
  });

  it('applies a batch patch to several files without approval', async () => {
    const requests: ToolApprovalRequest[] = [];
    const result = await runTool('apply_patch', {
      files: [
        {
          path: 'src/main.ts',
          baseContentHash: sha256(MAIN_TS),
          edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 42;' }],
        },
        { path: 'src/helper.ts', edits: [{ startLine: 1, endLine: 0, replacement: 'export const helper = true;' }] },
      ],
    }, { requestApproval: async (request) => { requests.push(request); return true; } });

    expect(result.status).toBe('success');
    expect(requests).toHaveLength(0);
    const output = result.output as ApplyPatchBatchOutput;
    expect(output.files.map((file) => file.path)).toEqual(['src/main.ts', 'src/helper.ts']);
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 42;\nexport const label = "answer";\n',
    );
    expect(readFileSync(join(workspaceRoot, 'src', 'helper.ts'), 'utf-8')).toBe('export const helper = true;');
  });

  it('rejects a batch atomically when one entry is stale', async () => {
    const result = await runTool('apply_patch', {
      files: [
        { path: 'src/helper.ts', edits: [{ startLine: 1, endLine: 0, replacement: 'export const helper = true;' }] },
        { path: 'src/main.ts', baseContentHash: sha256('outdated content'), edits: [{ startLine: 1, endLine: 1, replacement: 'tampered' }] },
      ],
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('stale-content');
    expect(existsSync(join(workspaceRoot, 'src', 'helper.ts'))).toBe(false);
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(MAIN_TS);
  });

  it('rejects duplicate paths and oversized batches', async () => {
    const duplicate = await runTool('apply_patch', {
      files: [
        { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 0, replacement: 'a' }] },
        { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 0, replacement: 'b' }] },
      ],
    });
    expect(duplicate.status).toBe('error');
    expect(duplicate.error?.code).toBe('invalid-input');

    const oversized = await runTool('apply_patch', {
      files: Array.from({ length: 9 }, (_, index) => ({
        path: `src/f${index}.ts`,
        edits: [{ startLine: 1, endLine: 0, replacement: 'x' }],
      })),
    });
    expect(oversized.status).toBe('error');
    expect(oversized.error?.code).toBe('invalid-input');
  });

  it('normalizes common model input mistakes in apply_patch', async () => {
    const singleObjectFiles = await runTool('apply_patch', {
      files: { path: 'src/extra.ts', edits: [{ startLine: 1, endLine: 0, replacement: 'export const extra = 1;' }] },
    });
    expect(singleObjectFiles.status).toBe('success');

    const clamped = await runTool('apply_patch', {
      path: 'src/extra.ts',
      baseContentHash: sha256('export const extra = 1;'),
      edits: [{ startLine: 1, endLine: 999, replacement: 'export const extra = 2;' }],
    });
    expect(clamped.status).toBe('success');

    const coerced = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: { startLine: '1', endLine: '1', replacement: 'export const answer = 43;' },
    });
    expect(coerced.status).toBe('success');

    const empty = await runTool('apply_patch', { path: 'src/main.ts', edits: [] });
    expect(empty.status).toBe('error');
    expect(empty.error?.code).toBe('invalid-input');
    expect(empty.error?.message).toContain('non-empty array');
  });

  it('records the pre-change state through the checkpoint hook before writing', async () => {
    const recorded: RecordedFileChange[] = [];
    const recordingContext: WorkspaceToolContext = {
      ...context,
      recordFileChange: (change) => recorded.push(change),
    };

    const modified = await executeAgentToolCall(buildCall('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 42;' }],
    }), recordingContext);
    expect(modified.status).toBe('success');

    const created = await executeAgentToolCall(buildCall('apply_patch', {
      path: 'src/helper.ts',
      edits: [{ startLine: 1, endLine: 0, replacement: 'export const helper = true;' }],
    }), recordingContext);
    expect(created.status).toBe('success');

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      relativePath: 'src/main.ts',
      previousAction: 'existed',
      previousContent: MAIN_TS,
      previousContentHash: sha256(MAIN_TS),
      newContentHash: sha256('export const answer = 42;\nexport const label = "answer";\n'),
    });
    expect(recorded[1]).toMatchObject({
      relativePath: 'src/helper.ts',
      previousAction: 'absent',
      previousContent: null,
      previousContentHash: '',
      newContentHash: sha256('export const helper = true;'),
    });
  });

  it('rejects a stale baseline without touching the file', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256('outdated content'),
      edits: [{ startLine: 1, endLine: 1, replacement: 'tampered' }],
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('stale-content');
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(MAIN_TS);
  });

  it('rejects overlapping edits', async () => {
    const result = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [
        { startLine: 1, endLine: 2, replacement: 'a' },
        { startLine: 2, endLine: 2, replacement: 'b' },
      ],
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid-input');
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(MAIN_TS);
  });

  it('blocks writes outside the workspace', async () => {
    const result = await runTool('apply_patch', {
      path: '../escape.ts',
      edits: [{ startLine: 1, endLine: 0, replacement: 'x' }],
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('outside-workspace');
  });

  it('blocks writes in a read-only workspace', async () => {
    context = { ...context, trustLevel: 'read-only' };
    const result = await runTool('apply_patch', {
      path: 'src/main.ts',
      baseContentHash: sha256(MAIN_TS),
      edits: [{ startLine: 1, endLine: 1, replacement: 'tampered' }],
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('read-only-workspace');
    expect(readFileSync(join(workspaceRoot, 'src', 'main.ts'), 'utf-8')).toBe(MAIN_TS);
  });
});

describe('command policy', () => {
  it('auto-allows read-only verification commands', () => {
    expect(classifyCommand('git', ['status'])).toBe('allow');
    expect(classifyCommand('git', ['diff', '--stat'])).toBe('allow');
    expect(classifyCommand('npm', ['test'])).toBe('allow');
    expect(classifyCommand('pnpm', ['run', 'typecheck'])).toBe('allow');
    expect(classifyCommand('pnpm', ['run', 'build'])).toBe('allow');
  });

  it('flags mutating or unknown commands as gated (the router auto-runs them in read-write workspaces)', () => {
    expect(classifyCommand('git', ['push'])).toBe('approval');
    expect(classifyCommand('git', ['reset', '--hard'])).toBe('approval');
    expect(classifyCommand('npm', ['install', 'lodash'])).toBe('approval');
    expect(classifyCommand('pnpm', ['run', 'deploy'])).toBe('approval');
    expect(classifyCommand('node', ['script.js'])).toBe('approval');
  });

  it('forbids destructive, network and shell executables even after approval', () => {
    expect(classifyCommand('rm', ['-rf', '.'])).toBe('forbidden');
    expect(classifyCommand('curl', ['https://example.com'])).toBe('forbidden');
    expect(classifyCommand('powershell', ['-Command', 'x'])).toBe('forbidden');
    expect(classifyCommand('sudo', ['anything'])).toBe('forbidden');
  });

  it('rejects path-like or shell-syntax command names', () => {
    expect(() => parseCommandInput({ command: './local.sh' })).toThrow();
    expect(() => parseCommandInput({ command: 'node -e "x"' })).toThrow();
    expect(() => parseCommandInput({ command: 'node', args: 'not-an-array' })).toThrow();
    expect(() => parseCommandInput({ command: 'node', args: ['a && b'] })).toThrow();
    expect(() => parseCommandInput({ command: 'node', args: ['x > out.txt'] })).toThrow();
  });

  it('denies forbidden commands through the router', async () => {
    const policy = classifyToolCall(buildCall('run_command', { command: 'rm', args: ['-rf', '.'] }), context);
    expect(policy).toMatchObject({ kind: 'deny', error: { code: 'forbidden-command' } });
    const result = await runTool('run_command', { command: 'rm', args: ['-rf', '.'] });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('forbidden-command');
  });
});

describe('run_command execution', () => {
  it('runs gated commands automatically without an approval hook', async () => {
    const result = await runTool('run_command', { command: 'node', args: ['--version'] });
    expect(result.status).toBe('success');
    const output = result.output as RunCommandOutput;
    expect(output.exitCode).toBe(0);
    expect(output.timedOut).toBe(false);
  });

  it('runs gated commands inside the workspace directory without asking', async () => {
    const approvals: Array<{ title: string }> = [];
    const result = await runTool(
      'run_command',
      { command: 'node', args: ['-e', 'console.log(process.cwd())'] },
      { requestApproval: async (request) => (approvals.push(request), true) },
    );
    expect(approvals).toHaveLength(0);
    expect(result.status).toBe('success');
    const output = result.output as RunCommandOutput;
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toBe(context.canonicalRootPath);
    expect(output.timedOut).toBe(false);
  });

  it('auto-runs allowlisted commands without asking for approval', async () => {
    let approvalRequests = 0;
    const result = await runTool(
      'run_command',
      { command: 'git', args: ['status'] },
      { requestApproval: async () => (approvalRequests += 1, true) },
    );
    expect(approvalRequests).toBe(0);
    expect(result.status).toBe('success');
    const output = result.output as RunCommandOutput;
    expect(output.command).toBe('git');
    expect(typeof output.exitCode).toBe('number');
  });

  it('kills the process when the timeout elapses', async () => {
    const result = await runTool(
      'run_command',
      { command: 'node', args: ['-e', 'setTimeout(function keepAlive() {}, 30000)'], timeoutMs: 300 },
    );
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
    const output = result.output as RunCommandOutput;
    expect(output.timedOut).toBe(true);
    expect(output.exitCode).toBeNull();
  }, 15_000);

  it('refuses write commands in a read-only workspace before any approval', async () => {
    context = { ...context, trustLevel: 'read-only' };
    let approvalRequests = 0;
    const result = await runTool(
      'run_command',
      { command: 'node', args: ['--version'] },
      { requestApproval: async () => (approvalRequests += 1, true) },
    );
    expect(approvalRequests).toBe(0);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('read-only-workspace');
  });
});
