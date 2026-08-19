import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolCall } from '../src/shared/toolProtocol';
import {
  executeAgentToolCall,
  type WorkspaceToolContext,
} from '../src/agent/tools/toolRouter';
import type { ReadFileOutput } from '../src/agent/tools/readFile';
import type { SearchCodeOutput } from '../src/agent/tools/searchCode';
import type { WorkspaceTreeOutput } from '../src/agent/tools/workspaceTree';

let tempDirectories: string[] = [];
let workspaceRoot = '';
let context: WorkspaceToolContext = { canonicalRootPath: '', trustLevel: 'read-only' };

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-tools-'));
  tempDirectories.push(directory);
  return directory;
}

function buildCall(toolName: string, input: unknown): AgentToolCall {
  return {
    callId: 'call-1',
    turnId: 'turn-1',
    toolName: toolName as AgentToolCall['toolName'],
    input,
  };
}

async function runTool(toolName: string, input: unknown) {
  return executeAgentToolCall(buildCall(toolName, input), context);
}

beforeEach(() => {
  workspaceRoot = createTempDir();
  mkdirSync(join(workspaceRoot, 'src', 'components'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'main.ts'), 'export const answer = 42;\nconsole.log(answer);\n');
  writeFileSync(join(workspaceRoot, 'src', 'components', 'Button.tsx'), 'export function Button() {\n  return answer;\n}\n');
  writeFileSync(join(workspaceRoot, '.env'), 'SECRET_TOKEN=answer-secret\n');
  writeFileSync(join(workspaceRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = "answer hidden";\n');
  writeFileSync(join(workspaceRoot, 'README.md'), '# answer docs\n');
  writeFileSync(join(workspaceRoot, 'assets.bin'), Buffer.from([0x00, 0xff, 0x10, 0x42]));
  context = { canonicalRootPath: realpathSync.native(workspaceRoot), trustLevel: 'read-only' };
});

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('workspace_tree tool', () => {
  it('lists entries recursively and marks excluded paths as ignored', async () => {
    const result = await runTool('workspace_tree', {});
    expect(result.status).toBe('success');
    const output = result.output as WorkspaceTreeOutput;
    const paths = output.entries.map((entry) => entry.path);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/components/Button.tsx');
    expect(paths).toContain('node_modules');
    expect(paths).not.toContain('node_modules/pkg/index.js');

    const envEntry = output.entries.find((entry) => entry.path === '.env');
    expect(envEntry?.ignored).toBe(true);
    const nodeModules = output.entries.find((entry) => entry.path === 'node_modules');
    expect(nodeModules?.ignored).toBe(true);
  });

  it('truncates when maxEntries is exceeded', async () => {
    const result = await runTool('workspace_tree', { maxEntries: 2 });
    expect(result.status).toBe('success');
    expect(result.truncated).toBe(true);
    expect((result.output as WorkspaceTreeOutput).entries.length).toBe(2);
  });

  it('respects maxDepth', async () => {
    const result = await runTool('workspace_tree', { maxDepth: 1 });
    const output = result.output as WorkspaceTreeOutput;
    expect(output.entries.some((entry) => entry.path === 'src')).toBe(true);
    expect(output.entries.some((entry) => entry.path === 'src/main.ts')).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('rejects paths escaping the workspace root', async () => {
    const result = await runTool('workspace_tree', { path: '../../..' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('outside-workspace');
    expect(result.error?.retryable).toBe(false);
  });

  it('rejects a file path as not-a-directory', async () => {
    const result = await runTool('workspace_tree', { path: 'src/main.ts' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('not-a-directory');
  });
});

describe('read_file tool', () => {
  it('reads a file with line numbers and a stable content hash', async () => {
    const first = await runTool('read_file', { path: 'src/main.ts' });
    expect(first.status).toBe('success');
    const output = first.output as ReadFileOutput;
    expect(output.path).toBe('src/main.ts');
    expect(output.content).toContain('1| export const answer = 42;');
    expect(output.totalLines).toBeGreaterThanOrEqual(2);
    expect(output.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const second = await runTool('read_file', { path: './src/main.ts' });
    expect((second.output as ReadFileOutput).contentHash).toBe(output.contentHash);
  });

  it('supports line ranges', async () => {
    const result = await runTool('read_file', { path: 'src/main.ts', startLine: 2, endLine: 2 });
    const output = result.output as ReadFileOutput;
    expect(output.startLine).toBe(2);
    expect(output.endLine).toBe(2);
    expect(output.content).toBe('2| console.log(answer);');
  });

  it('rejects excluded paths', async () => {
    const result = await runTool('read_file', { path: '.env' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('excluded-path');
  });

  it('rejects binary files', async () => {
    const result = await runTool('read_file', { path: 'assets.bin' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('binary-file');
  });

  it('rejects paths escaping the workspace root', async () => {
    const result = await runTool('read_file', { path: '../../../etc/passwd' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('outside-workspace');
  });

  it('rejects missing required input', async () => {
    const result = await runTool('read_file', {});
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid-input');
  });
});

describe('search_code tool', () => {
  it('finds matches with file, line and snippet, skipping excluded files', async () => {
    const result = await runTool('search_code', { query: 'answer' });
    expect(result.status).toBe('success');
    const output = result.output as SearchCodeOutput;
    const files = output.matches.map((match) => match.file);
    expect(files).toContain('src/main.ts');
    expect(files).toContain('README.md');
    expect(files).not.toContain('node_modules/pkg/index.js');
    expect(files).not.toContain('.env');

    const first = output.matches.find((match) => match.file === 'src/main.ts');
    expect(first?.line).toBe(1);
    expect(first?.snippet).toContain('answer');
  });

  it('filters with a glob pattern', async () => {
    const result = await runTool('search_code', { query: 'answer', glob: '*.tsx' });
    const output = result.output as SearchCodeOutput;
    expect(output.matches.length).toBeGreaterThan(0);
    expect(output.matches.every((match) => match.file.endsWith('.tsx'))).toBe(true);
  });

  it('degrades invalid regex input to literal matching', async () => {
    const result = await runTool('search_code', { query: '[unclosed' });
    expect(result.status).toBe('success');
    expect((result.output as SearchCodeOutput).matches.length).toBe(0);
  });

  it('truncates results at maxResults', async () => {
    const result = await runTool('search_code', { query: 'answer', maxResults: 1 });
    expect(result.truncated).toBe(true);
    expect((result.output as SearchCodeOutput).matches.length).toBe(1);
  });
});

describe('tool router', () => {
  it('rejects unknown tool names with a structured error', async () => {
    const result = await runTool('delete_file', {});
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('unknown-tool');
    expect(result.callId).toBe('call-1');
  });

  it('rejects non-object input with invalid-input', async () => {
    const result = await runTool('workspace_tree', 'not-an-object');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid-input');
  });

  it('attaches measured durationMs', async () => {
    let clock = 1000;
    const result = await executeAgentToolCall(buildCall('workspace_tree', {}), context, {
      now: () => {
        clock += 17;
        return clock;
      },
    });
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
