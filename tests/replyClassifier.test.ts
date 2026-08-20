import { describe, expect, it } from 'vitest';
import { parseToolCalls, stripToolFences } from '../src/agent/agentLoop';
import { classifyReply, steerKindsFor, STEER_RULES } from '../src/agent/replyClassifier';
import type { WorkspaceTrustLevel } from '../src/shared/domain';

// XML tool syntax is assembled via helpers so this test source never embeds
// raw protocol tags (which would trip harness parsers that scan tool output).
function xmlOpen(tag: string, attrs = ''): string {
  return `<${tag}${attrs}>`;
}

function xmlClose(tag: string): string {
  return '<' + `/${tag}>`;
}

function fenced(body: string): string {
  return `\`\`\`tool\n${body}\n\`\`\``;
}

interface ClassifyOptions {
  trustLevel?: WorkspaceTrustLevel;
  actingToolsExecuted?: number;
}

function classify(text: string, options: ClassifyOptions = {}) {
  return classifyReply({
    text,
    parsedCalls: parseToolCalls(text),
    answer: stripToolFences(text),
    trustLevel: options.trustLevel ?? 'read-write',
    actingToolsExecuted: options.actingToolsExecuted ?? 0,
  });
}

describe('classifyReply', () => {
  it('classifies replies with parseable tool calls as executable', () => {
    const classification = classify(fenced('{"tool": "read_file", "input": {"path": "src/main.ts"}}'));
    expect(classification.kind).toBe('tool-calls');
    if (classification.kind === 'tool-calls') {
      expect(classification.calls).toEqual([{ tool: 'read_file', input: { path: 'src/main.ts' } }]);
    }
  });

  it('classifies a cut-off fenced call as truncated-tool', () => {
    const classification = classify('\`\`\`tool\n{"tool": "apply_patch", "input": {"path": "src/app.vu');
    expect(classification.kind).toBe('truncated-tool');
  });

  it('classifies a complete parse plus an open second call as truncated-tool', () => {
    const text =
      `${fenced('{"tool": "read_file", "input": {"path": "src/main.ts"}}')}\n` +
      '\`\`\`tool\n{"tool": "apply_patch", "input": {"pa';
    expect(classify(text).kind).toBe('truncated-tool');
  });

  it('classifies an unparseable fenced block as malformed-fence', () => {
    const classification = classify('\`\`\`tool\n{tool: read_file not json at all\n\`\`\`');
    expect(classification.kind).toBe('malformed-fence');
  });

  it('classifies a closed-but-invalid XML block as unparsed-xml, not truncated-tool', () => {
    // Regression: this sample previously fell into the truncation detector
    // because the strict parser rejected the closed block, and steering order
    // sent the wrong correction message.
    const text = [
      xmlOpen('tool_calls'),
      xmlOpen('invoke'),
      `${xmlOpen('name')}read_file${xmlClose('name')}`,
      xmlClose('invoke'),
      xmlClose('tool_calls'),
    ].join('\n');
    expect(classify(text).kind).toBe('unparsed-xml');
  });

  it('classifies an empty reply as empty-answer', () => {
    expect(classify('').kind).toBe('empty-answer');
  });

  it('classifies a whitespace-only reply as empty-answer', () => {
    const classification = classify('   \n\t ');
    expect(classification.kind).toBe('empty-answer');
  });

  it('classifies a large pasted code block as code-dump in read-write workspaces', () => {
    const lines = Array.from({ length: 14 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const classification = classify(`Here is the file:\n\`\`\`ts\n${lines}\n\`\`\``);
    expect(classification.kind).toBe('code-dump');
  });

  it('classifies an announced edit without a tool call as unfulfilled-intent', () => {
    const classification = classify('让我先读取 `src/main.ts` 再修改。');
    expect(classification.kind).toBe('unfulfilled-intent');
  });

  it('classifies a completion claim without executed work as false-completion', () => {
    const classification = classify('已修复，构建通过。');
    expect(classification.kind).toBe('false-completion');
  });

  it('classifies a completion claim as a plain answer once work executed this turn', () => {
    const classification = classify('已修复，构建通过。', { actingToolsExecuted: 1 });
    expect(classification.kind).toBe('answer');
  });

  it('classifies ordinary text as answer', () => {
    expect(classify('It exports answer = 42.').kind).toBe('answer');
  });

  it('keeps behavioral steers inactive for read-only workspaces', () => {
    const dumpLines = Array.from({ length: 14 }, (_, index) => `const value${index} = ${index};`).join('\n');
    expect(classify(`Copy this:\n\`\`\`ts\n${dumpLines}\n\`\`\``, { trustLevel: 'read-only' }).kind).toBe('answer');
    expect(classify('让我先读取 `src/main.ts` 再修改。', { trustLevel: 'read-only' }).kind).toBe('answer');
    expect(classify('已修复，构建通过。', { trustLevel: 'read-only' }).kind).toBe('answer');
  });
});

describe('steerKindsFor', () => {
  function steerKinds(text: string, options: ClassifyOptions = {}) {
    return steerKindsFor({
      text,
      parsedCalls: parseToolCalls(text),
      answer: stripToolFences(text),
      trustLevel: options.trustLevel ?? 'read-write',
      actingToolsExecuted: options.actingToolsExecuted ?? 0,
    });
  }

  it('returns no steer kinds for plain answers or executable tool calls', () => {
    expect(steerKinds('It exports answer = 42.')).toEqual([]);
    expect(steerKinds(fenced('{"tool": "read_file", "input": {"path": "src/main.ts"}}'))).toEqual([]);
  });

  it('lists truncation ahead of executable calls so the loop can salvage after the limit', () => {
    const text =
      `${fenced('{"tool": "read_file", "input": {"path": "src/main.ts"}}')}\n` +
      '\`\`\`tool\n{"tool": "apply_patch", "input": {"pa';
    expect(steerKinds(text)).toEqual(['truncated-tool']);
  });

  it('keeps empty-answer available when a reply strips down to nothing', () => {
    expect(steerKinds('')).toEqual(['empty-answer']);
  });
});

describe('STEER_RULES', () => {
  it('covers every steerable classification kind exactly once', () => {
    const kinds = STEER_RULES.map((rule) => rule.kind);
    expect(kinds).toEqual([
      'truncated-tool',
      'malformed-fence',
      'unparsed-xml',
      'empty-answer',
      'code-dump',
      'unfulfilled-intent',
      'false-completion',
    ]);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('pins the existing steering limits', () => {
    const limits = Object.fromEntries(STEER_RULES.map((rule) => [rule.kind, rule.limit]));
    expect(limits).toEqual({
      'truncated-tool': 3,
      'malformed-fence': 2,
      'unparsed-xml': 2,
      'empty-answer': 2,
      'code-dump': 2,
      'unfulfilled-intent': 2,
      'false-completion': 2,
    });
  });

  it('carries a non-empty correction message per rule', () => {
    for (const rule of STEER_RULES) {
      expect(rule.message.length).toBeGreaterThan(20);
    }
  });
});
