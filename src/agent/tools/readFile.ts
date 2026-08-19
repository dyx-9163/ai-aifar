import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isExcludedPath, resolveWithinRoot } from '../workspace/pathSecurity.js';
import type { WorkspaceToolContext } from './toolRouter.js';
import { requireToolString, toolInputError, toToolInteger } from './toolInput.js';

export interface ReadFileOutput {
  /** Workspace-relative path using forward slashes. */
  path: string;
  /** Requested line range rendered with stable line-number prefixes. */
  content: string;
  encoding: 'utf-8';
  totalLines: number;
  startLine: number;
  endLine: number;
  /** SHA-256 of the full file content; later write tools verify against it. */
  contentHash: string;
}

export const READ_FILE_MAX_BYTES = 1024 * 1024;
export const READ_FILE_MAX_LINES = 2000;

export async function runReadFile(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
): Promise<{ output: ReadFileOutput; truncated: boolean }> {
  const relativePath = requireToolString(rawInput, 'path');

  const absolute = resolveWithinRoot(context.canonicalRootPath, relativePath);
  if (isExcludedPath(context.canonicalRootPath, absolute)) {
    throw toolInputError('excluded-path', `Path is excluded by workspace policy: ${relativePath}`);
  }

  const stat = safeStat(absolute);
  if (!stat || !stat.isFile()) {
    const hint = !stat
      ? ' The file does not exist yet; create it with apply_patch ("baseContentHash": "" — any edit shape works for a missing file, the replacements become the file content).'
      : '';
    throw toolInputError('not-a-file', `Not a file: ${relativePath}.${hint}`);
  }
  if (stat.size > READ_FILE_MAX_BYTES) {
    throw toolInputError('file-too-large', `File exceeds the ${READ_FILE_MAX_BYTES} byte read limit.`);
  }

  const buffer = readFileSync(absolute);
  if (looksBinary(buffer)) {
    throw toolInputError('binary-file', `File appears to be binary: ${relativePath}`);
  }

  const contentHash = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf-8');
  const lines = text.split('\n');
  const totalLines = lines.length;

  const startLine = toToolInteger(rawInput, 'startLine', 1, 1, Math.max(1, totalLines));
  const requestedEnd = toToolInteger(rawInput, 'endLine', 0, 0, Number.MAX_SAFE_INTEGER);
  const endLine = Math.min(
    requestedEnd > 0 ? requestedEnd : startLine + READ_FILE_MAX_LINES - 1,
    totalLines,
  );
  const truncated = endLine - startLine + 1 > READ_FILE_MAX_LINES || endLine < totalLines;

  const width = String(endLine).length;
  const rendered = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${String(startLine + index).padStart(width)}| ${line.replace(/\r$/, '')}`)
    .join('\n');

  return {
    output: {
      path: path.relative(context.canonicalRootPath, absolute).split(path.sep).join('/'),
      content: rendered,
      encoding: 'utf-8',
      totalLines,
      startLine,
      endLine,
      contentHash,
    },
    truncated,
  };
}

function looksBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function safeStat(target: string) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}
