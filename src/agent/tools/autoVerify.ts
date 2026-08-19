/**
 * Deterministic post-write verification.
 *
 * After a successful `apply_patch` in a read-write workspace the agent loop
 * runs the project's own verification script (typecheck/check/build from
 * package.json, when present) and appends an `[auto-verify]` report to the
 * tool feedback, so compile errors surface inside the same turn instead of
 * waiting for the user to run a build. Detection and execution are fully
 * client-side; the model only receives the report.
 *
 * Safety: execution reuses `runWorkspaceProcess`, so the child process runs
 * with the workspace root as cwd, without a shell, with a timeout, an output
 * byte cap and cancellation support.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWorkspaceProcess } from './runCommand.js';

export interface VerificationCommand {
  command: string;
  args: string[];
  label: string;
}

export const AUTO_VERIFY_TIMEOUT_MS = 120_000;
/** Only the tail of the output is fed back; error summaries live at the end. */
const AUTO_VERIFY_MAX_FEEDBACK_CHARS = 2400;
/** Script names considered verification work, in priority order. */
const SCRIPT_PRIORITY = ['typecheck', 'type-check', 'check', 'build'] as const;

/**
 * Picks the verification script for a workspace: the first verification
 * script present in package.json, run through the package manager implied by
 * the lockfile (pnpm/yarn/npm). Returns null when nothing verifiable exists.
 */
export function detectVerificationCommand(canonicalRootPath: string): VerificationCommand | null {
  const packageJsonPath = join(canonicalRootPath, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { scripts?: unknown };
    scripts = (parsed.scripts ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const script = SCRIPT_PRIORITY.find((name) => {
    const value = scripts[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (!script) return null;
  const command = existsSync(join(canonicalRootPath, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(canonicalRootPath, 'yarn.lock'))
      ? 'yarn'
      : 'npm';
  return { command, args: ['run', script], label: `${command} run ${script}` };
}

/**
 * Runs the detected verification command and formats the report for model
 * feedback. Returns null when the workspace has nothing verifiable or the
 * runner itself fails (missing package manager, spawn error), so verification
 * problems never break the agent turn.
 */
export async function runAutoVerification(
  canonicalRootPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const detected = detectVerificationCommand(canonicalRootPath);
  if (!detected) return null;
  try {
    const startedAt = Date.now();
    const run = await runWorkspaceProcess(detected.command, detected.args, {
      cwd: canonicalRootPath,
      timeoutMs: AUTO_VERIFY_TIMEOUT_MS,
      signal,
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (run.timedOut) {
      return `[auto-verify] ${detected.label} timed out after ${durationMs}ms; treat the change as unverified.`;
    }
    if (run.exitCode === 0) {
      return `[auto-verify] ${detected.label} passed in ${durationMs}ms.`;
    }
    const detail = tail(run.stderr.trim().length > 0 ? run.stderr : run.stdout);
    return [
      `[auto-verify] ${detected.label} exited ${run.exitCode}. Fix the reported errors with follow-up apply_patch edits before answering.`,
      detail,
    ].join('\n');
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= AUTO_VERIFY_MAX_FEEDBACK_CHARS) return trimmed;
  return `…${trimmed.slice(-AUTO_VERIFY_MAX_FEEDBACK_CHARS)}`;
}
