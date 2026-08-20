/**
 * Reply classification for the agent loop.
 *
 * The loop feeds every assistant reply through `classifyReply`, which picks
 * exactly one category; the matching `STEER_RULES` entry then decides whether
 * to re-prompt or accept. Keeping priority in one function and limits in one
 * table means new detectors can no longer be shadowed by an earlier if/else
 * branch, and the order is pinned by unit tests.
 */

import type { WorkspaceTrustLevel } from '../shared/domain.js';
import {
  hasUnparsedToolFence,
  hasUnparsedXmlToolBlock,
  looksLikeManualCodeDump,
  looksLikeTruncatedToolCall,
  looksLikeUnfulfilledToolIntent,
  looksLikeUnverifiedCompletionClaim,
  type ParsedToolCall,
} from './agentLoop.js';

export type ReplyClassification =
  | { kind: 'tool-calls'; calls: ParsedToolCall[] }
  | { kind: 'truncated-tool' }
  | { kind: 'malformed-fence' }
  | { kind: 'unparsed-xml' }
  | { kind: 'empty-answer' }
  | { kind: 'code-dump' }
  | { kind: 'unfulfilled-intent' }
  | { kind: 'false-completion' }
  | { kind: 'answer' };

export type SteerKind = Exclude<ReplyClassification['kind'], 'tool-calls' | 'answer'>;

export interface ClassifyReplyInput {
  /** Raw assistant reply before stripping. */
  text: string;
  /** Tool calls already parsed from `text` (fenced JSON or XML dialects). */
  parsedCalls: ParsedToolCall[];
  /** User-visible remainder after tool fences/blocks were stripped. */
  answer: string;
  trustLevel: WorkspaceTrustLevel;
  /** apply_patch/run_command calls that succeeded earlier in this turn. */
  actingToolsExecuted: number;
}

/**
 * Single source of truth for steering priority. Order is behavior:
 * a reply never reaches a later check once an earlier one matches, so the
 * regression suite pins this exact sequence.
 */
export function classifyReply(input: ClassifyReplyInput): ReplyClassification {
  const { parsedCalls } = input;
  const steerKinds = steerKindsFor(input);
  if (steerKinds.length > 0) return { kind: steerKinds[0] };
  if (parsedCalls.length > 0) return { kind: 'tool-calls', calls: parsedCalls };
  return { kind: 'answer' };
}

/**
 * Every steering category this reply matches, in priority order. The loop uses
 * this to fall through to the next rule when a category's per-turn limit is
 * exhausted, exactly like the historical chained detectors did.
 */
export function steerKindsFor(input: ClassifyReplyInput): SteerKind[] {
  const { text, parsedCalls, answer, trustLevel, actingToolsExecuted } = input;
  const kinds: SteerKind[] = [];
  // A batch whose tail was cut by the output limit must not half-execute, so
  // truncation outranks even successfully parsed leading calls.
  if (looksLikeTruncatedToolCall(text)) kinds.push('truncated-tool');
  if (parsedCalls.length === 0) {
    if (hasUnparsedToolFence(text)) kinds.push('malformed-fence');
    if (hasUnparsedXmlToolBlock(text)) kinds.push('unparsed-xml');
    if (answer.length === 0) kinds.push('empty-answer');
    if (trustLevel !== 'read-only') {
      if (looksLikeManualCodeDump(answer)) kinds.push('code-dump');
      if (looksLikeUnfulfilledToolIntent(answer)) kinds.push('unfulfilled-intent');
      if (actingToolsExecuted === 0 && looksLikeUnverifiedCompletionClaim(answer)) {
        kinds.push('false-completion');
      }
    }
  }
  return kinds;
}

const CODE_DUMP_STEERING_MESSAGE = [
  'You pasted code blocks into the answer instead of applying them to the workspace.',
  'This workspace is read-write, so you must apply the changes yourself with apply_patch.',
  'If you have not read the target file yet, call read_file first; for a brand-new file use "baseContentHash": "" with a single insertion edit.',
  'Reply with ```tool calls now (a single apply_patch with a "files" array when several files change) and never paste replacement code into the answer.',
].join(' ');

const TRUNCATED_TOOL_STEERING_MESSAGE = [
  'Your previous reply was cut off by the output limit while a tool call was still open, so nothing ran.',
  'Resend the tool call now, but keep each reply small enough to finish: split big file rewrites into several apply_patch edits whose "replacement" is at most ~120 lines each, spreading the work over multiple replies if needed.',
  'Never paste replacement code into the answer.',
].join(' ');

const MALFORMED_TOOL_STEERING_MESSAGE = [
  'A ```tool block in your previous reply was not valid JSON, so it was ignored and nothing ran.',
  'Resend the call now as one strict-JSON ```tool block: close every { and [, quote every string, keep numbers unquoted, and keep each "replacement" at most ~120 lines.',
  'Never paste code into the answer.',
].join(' ');

const UNPARSED_XML_STEERING_MESSAGE = [
  'Your reply contained an XML tool block (such as <tool_calls>/<invoke>) that could not be parsed, so nothing happened.',
  'Resend the same call as a fenced JSON block exactly like: ```tool',
  '{"tool": "read_file", "input": {"path": "src/main.ts"}}',
  '```',
  'Never use XML tool syntax.',
].join(' ');

const EMPTY_ANSWER_STEERING_MESSAGE = [
  'Your reply was empty: it contained neither a visible answer nor a tool call, so nothing happened.',
  'Either act now with ```tool calls (apply_patch to finish the edits you planned, read_file when you need fresh content), or write the final answer for the user.',
  'Never end a turn silently.',
].join(' ');

const UNFULFILLED_INTENT_STEERING_MESSAGE = [
  'You announced reading or editing files but your reply contained no ```tool call, so nothing happened.',
  'Do not narrate—act: reply now with ```tool calls (read_file to inspect, apply_patch with a "files" array to change several files at once); call read_file first when you lack a fresh contentHash.',
  'Never paste replacement code into the answer.',
].join(' ');

const FALSE_COMPLETION_STEERING_MESSAGE = [
  'Your reply claims completed work ("fixed", "added", "build passed") but this turn executed no apply_patch and no run_command, so nothing changed and nothing was verified.',
  'Either apply the edits now with ```tool apply_patch calls (the harness verifies automatically after each write), or, if the change already exists from an earlier turn, confirm it with read_file/search_code evidence and say so explicitly.',
  'Never report unexecuted work as done.',
].join(' ');

export interface SteerRule {
  kind: SteerKind;
  /** How many times per turn this correction may fire before the reply is accepted. */
  limit: number;
  message: string;
}

/** Array order mirrors the classification priority; limits match the historical per-detector caps. */
export const STEER_RULES: readonly SteerRule[] = [
  { kind: 'truncated-tool', limit: 3, message: TRUNCATED_TOOL_STEERING_MESSAGE },
  { kind: 'malformed-fence', limit: 2, message: MALFORMED_TOOL_STEERING_MESSAGE },
  { kind: 'unparsed-xml', limit: 2, message: UNPARSED_XML_STEERING_MESSAGE },
  { kind: 'empty-answer', limit: 2, message: EMPTY_ANSWER_STEERING_MESSAGE },
  { kind: 'code-dump', limit: 2, message: CODE_DUMP_STEERING_MESSAGE },
  { kind: 'unfulfilled-intent', limit: 2, message: UNFULFILLED_INTENT_STEERING_MESSAGE },
  { kind: 'false-completion', limit: 2, message: FALSE_COMPLETION_STEERING_MESSAGE },
];
