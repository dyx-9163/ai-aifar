/**
 * Unified agent tool protocol.
 *
 * Every tool invocation travels as an `AgentToolCall` and always answers with
 * an `AgentToolResult` whose `status` classifies the outcome. Tool executors
 * must never return unclassified free text: business failures, policy
 * rejections, cancellation and truncation are all explicit fields.
 */

export type AgentToolName =
  | 'workspace_tree'
  | 'read_file'
  | 'search_code'
  | 'apply_patch'
  | 'run_command';

export interface AgentToolCall<TInput = unknown> {
  callId: string;
  turnId: string;
  toolName: AgentToolName;
  input: TInput;
}

export type AgentToolResultStatus = 'success' | 'error' | 'cancelled' | 'approval-required';

export interface AgentToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AgentToolResult<TOutput = unknown> {
  callId: string;
  status: AgentToolResultStatus;
  output?: TOutput;
  error?: AgentToolError;
  truncated?: boolean;
  durationMs: number;
}

export function agentToolErrorResult(
  callId: string,
  error: AgentToolError,
  durationMs: number,
): AgentToolResult<never> {
  return { callId, status: 'error', error, durationMs };
}

export function agentToolCancelledResult(
  callId: string,
  error: AgentToolError,
  durationMs: number,
): AgentToolResult<never> {
  return { callId, status: 'cancelled', error, durationMs };
}

export function agentToolApprovalRequiredResult(callId: string, durationMs: number): AgentToolResult<never> {
  return { callId, status: 'approval-required', durationMs };
}

export function agentToolSuccessResult<TOutput>(
  callId: string,
  output: TOutput,
  durationMs: number,
  truncated = false,
): AgentToolResult<TOutput> {
  return {
    callId,
    status: 'success',
    output,
    durationMs,
    ...(truncated ? { truncated: true } : {}),
  };
}
