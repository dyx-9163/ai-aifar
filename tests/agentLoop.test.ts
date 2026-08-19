import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelRunMetrics } from '../src/shared/domain';
import {
  buildAgentSystemPrompt,
  parseToolCall,
  runAgentLoop,
  stripToolFences,
} from '../src/agent/agentLoop';
import type { RuntimeModelProfile } from '../src/agent/database';
import type { ChatMessage } from '../src/agent/modelProvider';
import type { WorkspaceToolContext } from '../src/agent/tools/toolRouter';

const profile = {} as RuntimeModelProfile;

function metricsFor(run: number): ModelRunMetrics {
  return {
    durationMs: 10 + run,
    reasoningRequested: 'disabled',
    reasoningProtocol: 'none',
    reasoningObserved: false,
    speedSource: 'unavailable',
    usageSource: 'unavailable',
  };
}

function fencedToolCall(body: string): string {
  return `Let me check.\n\`\`\`tool\n${body}\n\`\`\``;
}

// Provider-native XML tool calls are assembled via helpers so the test source
// never embeds raw protocol tags.
function xmlOpen(tag: string, attrs = ''): string {
  return `<${tag}${attrs}>`;
}

function xmlClose(tag: string): string {
  return '<' + `/${tag}>`;
}

function xmlInvoke(tool: string, params: Array<[string, string]>): string {
  const renderedParams = params
    .map(([name, value]) => ` ${xmlOpen('parameter', ` name="${name}" string="true"`)}${value}${xmlClose('parameter')}`)
    .join('');
  return `${xmlOpen('tool_calls')} ${xmlOpen('invoke', ` name="${tool}"`)}${renderedParams} ${xmlClose('invoke')} ${xmlClose('tool_calls')}`;
}

interface LoopHarness {
  emitted: Array<{ type: string; [key: string]: unknown }>;
  modelCalls: ChatMessage[][];
  outcome: Awaited<ReturnType<typeof runAgentLoop>>;
}

async function runLoop(
  responses: string[],
  context: WorkspaceToolContext,
  options: {
    maxIterations?: number;
    requestApproval?: (request: { title: string; description: string }) => Promise<boolean>;
  } = {},
): Promise<LoopHarness> {
  const emitted: Array<{ type: string; [key: string]: unknown }> = [];
  const modelCalls: ChatMessage[][] = [];
  let run = 0;
  const outcome = await runAgentLoop({
    profile,
    toolContext: context,
    workspaceDisplayName: 'fixture',
    initialMessages: [{ role: 'user', content: 'What does src/main.ts export?' }],
    runModel: async (_modelProfile, messages, handlers) => {
      modelCalls.push([...messages]);
      const response = responses[Math.min(run, responses.length - 1)];
      run += 1;
      handlers.onAnswerDelta(response);
      return metricsFor(run);
    },
    emit: (payload) => {
      emitted.push(payload as { type: string });
    },
    signal: new AbortController().signal,
    maxIterations: options.maxIterations,
    requestApproval: options.requestApproval,
    createCallId: () => `call-${run + 1}`,
  });
  return { emitted, modelCalls, outcome };
}

let tempDirectories: string[] = [];
let context: WorkspaceToolContext = { canonicalRootPath: '', trustLevel: 'read-only' };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'private-ai-agentloop-'));
  tempDirectories.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
  context = { canonicalRootPath: realpathSync.native(root), trustLevel: 'read-only' };
});

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('tool call parsing', () => {
  it('parses a fenced tool block', () => {
    const parsed = parseToolCall(fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}'));
    expect(parsed).toEqual({ tool: 'read_file', input: { path: 'src/main.ts' } });
  });

  it('accepts name/arguments aliases', () => {
    const parsed = parseToolCall(fencedToolCall('{"name": "search_code", "arguments": {"query": "answer"}}'));
    expect(parsed).toEqual({ tool: 'search_code', input: { query: 'answer' } });
  });

  it('returns undefined for invalid JSON or missing fences', () => {
    expect(parseToolCall(fencedToolCall('{not json'))).toBeUndefined();
    expect(parseToolCall('plain answer without any fence')).toBeUndefined();
    expect(parseToolCall(fencedToolCall('["array"]'))).toBeUndefined();
  });

  it('strips tool fences from final text', () => {
    expect(stripToolFences(fencedToolCall('{"tool": "read_file", "input": {}}'))).toBe('Let me check.');
  });

  it('parses provider-native XML tool calls', () => {
    expect(parseToolCall(xmlInvoke('read_file', [['path', 'src/App.vue']]))).toEqual({
      tool: 'read_file',
      input: { path: 'src/App.vue' },
    });
    const stray = `${xmlInvoke('read_file', [['path', 'src/App.vue']])} ${xmlClose('invoke')}`;
    expect(parseToolCall(stray)).toEqual({ tool: 'read_file', input: { path: 'src/App.vue' } });
  });

  it('decodes JSON-valued XML parameters', () => {
    const call =
      `${xmlOpen('invoke', ' name="read_file"')} ${xmlOpen('parameter', ' name="path"')}"src/main.ts"${xmlClose('parameter')}` +
      ` ${xmlOpen('parameter', ' name="startLine"')}2${xmlClose('parameter')} ${xmlClose('invoke')}`;
    expect(parseToolCall(call)).toEqual({ tool: 'read_file', input: { path: 'src/main.ts', startLine: 2 } });
  });

  it('strips XML tool call blocks from final text', () => {
    expect(stripToolFences(`Done. ${xmlInvoke('read_file', [['path', 'src/App.vue']])}`)).toBe('Done.');
    const stray = `${xmlInvoke('read_file', [['path', 'src/App.vue']])} ${xmlClose('invoke')}`;
    expect(stripToolFences(`Note. ${stray}`)).toBe('Note.');
  });

  it('describes the workspace in the system prompt', () => {
    const prompt = buildAgentSystemPrompt('my-project');
    expect(prompt).toContain('my-project');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('never tell the user to paste code manually');
  });

  it('only offers write tools when the workspace is read-write', () => {
    const readOnly = buildAgentSystemPrompt('my-project', 'read-only');
    expect(readOnly).not.toContain('apply_patch');
    expect(readOnly).not.toContain('run_command');
    const readWrite = buildAgentSystemPrompt('my-project', 'read-write');
    expect(readWrite).toContain('apply_patch');
    expect(readWrite).toContain('run_command');
    expect(readWrite).toContain('read-write');
    expect(readWrite).toContain('Never paste full file contents or complete replacement code into the answer');
  });
});

describe('runAgentLoop', () => {
  it('answers directly when the model issues no tool call', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(['The file exports answer.'], context);
    expect(outcome).toMatchObject({ iterations: 1, toolCallsExecuted: 0 });
    expect(emitted).toEqual([{ type: 'answer.delta', text: 'The file exports answer.' }]);
    expect(modelCalls[0][0]).toEqual({ role: 'system', content: expect.stringContaining('fixture') });
  });

  it('executes a tool call and feeds the result back before the final answer', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}'),
        'It exports the constant answer = 42.',
      ],
      context,
    );
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 1 });
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
    const started = emitted[0] as unknown as { toolId: string; title: string };
    expect(started.title).toBe('read_file');
    const output = emitted[1] as unknown as { output: string };
    expect(output.output).toContain('read_file completed');
    const final = emitted[2] as unknown as { text: string };
    expect(final.text).not.toContain('```tool');

    const followUp = modelCalls[1];
    expect(followUp.at(-2)).toEqual({ role: 'assistant', content: expect.stringContaining('read_file') });
    expect(String(followUp.at(-1)?.content)).toContain('"status": "success"');
    expect(String(followUp.at(-1)?.content)).toContain('answer = 42');
  });

  it('executes provider-native XML tool calls', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(
      [xmlInvoke('read_file', [['path', 'src/main.ts']]), 'It exports the constant answer = 42.'],
      context,
    );
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 1 });
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
    const started = emitted[0] as unknown as { title: string };
    expect(started.title).toBe('read_file');
    expect(String(modelCalls[1].at(-1)?.content)).toContain('answer = 42');
  });

  it('feeds structured tool errors back to the model', async () => {
    const { emitted, modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "read_file", "input": {"path": "../../../etc/passwd"}}'),
        'Sorry, that path is outside the workspace.',
      ],
      context,
    );
    const output = emitted[1] as unknown as { output: string };
    expect(output.output).toContain('outside-workspace');
    expect(String(modelCalls[1].at(-1)?.content)).toContain('"status": "error"');
  });

  it('stops after the iteration budget and forces a direct answer', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "workspace_tree", "input": {}}'),
        fencedToolCall('{"tool": "workspace_tree", "input": {}}'),
        'Budget exhausted answer.',
      ],
      context,
      { maxIterations: 2 },
    );
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 2 });
    const lastCall = modelCalls.at(-1);
    expect(String(lastCall?.at(-1)?.content)).toContain('Iteration budget exhausted');
    expect(emitted.at(-1)).toEqual({ type: 'answer.delta', text: 'Budget exhausted answer.' });
  });

  it('reports the last model run metrics', async () => {
    const { outcome } = await runLoop(
      [fencedToolCall('{"tool": "workspace_tree", "input": {}}'), 'done'],
      context,
    );
    expect(outcome.metrics?.durationMs).toBe(12);
  });

  it('applies patches in a read-write workspace after approval', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const baseHash = createHash('sha256').update('export const answer = 42;\n').digest('hex');
    const patchCall = JSON.stringify({
      tool: 'apply_patch',
      input: {
        path: 'src/main.ts',
        baseContentHash: baseHash,
        edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
      },
    });
    const approvals: string[] = [];
    const { modelCalls } = await runLoop([fencedToolCall(patchCall), 'Updated the constant.'], readWrite, {
      requestApproval: async (request) => {
        approvals.push(request.title);
        return true;
      },
    });
    expect(approvals).toEqual(['Edit file: src/main.ts']);
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 43;\n',
    );
    expect(String(modelCalls[1].at(-1)?.content)).toContain('"status": "success"');
  });

  it('refuses write tools in a read-only workspace and feeds the error back', async () => {
    const patchCall = JSON.stringify({
      tool: 'apply_patch',
      input: { path: 'src/main.ts', edits: [{ startLine: 1, endLine: 1, replacement: 'x' }] },
    });
    const { emitted, modelCalls } = await runLoop([fencedToolCall(patchCall), 'Cannot write.'], context);
    const output = emitted[1] as unknown as { output: string };
    expect(output.output).toContain('failed: read-only-workspace');
    expect(String(modelCalls[1].at(-1)?.content)).toContain('read-only-workspace');
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 42;\n',
    );
  });

  it('pauses gated commands for approval and reports rejection to the model', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const requests: string[] = [];
    const { emitted, modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "run_command", "input": {"command": "node", "args": ["--version"]}}'),
        'Understood, skipping the check.',
      ],
      readWrite,
      {
        requestApproval: async (request) => {
          requests.push(request.title);
          return false;
        },
      },
    );
    expect(requests).toEqual(['Run command: node']);
    const output = emitted[1] as unknown as { output: string };
    expect(output.output).toContain('was not executed');
    expect(String(modelCalls[1].at(-1)?.content)).toContain('"status": "cancelled"');
  });

  it('runs gated commands after the user approves', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const { modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "run_command", "input": {"command": "node", "args": ["--version"]}}'),
        'Node is available.',
      ],
      readWrite,
      { requestApproval: async () => true },
    );
    const toolResult = String(modelCalls[1].at(-1)?.content);
    expect(toolResult).toContain('"status": "success"');
    expect(toolResult).toContain('"exitCode": 0');
  });
});
