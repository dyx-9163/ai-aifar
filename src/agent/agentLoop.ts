/**
 * Agent loop: multi-round "reason → tool → observe → reason" execution.
 *
 * The loop is model-agnostic: tool calls are exchanged as fenced JSON blocks
 * inside the assistant text, which works with any OpenAI-compatible chat
 * endpoint (including the local Qwen runtime) without function-calling
 * support. Intermediate iterations never leak into the user-visible answer
 * stream; only the final answer is emitted as `answer.delta`.
 */

import { randomUUID } from 'node:crypto';
import type { ModelRunMetrics, WorkspaceTrustLevel } from '../shared/domain.js';
import type { AgentToolCall, AgentToolResult } from '../shared/toolProtocol.js';
import { runAutoVerification } from './tools/autoVerify.js';
import type { RuntimeModelProfile } from './database.js';
import type { ChatMessage, ModelStreamHandlers } from './modelProvider.js';
import {
  executeAgentToolCall,
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type ToolApprovalRequest,
  type WorkspaceToolContext,
} from './tools/toolRouter.js';

export const AGENT_LOOP_MAX_ITERATIONS = 12;

const TOOL_FENCE_GLOBAL_PATTERN = /```tool\s*\n([\s\S]*?)```/g;
const CODE_FENCE_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;
/** A fenced code block with at least this many non-empty lines counts as a manual code dump. */
const CODE_DUMP_MIN_LINES = 12;
/** How many times the loop re-prompts the model instead of accepting a pasted-code answer. */
const MAX_CODE_DUMP_STEERS = 2;
/** How many times the loop re-prompts after a tool call was cut off by the output limit. */
const MAX_TRUNCATED_TOOL_STEERS = 3;
/** How many times the loop re-prompts when the model announces edits without issuing tool calls. */
const MAX_INTENT_STEERS = 2;
/** How many times the loop re-prompts when a fenced tool call was not valid JSON. */
const MAX_MALFORMED_TOOL_STEERS = 2;
/** How many times the loop re-prompts when the visible answer is empty. */
const MAX_EMPTY_ANSWER_STEERS = 2;
/** How many times per turn the loop runs deterministic post-write verification. */
const MAX_AUTO_VERIFICATIONS = 3;
const TOOL_INVOKE_GLOBAL_PATTERN = /<invoke\s+[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
const TOOL_PARAMETER_PATTERN = /<parameter\s+[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;

export type AgentLoopEmit = (
  payload:
    | { type: 'answer.delta'; text: string }
    | { type: 'tool.started'; toolId: string; title: string }
    | { type: 'tool.output'; toolId: string; output: string },
) => Promise<void> | void;

export interface AgentLoopOptions {
  profile: RuntimeModelProfile;
  toolContext: WorkspaceToolContext;
  workspaceDisplayName: string;
  /** Chat history without the system prompt; the loop owns the system prompt. */
  initialMessages: ChatMessage[];
  runModel: (
    profile: RuntimeModelProfile,
    messages: ChatMessage[],
    handlers: ModelStreamHandlers,
    signal: AbortSignal,
  ) => Promise<ModelRunMetrics>;
  emit: AgentLoopEmit;
  signal: AbortSignal;
  maxIterations?: number;
  createCallId?: () => string;
  /** Stamped into every `AgentToolCall` for traceability. */
  turnId?: string;
  /** Pauses gated tool calls for user approval; absent means they block. */
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  /** Forwards reasoning/progress events live during every iteration. */
  reasoningHandlers?: Pick<ModelStreamHandlers, 'onRawReasoningDelta' | 'onReasoningSummaryDelta' | 'onPhase'>;
}

export interface AgentLoopOutcome {
  metrics?: ModelRunMetrics;
  iterations: number;
  toolCallsExecuted: number;
  /** True when the iteration budget ran out and the final answer was forced. */
  budgetExhausted: boolean;
  /** True when the loop ended on a visible-empty answer after steering retries. */
  emptyAnswer: boolean;
}

export interface ParsedToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/** Extracts every tool call from assistant text: fenced JSON blocks first, then provider-native XML. */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const fenced: ParsedToolCall[] = [];
  for (const match of text.matchAll(TOOL_FENCE_GLOBAL_PATTERN)) {
    const parsed = match[1] ? parseFencedToolCall(match[1]) : undefined;
    if (parsed) fenced.push(parsed);
  }
  if (fenced.length > 0) return fenced;
  const xml: ParsedToolCall[] = [];
  for (const match of text.matchAll(TOOL_INVOKE_GLOBAL_PATTERN)) {
    const input: Record<string, unknown> = {};
    for (const parameter of match[2].matchAll(TOOL_PARAMETER_PATTERN)) {
      input[parameter[1]] = decodeToolParameter(parameter[2]);
    }
    xml.push({ tool: match[1], input });
  }
  return xml;
}

/** Extracts the first tool call from assistant text, if any. */
export function parseToolCall(text: string): ParsedToolCall | undefined {
  return parseToolCalls(text)[0];
}

/** True when the reply contains a fenced tool block that could not be parsed even after repair. */
export function hasUnparsedToolFence(text: string): boolean {
  for (const match of text.matchAll(TOOL_FENCE_GLOBAL_PATTERN)) {
    if (!match[1] || !parseFencedToolCall(match[1])) return true;
  }
  return false;
}

/** Closes unterminated strings and appends missing ]/} closers so truncated JSON can re-parse. */
function repairToolJson(body: string): string {
  let repaired = body.replace(/,(\s*[}\]])/g, '$1');
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of repaired) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') stack.pop();
  }
  if (inString) repaired += '"';
  return repaired + stack.reverse().join('');
}

function parseFencedToolCall(body: string): ParsedToolCall | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    // Models frequently drop closing braces or leave trailing commas when the
    // output limit bites; repair the shape before giving up on the call.
    try {
      parsed = JSON.parse(repairToolJson(body.trim()));
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const tool = typeof record.tool === 'string' ? record.tool : typeof record.name === 'string' ? record.name : undefined;
  if (!tool) return undefined;
  const rawInput = record.input ?? record.arguments ?? {};
  const input = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>)
    : {};
  return { tool, input };
}

/** Parameter values may be plain text or embedded JSON (numbers, arrays, objects). */
function decodeToolParameter(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Detects answers that paste whole code blocks ("here is the full file, replace it
 * manually") instead of applying changes through apply_patch. Tool fences are
 * stripped before this check, so only user-visible code fences are counted.
 */
export function looksLikeManualCodeDump(text: string): boolean {
  for (const match of text.matchAll(CODE_FENCE_PATTERN)) {
    const body = match[1] ?? '';
    const codeLines = body.split('\n').filter((line) => line.trim().length > 0).length;
    if (codeLines >= CODE_DUMP_MIN_LINES) return true;
  }
  return false;
}

/**
 * Detects replies whose tool call never closed (the output limit cut the fence or
 * XML block mid-way), which would otherwise be mistaken for a tool-free answer.
 */
export function looksLikeTruncatedToolCall(text: string): boolean {
  const withoutCompleteCalls = text
    .replace(/```tool\s*\n[\s\S]*?```/g, '')
    .replace(/<invoke\b[\s\S]*?<\/invoke>/g, '');
  return /```tool\b/.test(withoutCompleteCalls) || /<invoke\b/.test(withoutCompleteCalls);
}

const CODE_DUMP_STEERING_MESSAGE = [
  'You pasted code blocks into the answer instead of applying them to the workspace.',
  'This workspace is read-write, so you must apply the changes yourself with apply_patch.',
  'If you have not read the target file yet, call read_file first; for a brand-new file use "baseContentHash": "" with a single insertion edit.',
  'Reply with ```tool calls now (a single apply_patch with a "files" array when several files change) and never paste replacement code into the answer.',
].join(' ');

const TRUNCATED_TOOL_STEERING_MESSAGE = [
  'Your previous reply was cut off by the output limit while a ```tool call was still open, so no tool ran.',
  'Resend the tool call now, but keep each reply small enough to finish: split big file rewrites into several apply_patch edits whose "replacement" is at most ~120 lines each, spreading the work over multiple replies if needed.',
  'Never paste replacement code into the answer.',
].join(' ');

const TOOL_INTENT_PATTERN = /(apply_patch|read_file|workspace_tree|替换|更新|修改|写入|创建|读取|查看|replac|updat|writ|creat|read|check|inspect)/i;
const FILE_PATH_PATTERN = /`[^`\n]*\.[A-Za-z0-9]+`|[\w./\\-]+\.(?:vue|tsx?|jsx?|html|css|json|md|py|go|rs)/;

/**
 * Detects replies that announce reading or editing files (typically ending on a
 * colon before the missing tool call) but contain no tool call, so nothing happens.
 * Write announcements must mention a file path; read announcements are caught by
 * the colon + verb shape alone.
 */
export function looksLikeUnfulfilledToolIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 800) return false;
  if (!/[:：]\s*$/.test(trimmed)) return false;
  if (!TOOL_INTENT_PATTERN.test(trimmed)) return false;
  return FILE_PATH_PATTERN.test(trimmed) || /(read_file|读取|查看|\bread\b|check|inspect)/i.test(trimmed);
}

const UNFULFILLED_INTENT_STEERING_MESSAGE = [
  'You announced reading or editing files but your reply contained no ```tool call, so nothing happened.',
  'Do not narrate—act: reply now with ```tool calls (read_file to inspect, apply_patch with a "files" array to change several files at once); call read_file first when you lack a fresh contentHash.',
  'Never paste replacement code into the answer.',
].join(' ');

const MALFORMED_TOOL_STEERING_MESSAGE = [
  'A ```tool block in your previous reply was not valid JSON, so it was ignored and nothing ran.',
  'Resend the call now as one strict-JSON ```tool block: close every { and [, quote every string, keep numbers unquoted, and keep each "replacement" at most ~120 lines.',
  'Never paste code into the answer.',
].join(' ');

const EMPTY_ANSWER_STEERING_MESSAGE = [
  'Your reply was empty: it contained neither a visible answer nor a tool call, so nothing happened.',
  'Either act now with ```tool calls (apply_patch to finish the edits you planned, read_file when you need fresh content), or write the final answer for the user.',
  'Never end a turn silently.',
].join(' ');

/** Removes tool fences and XML tool-call blocks so intermediate text never reaches the answer stream. */
export function stripToolFences(text: string): string {
  return text
    .replace(/```tool\s*\n[\s\S]*?```/g, '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
    .replace(/<invoke\b[\s\S]*?<\/invoke>/g, '')
    .replace(/<parameter\b[\s\S]*?<\/parameter>/g, '')
    .replace(/<\/?(?:tool_calls|invoke|parameter)\b[^>]*>/g, '')
    .trim();
}

export function buildAgentSystemPrompt(
  workspaceDisplayName: string,
  trustLevel: WorkspaceTrustLevel = 'read-only',
): string {
  const readOnly = trustLevel === 'read-only';
  const toolList = readOnly
    ? READ_ONLY_TOOL_NAMES.join(', ')
    : [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES].join(', ');
  const lines = [
    'You are a helpful private AI assistant. Keep answers clear, practical, and concise.',
    '',
    `The user has granted you ${readOnly ? 'read-only' : 'read-write'} access to the workspace "${workspaceDisplayName}".`,
    `You may inspect it with these tools: ${toolList}.`,
    'To call tools, reply with fenced JSON blocks; independent calls may share one reply:',
    '```tool',
    '{"tool": "read_file", "input": {"path": "src/main.ts"}}',
    '```',
    'Tool inputs:',
    '- workspace_tree: {"path"?, "maxDepth"?, "maxEntries"?}',
    '- read_file: {"path", "startLine"?, "endLine"?}',
    '- search_code: {"query", "glob"?, "caseSensitive"?, "maxResults"?}',
    '- git_status: {} (working-tree state: branch, staged/unstaged/untracked entries)',
    '- git_diff: {"path"?, "staged"?} (unified diff of working tree or staged changes)',
  ];
  if (!readOnly) {
    lines.push(
      '- apply_patch: {"path", "baseContentHash", "edits": [{"startLine", "endLine", "replacement"}]} or a batch {"files": [{...}, ...]} that changes several files in one atomic changeset,',
      '- run_command: {"command", "args"?, "timeoutMs"?}',
      'Write rules:',
      '- To create a brand-new file, call apply_patch with "baseContentHash": "" and a single insertion edit, for example:',
      '  {"tool": "apply_patch", "input": {"path": "src/new.ts", "baseContentHash": "", "edits": [{"startLine": 1, "endLine": 0, "replacement": "file contents here"}]}}',
      '- For existing files, apply_patch requires the contentHash of a fresh read_file of the same file; re-read if it reports stale-content.',
      '- Edit lines are 1-based; "endLine": startLine - 1 inserts before "startLine".',
      '- run_command runs only inside the workspace directory; every command executes automatically in read-write workspaces except forbidden ones, which are blocked.',
      '- After each successful apply_patch the harness automatically runs the project verification script (typecheck/check/build from package.json) and appends an [auto-verify] report to the tool result; when it reports errors, fix them with follow-up apply_patch edits before answering.',
      '- When several files change together, prefer one apply_patch with a "files" array so related files change together in a single changeset.',
      '- Keep every reply within the output limit: for large rewrites, split the work into several apply_patch edits with replacements of at most ~120 lines instead of one huge edit.',
      '- Promising changes is not acting: a reply that says it will read, replace, or update files but contains no ```tool call changes nothing; either issue the ```tool calls or answer directly.',
      'Never paste full file contents or complete replacement code into the answer; apply changes with apply_patch instead.',
      'This holds even for very large rewrites: send the complete replacement text inside apply_patch edits; the answer must only describe what changed.',
    );
  }
  lines.push(
    'Rules: batch only independent tool calls in one reply; wait for the tool results before continuing;',
    'when you have enough information, answer directly without any tool block.',
    'If a tool call fails, read the error, fix the input (re-read the file when it reports stale-content), and retry; never tell the user to paste code manually.',
  );
  return lines.join('\n');
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopOutcome> {
  const maxIterations = Math.max(1, options.maxIterations ?? AGENT_LOOP_MAX_ITERATIONS);
  const createCallId = options.createCallId ?? (() => `call-${randomUUID()}`);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildAgentSystemPrompt(options.workspaceDisplayName, options.toolContext.trustLevel),
    },
    ...options.initialMessages,
  ];

  let iterations = 0;
  let toolCallsExecuted = 0;
  let codeDumpSteersUsed = 0;
  let truncatedToolSteersUsed = 0;
  let intentSteersUsed = 0;
  let malformedToolSteersUsed = 0;
  let emptyAnswerSteersUsed = 0;
  let autoVerificationsUsed = 0;
  let lastMetrics: ModelRunMetrics | undefined;

  const runOnce = async (): Promise<{ text: string; metrics: ModelRunMetrics }> => {
    let buffered = '';
    const handlers: ModelStreamHandlers = {
      onAnswerDelta: (delta) => {
        buffered += delta;
      },
      onRawReasoningDelta: options.reasoningHandlers?.onRawReasoningDelta ?? (() => undefined),
      onReasoningSummaryDelta: options.reasoningHandlers?.onReasoningSummaryDelta ?? (() => undefined),
      onPhase: options.reasoningHandlers?.onPhase ?? (() => undefined),
    };
    const metrics = await options.runModel(options.profile, messages, handlers, options.signal);
    throwIfAborted(options.signal);
    lastMetrics = metrics;
    return { text: buffered, metrics };
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const { text } = await runOnce();
    const parsedCalls = parseToolCalls(text);
    if (parsedCalls.length === 0) {
      const answer = stripToolFences(text);
      if (truncatedToolSteersUsed < MAX_TRUNCATED_TOOL_STEERS && looksLikeTruncatedToolCall(text)) {
        // The output limit cut the tool call mid-fence; ask for a smaller resend.
        truncatedToolSteersUsed += 1;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: TRUNCATED_TOOL_STEERING_MESSAGE });
        continue;
      }
      if (malformedToolSteersUsed < MAX_MALFORMED_TOOL_STEERS && hasUnparsedToolFence(text)) {
        // A fenced call survived neither raw parsing nor repair; ask for a strict resend.
        malformedToolSteersUsed += 1;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: MALFORMED_TOOL_STEERING_MESSAGE });
        continue;
      }
      if (answer.length === 0 && emptyAnswerSteersUsed < MAX_EMPTY_ANSWER_STEERS) {
        // Reasoning-heavy models can spend the whole reply on thinking and emit
        // nothing visible; force an act-or-answer decision instead of ending silent.
        emptyAnswerSteersUsed += 1;
        messages.push({ role: 'assistant', content: text.length > 0 ? text : '(empty reply)' });
        messages.push({ role: 'user', content: EMPTY_ANSWER_STEERING_MESSAGE });
        continue;
      }
      if (
        options.toolContext.trustLevel !== 'read-only' &&
        codeDumpSteersUsed < MAX_CODE_DUMP_STEERS &&
        looksLikeManualCodeDump(answer)
      ) {
        // The model dumped code for manual pasting; re-prompt it to use apply_patch.
        codeDumpSteersUsed += 1;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: CODE_DUMP_STEERING_MESSAGE });
        continue;
      }
      if (
        options.toolContext.trustLevel !== 'read-only' &&
        intentSteersUsed < MAX_INTENT_STEERS &&
        looksLikeUnfulfilledToolIntent(answer)
      ) {
        // The model narrated edits without issuing tool calls; force it to act.
        intentSteersUsed += 1;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: UNFULFILLED_INTENT_STEERING_MESSAGE });
        continue;
      }
      if (answer.length > 0) await options.emit({ type: 'answer.delta', text: answer });
      return { metrics: lastMetrics, iterations, toolCallsExecuted, budgetExhausted: false, emptyAnswer: answer.length === 0 };
    }

    messages.push({ role: 'assistant', content: text });
    for (const parsed of parsedCalls) {
      const callId = createCallId();
      const call: AgentToolCall = {
        callId,
        turnId: options.turnId ?? '',
        toolName: parsed.tool as AgentToolCall['toolName'],
        input: parsed.input,
      };
      await options.emit({ type: 'tool.started', toolId: callId, title: parsed.tool });
      const result = await executeAgentToolCall(call, options.toolContext, {
        signal: options.signal,
        requestApproval: options.requestApproval,
      });
      throwIfAborted(options.signal);
      toolCallsExecuted += 1;
      let summary = summarizeToolResult(parsed.tool, result);
      let feedback = toolResultMessage(callId, result);
      if (
        parsed.tool === 'apply_patch' &&
        result.status === 'success' &&
        options.toolContext.trustLevel !== 'read-only' &&
        autoVerificationsUsed < MAX_AUTO_VERIFICATIONS
      ) {
        // Deterministic safety net: build/typecheck the workspace right after a
        // write so compile errors reach the model inside the same turn.
        autoVerificationsUsed += 1;
        const report = await runAutoVerification(options.toolContext.canonicalRootPath, options.signal);
        if (report) {
          summary = `${summary}\n${report}`;
          feedback = `${feedback}\n${report}`;
        }
      }
      await options.emit({ type: 'tool.output', toolId: callId, output: summary });
      messages.push({ role: 'user', content: feedback });
    }
  }

  // Budget exhausted: force a closing answer that never falls back to pasted code.
  messages.push({
    role: 'user',
    content: 'Iteration budget exhausted. Write the final answer now: summarize what was changed and what remains; never paste code blocks or ask the user to copy code manually.',
  });
  const { text } = await runOnce();
  iterations += 1;
  const answer = stripToolFences(text);
  if (answer.length > 0) await options.emit({ type: 'answer.delta', text: answer });
  return { metrics: lastMetrics, iterations, toolCallsExecuted, budgetExhausted: true, emptyAnswer: false };
}

function toolResultMessage(callId: string, result: AgentToolResult): string {
  return [
    `Tool result for call "${callId}":`,
    JSON.stringify(
      {
        status: result.status,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      },
      null,
      2,
    ),
  ].join('\n');
}

function summarizeToolResult(toolName: string, result: AgentToolResult): string {
  if (result.status === 'success') {
    return `${toolName} completed in ${result.durationMs}ms${result.truncated ? ' (truncated)' : ''}`;
  }
  if (result.status === 'cancelled') {
    return `${toolName} was not executed: ${result.error?.message ?? 'the operation was cancelled'}`;
  }
  if (result.status === 'approval-required') {
    return `${toolName} was not executed: it requires user approval that is unavailable in this session.`;
  }
  return `${toolName} failed: ${result.error?.code ?? 'unknown'} — ${result.error?.message ?? 'no details'}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Turn was cancelled.', 'AbortError');
}
