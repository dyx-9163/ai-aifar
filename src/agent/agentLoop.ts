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
import type { ChatMessage, ModelStreamHandlers, NativeStreamedToolCall } from './modelProvider.js';
import {
  hasUnparsedTextToolProtocol,
  hasUnparsedToolFence as adapterHasUnparsedToolFence,
  looksLikeTruncatedTextToolCall,
  parseTextToolCalls,
  stripTextToolProtocol,
  type NormalizedToolCall,
} from './providerAdapters/textToolCallAdapter.js';
import { classifyReply, steerKindsFor, STEER_RULES, type SteerKind } from './replyClassifier.js';
import {
  buildBaseAssistantSystemPrompt,
  runtimeContextSnapshot,
  type RuntimeContextSnapshot,
} from './runtimeContext.js';
import { buildNativeToolSchemas, type NativeToolSchema } from './tools/toolSchemas.js';
import {
  executeAgentToolCall,
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type ToolApprovalRequest,
  type WorkspaceToolContext,
} from './tools/toolRouter.js';

export const AGENT_LOOP_MAX_ITERATIONS = Number.POSITIVE_INFINITY;

const CODE_FENCE_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;
/** A fenced code block with at least this many non-empty lines counts as a manual code dump. */
const CODE_DUMP_MIN_LINES = 12;
/** How many times per turn the loop runs deterministic post-write verification. */
const MAX_AUTO_VERIFICATIONS = 3;
/** Reads of the same path without an intervening write that trigger a steering note. */
const MAX_REPEAT_READS = 4;
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES]);

export type AgentLoopEmit = (
  payload:
    | { type: 'answer.delta'; text: string }
    | { type: 'tool.started'; toolId: string; title: string }
    | { type: 'tool.output'; toolId: string; output: string; status: 'completed' | 'failed' }
    | { type: 'loop.classified'; kind: string; iteration: number },
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
    tools?: readonly NativeToolSchema[],
  ) => Promise<ModelRunMetrics>;
  emit: AgentLoopEmit;
  signal: AbortSignal;
  /** Caps tool round-trips per turn; omitted (the production default) is unlimited. */
  maxIterations?: number;
  /** Use provider-native function calling instead of the fenced-JSON text protocol. */
  nativeTools?: boolean;
  createCallId?: () => string;
  /** Stamped into every `AgentToolCall` for traceability. */
  turnId?: string;
  /** Pauses gated tool calls for user approval; absent means they block. */
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  /** Forwards reasoning/progress events live during every iteration. */
  reasoningHandlers?: Pick<ModelStreamHandlers, 'onRawReasoningDelta' | 'onReasoningSummaryDelta' | 'onPhase'>;
  /** One trusted time snapshot shared by every model iteration in this turn. */
  runtimeContext?: RuntimeContextSnapshot;
}

export interface AgentLoopOutcome {
  metrics?: ModelRunMetrics;
  iterations: number;
  toolCallsExecuted: number;
  /** True when the iteration budget ran out and the final answer was forced. */
  budgetExhausted: boolean;
  /** True when the loop ended on a visible-empty answer after steering retries. */
  emptyAnswer: boolean;
  /** True when the final answer claims work this turn never executed. */
  falseCompletion: boolean;
}

export type ParsedToolCall = NormalizedToolCall;

/** Extracts every tool call from assistant text: fenced JSON blocks first, then provider-native XML. */
export function parseToolCalls(text: string): ParsedToolCall[] {
  return parseTextToolCalls(text, KNOWN_TOOL_NAMES);
}

/** Extracts the first tool call from assistant text, if any. */
export function parseToolCall(text: string): ParsedToolCall | undefined {
  return parseToolCalls(text)[0];
}

/** True when the reply contains a fenced tool block that could not be parsed even after repair. */
export function hasUnparsedToolFence(text: string): boolean {
  return adapterHasUnparsedToolFence(text);
}

/** True when the reply carries XML tool syntax that no parser turned into a call (checked where parsedCalls is empty). */
export function hasUnparsedXmlToolBlock(text: string): boolean {
  return hasUnparsedTextToolProtocol(text);
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
  return looksLikeTruncatedTextToolCall(text);
}

const TOOL_INTENT_PATTERN = /(apply_patch|read_file|workspace_tree|替换|更新|修改|写入|创建|读取|查看|检查|修复|replac|updat|writ|creat|read|check|inspect|fix|repair)/i;
const FILE_PATH_PATTERN = /`[^`\n]*\.[A-Za-z0-9]+`|[\w./\\-]+\.(?:vue|tsx?|jsx?|html|css|json|md|py|go|rs)/;
/** First-person openers that promise an action about to happen ("let me ..."). */
const INTENT_PROMISE_PATTERN = /(让我|我来|我先|等我|接下来|现在我来?|let me|i'?ll|i will|going to)/i;
/** Action verbs that mark a read/fix promise even without a concrete file path. */
const PROMISE_VERB_PATTERN = /(read_file|读取|查看|检查|修复|修改|替换|写入|创建|\bread\b|check|inspect|fix|apply)/i;

/**
 * Detects replies that announce reading or editing files but contain no tool
 * call, so nothing happens. Covers both colon-terminated announcements and
 * first-person promises ("让我先读取…。") that end with ordinary punctuation.
 */
export function looksLikeUnfulfilledToolIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 800) return false;
  const announcedWithColon = /[:：]\s*$/.test(trimmed);
  if (!announcedWithColon && !INTENT_PROMISE_PATTERN.test(trimmed)) return false;
  if (!TOOL_INTENT_PATTERN.test(trimmed)) return false;
  return FILE_PATH_PATTERN.test(trimmed) || PROMISE_VERB_PATTERN.test(trimmed);
}

const COMPLETION_CLAIM_PATTERN =
  /(已修复|已修改|已添加|已移除|已删除|已更新|已创建|已加回|修改完成|修复完成|构建通过|构建成功|build (passed|succeeded|passes))/i;
/** English completion verbs are generic words too, so only count them when paired with a file path. */
const ENGLISH_CLAIM_VERB_PATTERN = /\b(fixed|repaired|added|removed|updated|created|modified)\b/i;

/** Detects past-tense "the work is done" claims that need at least one executed write or command. */
export function looksLikeUnverifiedCompletionClaim(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 1500) return false;
  if (COMPLETION_CLAIM_PATTERN.test(trimmed)) return true;
  return ENGLISH_CLAIM_VERB_PATTERN.test(trimmed) && FILE_PATH_PATTERN.test(trimmed);
}

/** Removes tool fences and XML tool-call blocks so intermediate text never reaches the answer stream. */
export function stripToolFences(text: string): string {
  return stripTextToolProtocol(text, KNOWN_TOOL_NAMES);
}

export function buildAgentSystemPrompt(
  workspaceDisplayName: string,
  trustLevel: WorkspaceTrustLevel = 'read-only',
  nativeTools = false,
  runtimeContext: RuntimeContextSnapshot = runtimeContextSnapshot(),
): string {
  const readOnly = trustLevel === 'read-only';
  const toolList = readOnly
    ? READ_ONLY_TOOL_NAMES.join(', ')
    : [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES].join(', ');
  const lines = [
    buildBaseAssistantSystemPrompt(runtimeContext),
    '',
    `The user has granted you ${readOnly ? 'read-only' : 'read-write'} access to the workspace "${workspaceDisplayName}".`,
    `You may inspect it with these tools: ${toolList}.`,
  ];
  if (nativeTools) {
    lines.push(
      'Invoke tools through native function calling; independent calls may share one reply,',
      'and the harness executes each call and returns its result.',
      'Tool inputs:',
    );
  } else {
    lines.push(
      'To call tools, reply with fenced JSON blocks; independent calls may share one reply:',
      '```tool',
      '{"tool": "read_file", "input": {"path": "src/main.ts"}}',
      '```',
      'Tool inputs:',
    );
  }
  lines.push(
    '- get_current_datetime: {} (trusted current date, time, time zone, locale and platform; never use a shell for this)',
    '- workspace_tree: {"path"?, "maxDepth"?, "maxEntries"?}',
    '- read_file: {"path", "startLine"?, "endLine"?}',
    '- search_code: {"query", "glob"?, "caseSensitive"?, "maxResults"?}',
    '- git_status: {} (working-tree state: branch, staged/unstaged/untracked entries)',
    '- git_diff: {"path"?, "staged"?} (unified diff of working tree or staged changes)',
  );
  if (!readOnly) {
    lines.push(
      '- apply_patch: {"path", "baseContentHash", "edits": [{"startLine", "endLine", "replacement"}]} or a batch {"files": [{...}, ...]} that changes several files in one atomic changeset,',
      '- run_command: {"command", "args"?, "timeoutMs"?}',
      'Write rules:',
      '- To create a brand-new file, call apply_patch with "baseContentHash": "" — any edit shape works for a missing file, the replacements become the file content; for example:',
      '  {"tool": "apply_patch", "input": {"path": "src/new.ts", "baseContentHash": "", "edits": [{"startLine": 1, "endLine": 0, "replacement": "file contents here"}]}}',
      '- For existing files, apply_patch requires the contentHash of a fresh read_file of the same file; re-read if it reports stale-content.',
      '- Edit lines are 1-based; "endLine": startLine - 1 inserts before "startLine".',
      '- run_command is only for finite build, test, and diagnostic work inside the workspace. Use the package manager declared by package.json/lockfiles; mismatches and long-running dev/start/serve/watch scripts are blocked.',
      '- After each successful apply_patch the harness automatically runs the project verification script (typecheck/check/build from package.json) and appends an [auto-verify] report to the tool result; when it reports errors, fix them with follow-up apply_patch edits before answering.',
      '- When several files change together, prefer one apply_patch with a "files" array so related files change together in a single changeset.',
      '- Keep every reply within the output limit: for large rewrites, split the work into several apply_patch edits with replacements of at most ~120 lines instead of one huge edit.',
      '- Promising changes is not acting: a reply that says it will read, replace, or update files but contains no ```tool call changes nothing; either issue the ```tool calls or answer directly.',
      '- Only report changes that apply_patch actually applied in this turn; completion claims without an executed write or command are rejected.',
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
  const nativeTools = options.nativeTools === true;
  const toolSchemas = nativeTools ? buildNativeToolSchemas(options.toolContext.trustLevel) : undefined;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildAgentSystemPrompt(
        options.workspaceDisplayName,
        options.toolContext.trustLevel,
        nativeTools,
        options.runtimeContext,
      ),
    },
    ...options.initialMessages,
  ];

  let iterations = 0;
  let toolCallsExecuted = 0;
  const steerCounters = new Map<SteerKind, number>();
  let actingToolsExecuted = 0;
  let autoVerificationsUsed = 0;
  const readCounts = new Map<string, number>();
  let lastMetrics: ModelRunMetrics | undefined;

  const runOnce = async (
    tools: readonly NativeToolSchema[] | undefined = toolSchemas,
  ): Promise<{ text: string; metrics: ModelRunMetrics; nativeCalls: NativeStreamedToolCall[] }> => {
    let buffered = '';
    const nativeCalls: NativeStreamedToolCall[] = [];
    const handlers: ModelStreamHandlers = {
      onAnswerDelta: (delta) => {
        buffered += delta;
      },
      onRawReasoningDelta: options.reasoningHandlers?.onRawReasoningDelta ?? (() => undefined),
      onReasoningSummaryDelta: options.reasoningHandlers?.onReasoningSummaryDelta ?? (() => undefined),
      onPhase: options.reasoningHandlers?.onPhase ?? (() => undefined),
      onNativeToolCalls: (calls) => {
        nativeCalls.push(...calls);
      },
    };
    const metrics = await options.runModel(options.profile, messages, handlers, options.signal, tools);
    throwIfAborted(options.signal);
    lastMetrics = metrics;
    return { text: buffered, metrics, nativeCalls };
  };

  const steerLimitFor = (kind: SteerKind): number =>
    STEER_RULES.find((rule) => rule.kind === kind)?.limit ?? 0;
  const steersUsed = (kind: SteerKind): number => steerCounters.get(kind) ?? 0;

  const executeToolCalls = async (
    calls: Array<{ callId: string; tool: string; input: Record<string, unknown> }>,
    deliverResult: (callId: string, feedback: string) => void,
  ): Promise<void> => {
    for (const parsed of calls) {
      const call: AgentToolCall = {
        callId: parsed.callId,
        turnId: options.turnId ?? '',
        toolName: parsed.tool as AgentToolCall['toolName'],
        input: parsed.input,
      };
      await options.emit({ type: 'tool.started', toolId: parsed.callId, title: parsed.tool });
      const result = await executeAgentToolCall(call, options.toolContext, {
        signal: options.signal,
        requestApproval: options.requestApproval,
      });
      throwIfAborted(options.signal);
      toolCallsExecuted += 1;
      let summary = summarizeToolResult(parsed.tool, result);
      let feedback = toolResultMessage(parsed.callId, result);
      if (parsed.tool === 'read_file' && result.status === 'success') {
        const readPath = typeof parsed.input.path === 'string' ? parsed.input.path : '';
        if (readPath) {
          const count = (readCounts.get(readPath) ?? 0) + 1;
          readCounts.set(readPath, count);
          if (count % MAX_REPEAT_READS === 0) {
            // Reading the same file over and over without writing burns the turn;
            // force the model to act on the context it already has.
            const note = `[harness] You have read "${readPath}" ${count} times without applying changes. Stop re-reading: apply the edits now with apply_patch (split large rewrites into ~120-line replacements), or answer with what you already know; use startLine/endLine only for a single missing range.`;
            summary = `${summary}\n${note}`;
            feedback = `${feedback}\n${note}`;
          }
        }
      }
      if (parsed.tool === 'apply_patch' && result.status === 'success') {
        readCounts.clear();
      }
      if ((parsed.tool === 'apply_patch' || parsed.tool === 'run_command') && result.status === 'success') {
        actingToolsExecuted += 1;
      }
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
      await options.emit({
        type: 'tool.output',
        toolId: parsed.callId,
        output: summary,
        status: result.status === 'success' ? 'completed' : 'failed',
      });
      deliverResult(parsed.callId, feedback);
    }
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const { text, nativeCalls } = await runOnce();

    if (nativeTools) {
      if (nativeCalls.length > 0) {
        await options.emit({ type: 'loop.classified', kind: 'tool-calls', iteration });
        messages.push({
          role: 'assistant',
          content: text,
          tool_calls: nativeCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
        await executeToolCalls(
          nativeCalls.map((call) => ({ callId: call.id, tool: call.name, input: call.arguments })),
          (callId, feedback) => {
            messages.push({ role: 'tool', tool_call_id: callId, content: feedback });
          },
        );
        continue;
      }
      // Some OpenAI-compatible and llama.cpp endpoints advertise native tool
      // support but occasionally serialize calls into assistant text. Keep the
      // native path first, then run the provider-adapter fallback before an
      // assistant message can be accepted as the final answer.
      const fallbackCalls = parseToolCalls(text);
      if (fallbackCalls.length > 0) {
        await options.emit({ type: 'loop.classified', kind: 'tool-calls', iteration });
        messages.push({ role: 'assistant', content: text });
        await executeToolCalls(
          fallbackCalls.map((call) => ({ callId: createCallId(), tool: call.tool, input: call.input })),
          (_callId, feedback) => {
            messages.push({ role: 'user', content: feedback });
          },
        );
        continue;
      }
      await options.emit({ type: 'loop.classified', kind: 'answer', iteration });
      const answer = stripToolFences(text);
      if (answer.length > 0) await options.emit({ type: 'answer.delta', text: answer });
      return {
        metrics: lastMetrics,
        iterations,
        toolCallsExecuted,
        budgetExhausted: false,
        emptyAnswer: answer.length === 0,
        falseCompletion: actingToolsExecuted === 0 && looksLikeUnverifiedCompletionClaim(answer),
      };
    }

    const parsedCalls = parseToolCalls(text);
    const answer = parsedCalls.length > 0 ? '' : stripToolFences(text);
    const classificationInput = {
      text,
      parsedCalls,
      answer,
      trustLevel: options.toolContext.trustLevel,
      actingToolsExecuted,
    };
    const classification = classifyReply(classificationInput);
    await options.emit({ type: 'loop.classified', kind: classification.kind, iteration });

    // Truncation outranks parsed calls, but once its steering budget is spent
    // salvage the complete parsed calls instead of looping forever.
    const truncatedBudgetSpent =
      classification.kind === 'truncated-tool' &&
      steersUsed('truncated-tool') >= steerLimitFor('truncated-tool');
    const hasExecutableCalls =
      classification.kind === 'tool-calls' || (truncatedBudgetSpent && parsedCalls.length > 0);

    if (!hasExecutableCalls) {
      const steerKind = steerKindsFor(classificationInput).find(
        (kind) => steersUsed(kind) < steerLimitFor(kind),
      );
      if (steerKind) {
        const rule = STEER_RULES.find((candidate) => candidate.kind === steerKind);
        steerCounters.set(steerKind, steersUsed(steerKind) + 1);
        messages.push({ role: 'assistant', content: text.length > 0 ? text : '(empty reply)' });
        messages.push({ role: 'user', content: rule?.message ?? 'Resend your reply.' });
        continue;
      }
      if (answer.length > 0) await options.emit({ type: 'answer.delta', text: answer });
      return {
        metrics: lastMetrics,
        iterations,
        toolCallsExecuted,
        budgetExhausted: false,
        emptyAnswer: answer.length === 0,
        falseCompletion: actingToolsExecuted === 0 && looksLikeUnverifiedCompletionClaim(answer),
      };
    }

    messages.push({ role: 'assistant', content: text });
    await executeToolCalls(
      parsedCalls.map((parsed) => ({ callId: createCallId(), tool: parsed.tool, input: parsed.input })),
      (_callId, feedback) => {
        messages.push({ role: 'user', content: feedback });
      },
    );
  }

  // Budget exhausted: force a closing answer that never falls back to pasted code.
  messages.push({
    role: 'user',
    content: 'Iteration budget exhausted. Write the final answer now: summarize what was changed and what remains; never paste code blocks or ask the user to copy code manually.',
  });
  const { text } = await runOnce(undefined);
  iterations += 1;
  const answer = stripToolFences(text);
  if (answer.length > 0) await options.emit({ type: 'answer.delta', text: answer });
  return { metrics: lastMetrics, iterations, toolCallsExecuted, budgetExhausted: true, emptyAnswer: false, falseCompletion: false };
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
