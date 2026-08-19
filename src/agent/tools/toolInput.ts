/**
 * Tool input validation helpers.
 *
 * Model-supplied tool inputs are untrusted. Every field is validated here and
 * failures surface as structured `invalid-input` errors instead of raw
 * exceptions leaking into the tool result channel.
 */

import type { AgentToolError } from '../../shared/toolProtocol.js';
import { WorkspaceSecurityError } from '../workspace/pathSecurity.js';

export class ToolInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolInputError';
    this.code = code;
  }
}

export function toolInputError(code: string, message: string): ToolInputError {
  return new ToolInputError(code, message);
}

interface ToolStringOptions {
  optional?: boolean;
  emptyAsUndefined?: boolean;
}

export function requireToolString(input: Record<string, unknown>, key: string): string;
export function requireToolString(
  input: Record<string, unknown>,
  key: string,
  options: ToolStringOptions & { optional: true },
): string | undefined;
export function requireToolString(
  input: Record<string, unknown>,
  key: string,
  options?: ToolStringOptions,
): string | undefined;
export function requireToolString(
  input: Record<string, unknown>,
  key: string,
  options: ToolStringOptions = {},
): string | undefined {
  const value = input[key];
  if (value === undefined || (options.emptyAsUndefined && value === '')) {
    if (options.optional) return undefined;
    throw toolInputError('invalid-input', `Tool input "${key}" is required.`);
  }
  if (typeof value !== 'string') {
    throw toolInputError('invalid-input', `Tool input "${key}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 && !options.optional) {
    throw toolInputError('invalid-input', `Tool input "${key}" must not be empty.`);
  }
  return trimmed;
}

export function toToolInteger(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw toolInputError('invalid-input', `Tool input "${key}" must be an integer.`);
  }
  return Math.min(max, Math.max(min, value));
}

export function toToolBoolean(
  input: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw toolInputError('invalid-input', `Tool input "${key}" must be a boolean.`);
  }
  return value;
}

/** Maps path security rejections into tool error codes without losing detail. */
export function securityErrorCode(error: WorkspaceSecurityError): string {
  return error.code;
}

/** Normalizes any thrown failure into the structured tool error shape. */
export function toToolError(error: unknown): AgentToolError {
  if (error instanceof ToolInputError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof WorkspaceSecurityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message, retryable: true };
}
