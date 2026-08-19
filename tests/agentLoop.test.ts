import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelRunMetrics } from '../src/shared/domain';
import {
  buildAgentSystemPrompt,
  hasUnparsedToolFence,
  looksLikeManualCodeDump,
  looksLikeTruncatedToolCall,
  looksLikeUnfulfilledToolIntent,
  parseToolCall,
  parseToolCalls,
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

  it('parses DeepSeek DSML native tool calls including JSON parameters', () => {
    const dsml =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="path" string="true">src/style.css</｜DSML｜parameter>\n' +
      '<｜DSML｜parameter name="edits" string="false">[{"startLine": 1, "endLine": 0, "replacement": ".a { color: red; }"}]</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    expect(parseToolCall(dsml)).toEqual({
      tool: 'apply_patch',
      input: { path: 'src/style.css', edits: [{ startLine: 1, endLine: 0, replacement: '.a { color: red; }' }] },
    });
    expect(stripToolFences(dsml)).toBe('');
  });

  it('does not let a truncated DSML parameter swallow the next invoke', () => {
    const broken =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="files" string="false">[{"path": "src/App.vue", "edits": [{"replacement": "game\nLet me read the current state.\n' +
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n' +
      '<｜DSML｜parameter name="path" string="true">src/App.vue</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    expect(parseToolCalls(broken)).toEqual([{ tool: 'read_file', input: { path: 'src/App.vue' } }]);
    expect(looksLikeTruncatedToolCall(broken)).toBe(true);
  });

  it('repairs DSML JSON parameters with trailing commas or raw newlines', () => {
    const trailing =
      '<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="edits" string="false">[{"startLine": 1, "endLine": 0, "replacement": "x",},]</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>';
    expect(parseToolCall(trailing)).toEqual({
      tool: 'apply_patch',
      input: { edits: [{ startLine: 1, endLine: 0, replacement: 'x' }] },
    });
    const rawNewline =
      '<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="edits" string="false">[{"startLine": 1, "endLine": 0, "replacement": "a\nb"}]</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>';
    expect(parseToolCall(rawNewline)).toEqual({
      tool: 'apply_patch',
      input: { edits: [{ startLine: 1, endLine: 0, replacement: 'a\nb' }] },
    });
  });

  it('detects DSML tool calls cut off mid-parameter', () => {
    const truncated =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="files" string="false">[{"path": "src/App.vue", "edits": [{"startLine": 1,';
    expect(parseToolCall(truncated)).toBeUndefined();
    expect(looksLikeTruncatedToolCall(truncated)).toBe(true);
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
    expect(readWrite).toContain('This holds even for very large rewrites');
    expect(readWrite).toContain('split the work into several apply_patch edits');
  });

  it('detects manual code dumps by fenced block size', () => {
    expect(looksLikeManualCodeDump('Short snippet:\n```ts\nconst a = 1;\n```\nDone.')).toBe(false);
    expect(looksLikeManualCodeDump('No fences at all, just prose.')).toBe(false);
    const longFence = 'Replace manually:\n```vue\n' + Array.from({ length: 15 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```\n';
    expect(looksLikeManualCodeDump(longFence)).toBe(true);
  });

  it('detects tool calls cut off mid-fence by the output limit', () => {
    expect(looksLikeTruncatedToolCall(fencedToolCall('{"tool": "read_file", "input": {}}'))).toBe(false);
    expect(looksLikeTruncatedToolCall('plain answer without tools')).toBe(false);
    const truncated = 'Let me apply the rewrite.\n```tool\n{"tool": "apply_patch", "input": {"path": "src/App.vue", "edits": [';
    expect(looksLikeTruncatedToolCall(truncated)).toBe(true);
  });

  it('detects announced edits that contain no tool call', () => {
    expect(looksLikeUnfulfilledToolIntent('好的，现在用完整代码替换 `src/App.vue`，同时更新 `index.html`：')).toBe(true);
    expect(looksLikeUnfulfilledToolIntent('Okay, now replacing src/App.vue:')).toBe(true);
    expect(looksLikeUnfulfilledToolIntent('Let me first read the current state of both files:')).toBe(true);
    expect(looksLikeUnfulfilledToolIntent('让我先读取当前的代码文件，然后修复问题。')).toBe(true);
    expect(looksLikeUnfulfilledToolIntent('好的，让我先检查当前文件状态，然后一次性修复。')).toBe(true);
    expect(looksLikeUnfulfilledToolIntent('已更新 src/App.vue。')).toBe(false);
    expect(looksLikeUnfulfilledToolIntent('我已经修复了 CSS 截断问题。')).toBe(false);
    expect(looksLikeUnfulfilledToolIntent('Here is the plan:')).toBe(false);
    expect(looksLikeUnfulfilledToolIntent('The answer is 42.')).toBe(false);
  });

  it('parses tool calls emitted in ordinary code fences with the arguments alias', () => {
    const generic = '```json\n{"tool": "read_file", "arguments": {"path": "src/App.vue"}}\n```';
    expect(parseToolCall(generic)).toEqual({ tool: 'read_file', input: { path: 'src/App.vue' } });
    expect(stripToolFences(generic)).toBe('');
    const unknownTool = '```json\n{"tool": "restart_server", "arguments": {}}\n```';
    expect(parseToolCall(unknownTool)).toBeUndefined();
    expect(stripToolFences(unknownTool)).toContain('restart_server');
  });

  it('repairs fenced tool JSON with missing closers or trailing commas', () => {
    const missingCloser = parseToolCall('```tool\n{"tool": "read_file", "input": {"path": "a.ts"}\n```');
    expect(missingCloser?.tool).toBe('read_file');
    expect(missingCloser?.input).toEqual({ path: 'a.ts' });

    const trailingComma = parseToolCall('```tool\n{"tool": "read_file", "input": {"path": "a.ts",}}\n```');
    expect(trailingComma?.input).toEqual({ path: 'a.ts' });

    expect(hasUnparsedToolFence('```tool\n{"tool": "read_file", "input": @@@\n```')).toBe(true);
    expect(hasUnparsedToolFence('```tool\n{"tool": "read_file", "input": {"path": "a.ts"}}\n```')).toBe(false);
  });
});

describe('runAgentLoop', () => {
  it('answers directly when the model issues no tool call', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(['The file exports answer.'], context);
    expect(outcome).toMatchObject({ iterations: 1, toolCallsExecuted: 0 });
    expect(outcome.budgetExhausted).toBe(false);
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
    expect(outcome.budgetExhausted).toBe(true);
    const lastCall = modelCalls.at(-1);
    expect(String(lastCall?.at(-1)?.content)).toContain('Iteration budget exhausted');
    expect(String(lastCall?.at(-1)?.content)).toContain('never paste code blocks');
    expect(emitted.at(-1)).toEqual({ type: 'answer.delta', text: 'Budget exhausted answer.' });
  });

  it('re-prompts when the output limit cuts a tool call mid-fence', async () => {
    const truncated = 'Let me apply the rewrite.\n```tool\n{"tool": "read_file", "input": {"path": "src/main.ts"';
    const { emitted, outcome, modelCalls } = await runLoop(
      [
        truncated,
        fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}'),
        'It exports answer = 42.',
      ],
      context,
    );
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 1 });
    expect(String(modelCalls[1].at(-1)?.content)).toContain('cut off by the output limit');
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
  });

  it('re-prompts when a fenced tool call is not valid JSON even after repair', async () => {
    const { emitted, outcome, modelCalls } = await runLoop(
      [
        '```tool\n{"tool": "read_file", "input": @@@\n```',
        fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}'),
        'It exports answer = 42.',
      ],
      context,
    );
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 1 });
    expect(String(modelCalls[1].at(-1)?.content)).toContain('was not valid JSON');
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
  });

  it('steers announced-but-missing tool calls into real apply_patch calls', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const { emitted, outcome, modelCalls } = await runLoop(
      [
        '好的，现在用完整代码替换 `src/main.ts`：',
        fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}'),
        'Updated the file.',
      ],
      readWrite,
    );
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 1 });
    expect(String(modelCalls[1].at(-1)?.content)).toContain('contained no ```tool call');
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
  });

  it('emits announced edits untouched in read-only workspaces', async () => {
    const { emitted, outcome } = await runLoop(['Okay, now replacing src/main.ts:'], context);
    expect(outcome).toMatchObject({ iterations: 1, toolCallsExecuted: 0 });
    expect(emitted).toEqual([{ type: 'answer.delta', text: 'Okay, now replacing src/main.ts:' }]);
  });

  it('reports the last model run metrics', async () => {
    const { outcome } = await runLoop(
      [fencedToolCall('{"tool": "workspace_tree", "input": {}}'), 'done'],
      context,
    );
    expect(outcome.metrics?.durationMs).toBe(12);
  });

  it('applies patches automatically in a read-write workspace', async () => {
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
    expect(approvals).toEqual([]);
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 43;\n',
    );
    expect(String(modelCalls[1].at(-1)?.content)).toContain('"status": "success"');
  });

  it('executes every tool call of a multi-call reply in order', async () => {
    const { emitted, outcome } = await runLoop(
      [
        `${fencedToolCall('{"tool": "read_file", "input": {"path": "src/main.ts"}}')}\n${fencedToolCall('{"tool": "workspace_tree", "input": {}}')}`,
        'It exports answer = 42.',
      ],
      context,
    );
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 2 });
    expect(emitted.map((event) => event.type)).toEqual([
      'tool.started', 'tool.output', 'tool.started', 'tool.output', 'answer.delta',
    ]);
  });

  it('applies a batch apply_patch changeset without approval', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const baseHash = createHash('sha256').update('export const answer = 42;\n').digest('hex');
    const batchCall = JSON.stringify({
      tool: 'apply_patch',
      input: {
        files: [
          {
            path: 'src/main.ts',
            baseContentHash: baseHash,
            edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
          },
          {
            path: 'src/extra.ts',
            edits: [{ startLine: 1, endLine: 0, replacement: 'export const extra = true;' }],
          },
        ],
      },
    });
    const approvals: string[] = [];
    const { modelCalls } = await runLoop([fencedToolCall(batchCall), 'Updated both files.'], readWrite, {
      requestApproval: async (request) => {
        approvals.push(request.title);
        return true;
      },
    });
    expect(approvals).toEqual([]);
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 43;\n',
    );
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'extra.ts'), 'utf-8')).toBe(
      'export const extra = true;',
    );
    expect(String(modelCalls[1].at(-1)?.content)).toContain('"status": "success"');
  });

  it('steers manual code dumps back into apply_patch in read-write workspaces', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const dump = 'Let me give you the complete code, please replace src/main.ts manually:\n```ts\n' +
      Array.from({ length: 15 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n```\n';
    const baseHash = createHash('sha256').update('export const answer = 42;\n').digest('hex');
    const patchCall = JSON.stringify({
      tool: 'apply_patch',
      input: {
        path: 'src/main.ts',
        baseContentHash: baseHash,
        edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
      },
    });
    const { emitted, outcome, modelCalls } = await runLoop(
      [dump, fencedToolCall(patchCall), 'Updated the constant.'],
      readWrite,
      { requestApproval: async () => true },
    );
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 1 });
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('apply the changes yourself with apply_patch');
    expect(readFileSync(join(context.canonicalRootPath, 'src', 'main.ts'), 'utf-8')).toBe(
      'export const answer = 43;\n',
    );
  });

  it('emits code dumps untouched in read-only workspaces', async () => {
    const dump = '```ts\n' + Array.from({ length: 15 }, (_, i) => `const l${i} = ${i};`).join('\n') + '\n```';
    const { emitted, outcome, modelCalls } = await runLoop([dump], context);
    expect(outcome).toMatchObject({ iterations: 1, toolCallsExecuted: 0 });
    expect(modelCalls).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(String((emitted[0] as { text: string }).text)).toContain('const l0 = 0;');
  });

  it('gives up steering after two retries and emits the dump', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const dump = '```ts\n' + Array.from({ length: 15 }, (_, i) => `const l${i} = ${i};`).join('\n') + '\n```';
    const { emitted, outcome, modelCalls } = await runLoop([dump], readWrite);
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 0 });
    expect(modelCalls).toHaveLength(3);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('apply the changes yourself with apply_patch');
    expect(String(modelCalls[2].at(-1)?.content)).toContain('apply the changes yourself with apply_patch');
    const final = emitted.at(-1) as { type: string; text: string };
    expect(final.type).toBe('answer.delta');
    expect(final.text).toContain('const l0 = 0;');
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

  it('runs gated commands automatically in read-write workspaces', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const requests: string[] = [];
    const { modelCalls } = await runLoop(
      [
        fencedToolCall('{"tool": "run_command", "input": {"command": "node", "args": ["--version"]}}'),
        'Node is available.',
      ],
      readWrite,
      {
        requestApproval: async (request) => {
          requests.push(request.title);
          return false;
        },
      },
    );
    expect(requests).toEqual([]);
    const toolResult = String(modelCalls[1].at(-1)?.content);
    expect(toolResult).toContain('"status": "success"');
    expect(toolResult).toContain('"exitCode": 0');
  });

  it('appends a failing auto-verify report to apply_patch feedback', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    writeFileSync(
      join(context.canonicalRootPath, 'verify.js'),
      'console.error("src/main.ts(1,1): error TS2322: bad"); process.exit(2);\n',
    );
    writeFileSync(
      join(context.canonicalRootPath, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'node verify.js' } }),
    );
    const baseHash = createHash('sha256').update('export const answer = 42;\n').digest('hex');
    const patchCall = JSON.stringify({
      tool: 'apply_patch',
      input: {
        path: 'src/main.ts',
        baseContentHash: baseHash,
        edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
      },
    });
    const { emitted, modelCalls } = await runLoop([fencedToolCall(patchCall), 'Done.'], readWrite);
    const feedback = String(modelCalls[1].at(-1)?.content);
    expect(feedback).toContain('[auto-verify] npm run typecheck exited 2');
    expect(feedback).toContain('TS2322');
    const toolOutput = emitted.find((event) => event.type === 'tool.output') as { output: string };
    expect(toolOutput.output).toContain('[auto-verify]');
  }, 30_000);

  it('reports a passing auto-verify after apply_patch', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    writeFileSync(join(context.canonicalRootPath, 'verify.js'), 'console.log("ok");\n');
    writeFileSync(
      join(context.canonicalRootPath, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'node verify.js' } }),
    );
    const baseHash = createHash('sha256').update('export const answer = 42;\n').digest('hex');
    const patchCall = JSON.stringify({
      tool: 'apply_patch',
      input: {
        path: 'src/main.ts',
        baseContentHash: baseHash,
        edits: [{ startLine: 1, endLine: 1, replacement: 'export const answer = 43;' }],
      },
    });
    const { modelCalls } = await runLoop([fencedToolCall(patchCall), 'Done.'], readWrite);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('[auto-verify] npm run typecheck passed');
  }, 30_000);

  it('re-prompts the model when the visible answer is empty', async () => {
    const { emitted, modelCalls, outcome } = await runLoop(['', 'It exports answer = 42.'], context);
    expect(outcome).toMatchObject({ iterations: 2, emptyAnswer: false });
    expect(modelCalls).toHaveLength(2);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('Your reply was empty');
    const answers = emitted.filter((event) => event.type === 'answer.delta') as Array<{ text: string }>;
    expect(answers.map((event) => event.text)).toEqual(['It exports answer = 42.']);
  });

  it('reports emptyAnswer after two silent replies instead of completing silently', async () => {
    const { emitted, modelCalls, outcome } = await runLoop([''], context);
    expect(outcome).toMatchObject({ iterations: 3, toolCallsExecuted: 0, budgetExhausted: false, emptyAnswer: true });
    expect(modelCalls).toHaveLength(3);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('Never end a turn silently.');
    expect(emitted.filter((event) => event.type === 'answer.delta')).toEqual([]);
  });

  it('steers the model after four reads of the same path without a write', async () => {
    const readCall = '```tool\n{"tool": "read_file", "input": {"path": "src/main.ts"}}\n```';
    const { modelCalls, outcome } = await runLoop([readCall, readCall, readCall, readCall, 'Done.'], context);
    expect(outcome.toolCallsExecuted).toBe(4);
    expect(modelCalls[3].map((message) => message.content).join('\n')).not.toContain('[harness]');
    expect(modelCalls[4].map((message) => message.content).join('\n')).toContain('[harness] You have read "src/main.ts" 4 times');
  });

  it('steers instead of executing when a later tool call was truncated', async () => {
    const broken =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="apply_patch">\n' +
      '<｜DSML｜parameter name="files" string="false">[{"path": "src/App.vue", "edits": [{"replacement": "game\nLet me read on.\n' +
      '<｜DSML｜invoke name="read_file">\n' +
      '<｜DSML｜parameter name="path" string="true">src/App.vue</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    const { modelCalls, outcome } = await runLoop([broken, 'Done.'], context);
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 0 });
    expect(modelCalls[1].map((message) => message.content).join('\n')).toContain('cut off by the output limit');
  });

  it('executes DeepSeek DSML native tool calls', async () => {
    const dsml =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file">\n' +
      '<｜DSML｜parameter name="path" string="true">src/main.ts</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    const { emitted, outcome } = await runLoop([dsml, 'It exports answer = 42.'], context);
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 1 });
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
  });

  it('executes tool calls fenced as ordinary code blocks', async () => {
    const generic = '```json\n{"tool": "read_file", "arguments": {"path": "src/main.ts"}}\n```';
    const { emitted, outcome } = await runLoop([generic, 'It exports answer = 42.'], context);
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 1 });
    expect(emitted.map((event) => event.type)).toEqual(['tool.started', 'tool.output', 'answer.delta']);
  });

  it('steers period-terminated action promises back into tool calls', async () => {
    const readWrite = { ...context, trustLevel: 'read-write' as const };
    const { modelCalls, outcome } = await runLoop(
      ['好的，让我先检查当前文件状态，然后一次性修复。', 'It exports answer = 42.'],
      readWrite,
    );
    expect(outcome).toMatchObject({ iterations: 2, toolCallsExecuted: 0 });
    expect(modelCalls).toHaveLength(2);
    expect(String(modelCalls[1].at(-1)?.content)).toContain('You announced reading or editing files');
  });
});
