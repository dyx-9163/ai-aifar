/**
 * Tool router: the single execution entry point for agent tool calls.
 *
 * Responsibilities:
 * - Route `AgentToolCall` to the registered executor for its tool name.
 * - Enforce the workspace trust policy: read-only tools run freely, and in
 *   read-write workspaces writes and commands execute automatically; only
 *   forbidden commands and read-only workspaces are denied outright.
 * - Normalize every failure into a structured `AgentToolResult`, so callers
 *   never receive raw exceptions or unclassified text.
 * - Measure and attach `durationMs` on every result.
 */

import type { FileChangePreview, WorkspaceTrustLevel } from '../../shared/domain.js';
import {
  agentToolApprovalRequiredResult,
  agentToolCancelledResult,
  agentToolErrorResult,
  agentToolSuccessResult,
  type AgentToolCall,
  type AgentToolError,
  type AgentToolName,
  type AgentToolResult,
} from '../../shared/toolProtocol.js';
import { toToolError } from './toolInput.js';
import { previewApplyPatch, runApplyPatch } from './applyPatch.js';
import { classifyCommand, parseCommandInput, runRunCommand } from './runCommand.js';
import { runGitDiff, runGitStatus } from './gitTools.js';
import { runGetCurrentDatetime } from './getCurrentDatetime.js';
import { runReadFile } from './readFile.js';
import { runSearchCode } from './searchCode.js';
import { runWorkspaceTree } from './workspaceTree.js';

export interface RecordedFileChange {
  /** Workspace-relative path using forward slashes. */
  relativePath: string;
  previousAction: 'existed' | 'absent';
  /** The file content before the change; null when the file did not exist. */
  previousContent: string | null;
  /** SHA-256 of the pre-change content; empty string when the file did not exist. */
  previousContentHash: string;
  /** SHA-256 of the content about to be written. */
  newContentHash: string;
}

export interface WorkspaceToolContext {
  canonicalRootPath: string;
  trustLevel: WorkspaceTrustLevel;
  /** Records the pre-change state so the turn can later be rolled back. */
  recordFileChange?: (change: RecordedFileChange) => void;
}

export interface ToolExecutionExtras {
  signal?: AbortSignal;
}

export type ToolExecutor = (
  input: Record<string, unknown>,
  context: WorkspaceToolContext,
  extras: ToolExecutionExtras,
) => Promise<{ output: unknown; truncated: boolean }>;

const TOOL_REGISTRY: Record<AgentToolName, ToolExecutor> = {
  get_current_datetime: runGetCurrentDatetime,
  workspace_tree: runWorkspaceTree,
  read_file: runReadFile,
  search_code: runSearchCode,
  git_status: runGitStatus,
  git_diff: runGitDiff,
  apply_patch: runApplyPatch,
  run_command: runRunCommand,
};

/** Tools executable without approval in any workspace. */
export const READ_ONLY_TOOL_NAMES: readonly AgentToolName[] = [
  'get_current_datetime',
  'workspace_tree',
  'read_file',
  'search_code',
  'git_status',
  'git_diff',
];

/** Tools that mutate the workspace or run processes; gated by trust level. */
export const WRITE_TOOL_NAMES: readonly AgentToolName[] = ['apply_patch', 'run_command'];

export interface ToolApprovalRequest {
  title: string;
  description: string;
  /** Computed diffs for file writes, so the user can review before approving. */
  fileChanges?: FileChangePreview[];
}

export type ToolPolicy =
  | { kind: 'allow' }
  | { kind: 'deny'; error: AgentToolError }
  | ({ kind: 'approval'; title: string; description: string } & Pick<ToolApprovalRequest, 'fileChanges'>);

/**
 * Decides whether a call may run, must be approved, or is rejected outright.
 * Pure and synchronous so tests and UI previews can reuse the same verdict.
 */
export function classifyToolCall(call: AgentToolCall, context: WorkspaceToolContext): ToolPolicy {
  if ((READ_ONLY_TOOL_NAMES as readonly string[]).includes(call.toolName)) {
    return { kind: 'allow' };
  }
  if (context.trustLevel === 'read-only') {
    return {
      kind: 'deny',
      error: {
        code: 'read-only-workspace',
        message: `This workspace is read-only; "${call.toolName}" requires read-write trust.`,
        retryable: false,
      },
    };
  }
  if (call.toolName === 'apply_patch') {
    try {
      // Validate the changeset up front so malformed input is denied, not executed.
      previewApplyPatch(call.input as Record<string, unknown>, context);
    } catch (error) {
      return { kind: 'deny', error: toToolError(error) };
    }
    return { kind: 'allow' };
  }
  if (call.toolName === 'run_command') {
    let parsed;
    try {
      parsed = parseCommandInput(call.input as Record<string, unknown>);
    } catch (error) {
      return { kind: 'deny', error: toToolError(error) };
    }
    const verdict = classifyCommand(parsed.command, parsed.args);
    if (verdict === 'forbidden') {
      return {
        kind: 'deny',
        error: {
          code: 'forbidden-command',
          message: `Command "${parsed.command}" is blocked by workspace policy.`,
          retryable: false,
        },
      };
    }
    return { kind: 'allow' };
  }
  return {
    kind: 'deny',
    error: { code: 'unknown-tool', message: `Unknown tool: ${call.toolName}`, retryable: false },
  };
}

export interface ToolExecutionOptions {
  now?: () => number;
  signal?: AbortSignal;
  /** Resolves user approval for gated calls; absent means approval blocks. */
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
}

export async function executeAgentToolCall(
  call: AgentToolCall,
  context: WorkspaceToolContext,
  options: ToolExecutionOptions = {},
): Promise<AgentToolResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const durationMs = () => Math.max(0, now() - startedAt);

  const executor = TOOL_REGISTRY[call.toolName];
  if (!executor) {
    return agentToolErrorResult(
      call.callId,
      { code: 'unknown-tool', message: `Unknown tool: ${call.toolName}`, retryable: false },
      durationMs(),
    );
  }
  if (call.input !== null && typeof call.input !== 'object') {
    return agentToolErrorResult(
      call.callId,
      { code: 'invalid-input', message: 'Tool input must be an object.', retryable: false },
      durationMs(),
    );
  }

  const policy = classifyToolCall(call, context);
  if (policy.kind === 'deny') {
    return agentToolErrorResult(call.callId, policy.error, durationMs());
  }
  if (policy.kind === 'approval') {
    if (!options.requestApproval) {
      return agentToolApprovalRequiredResult(call.callId, durationMs());
    }
    const approved = await options.requestApproval({
      title: policy.title,
      description: policy.description,
      ...(policy.fileChanges ? { fileChanges: policy.fileChanges } : {}),
    });
    if (!approved) {
      return agentToolCancelledResult(
        call.callId,
        { code: 'approval-rejected', message: 'The user rejected this operation.', retryable: false },
        durationMs(),
      );
    }
  }

  try {
    const { output, truncated } = await executor(
      call.input as Record<string, unknown>,
      context,
      options.signal ? { signal: options.signal } : {},
    );
    return agentToolSuccessResult(call.callId, output, durationMs(), truncated);
  } catch (error) {
    return agentToolErrorResult(call.callId, toToolError(error), durationMs());
  }
}

export { toToolError };
