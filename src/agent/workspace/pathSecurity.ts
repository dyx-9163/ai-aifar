import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Workspace path security primitives.
 *
 * All tool-facing path handling MUST go through these helpers:
 * - `normalizeWorkspacePath` canonicalizes a workspace root before persistence.
 * - `resolveWithinRoot` resolves any tool-supplied path against a canonical root
 *   and rejects anything escaping the root (including via symlinks/junctions).
 * - The exclusion lists keep tool traversal away from dependency trees, VCS
 *   internals, secrets and build caches.
 */

export type WorkspacePathSecurityCode =
  | 'not-absolute'
  | 'not-found'
  | 'device-path'
  | 'unc-root'
  | 'outside-workspace';

export class WorkspaceSecurityError extends Error {
  readonly code: WorkspacePathSecurityCode;

  constructor(code: WorkspacePathSecurityCode, message: string) {
    super(message);
    this.name = 'WorkspaceSecurityError';
    this.code = code;
  }
}

export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.turbo',
  '.vite',
  'coverage',
]);

export const DEFAULT_EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|poetry\.lock)$/i,
  /\.min\.js$/i,
  /\.map$/i,
];

const DEVICE_PATH_PATTERN = /^[\\/]{2}[.?][\\/]/;

function isWindows(): boolean {
  return process.platform === 'win32';
}

function looksLikeUnc(value: string): boolean {
  if (DEVICE_PATH_PATTERN.test(value)) {
    return false;
  }
  return /^\\\\[^\\]/.test(value) || /^\/\/[^/]/.test(value);
}

function normalizeDriveLetter(value: string): string {
  if (!isWindows()) {
    return value;
  }
  return value.replace(/^([A-Za-z]):/, (match, letter: string) => `${letter.toLowerCase()}:`);
}

function stripTrailingSeparator(value: string): string {
  if (value.length <= 1) {
    return value;
  }
  const last = value[value.length - 1];
  if (last === path.sep || last === '/') {
    return value.slice(0, -1);
  }
  return value;
}

/**
 * Canonicalizes a workspace root path.
 *
 * Resolves symlinks/junctions, normalizes drive-letter casing on Windows and
 * rejects UNC roots and device paths. Throws `WorkspaceSecurityError` when the
 * input is not an existing absolute directory path.
 */
export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new WorkspaceSecurityError('not-absolute', 'Workspace path is empty.');
  }
  if (DEVICE_PATH_PATTERN.test(trimmed)) {
    throw new WorkspaceSecurityError('device-path', 'Device paths are not allowed as workspace roots.');
  }
  if (!path.isAbsolute(trimmed)) {
    throw new WorkspaceSecurityError('not-absolute', `Workspace path must be absolute: ${trimmed}`);
  }

  const resolved = path.resolve(trimmed);
  if (looksLikeUnc(resolved)) {
    throw new WorkspaceSecurityError('unc-root', 'UNC network paths are not allowed as workspace roots.');
  }

  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    throw new WorkspaceSecurityError('not-found', `Workspace path does not exist: ${trimmed}`);
  }

  if (looksLikeUnc(canonical)) {
    throw new WorkspaceSecurityError('unc-root', 'Workspace root resolves to a UNC network path.');
  }

  return stripTrailingSeparator(normalizeDriveLetter(canonical));
}

/**
 * Resolves the deepest existing ancestor of `value` via realpath and re-attaches
 * the remaining (already `..`-free) segments.
 */
function canonicalizeExisting(value: string): string {
  let current = value;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new WorkspaceSecurityError('not-found', `Path does not exist: ${value}`);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function samePath(left: string, right: string): boolean {
  if (isWindows()) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isUnderRoot(candidate: string, canonicalRoot: string): boolean {
  if (samePath(candidate, canonicalRoot)) {
    return true;
  }
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (isWindows()) {
    return candidate.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return candidate.startsWith(prefix);
}

/**
 * Resolves a tool-supplied path (absolute or workspace-relative) against a
 * canonical workspace root and guarantees the result stays inside the root.
 *
 * Symlinks and directory junctions are resolved before the containment check,
 * so a link pointing outside the workspace is rejected even though its lexical
 * path looks contained.
 */
export function resolveWithinRoot(canonicalRoot: string, requested: string): string {
  const trimmed = requested.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === './') {
    return canonicalRoot;
  }
  if (DEVICE_PATH_PATTERN.test(trimmed)) {
    throw new WorkspaceSecurityError('device-path', 'Device paths are not allowed.');
  }

  const resolved = path.resolve(canonicalRoot, trimmed);
  const canonical = normalizeDriveLetter(canonicalizeExisting(resolved));

  if (!isUnderRoot(canonical, canonicalRoot)) {
    throw new WorkspaceSecurityError('outside-workspace', `Path escapes the workspace root: ${requested}`);
  }
  return canonical;
}

export function isExcludedDirectory(name: string): boolean {
  return DEFAULT_EXCLUDED_DIRECTORIES.has(name);
}

export function isExcludedFile(name: string): boolean {
  return DEFAULT_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Returns true when any segment of `absolutePath` (relative to `canonicalRoot`)
 * is an excluded directory or the final name matches an excluded file pattern.
 */
export function isExcludedPath(canonicalRoot: string, absolutePath: string): boolean {
  const relative = path.relative(canonicalRoot, absolutePath);
  if (relative.length === 0 || relative === '.') {
    return false;
  }
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index < segments.length - 1) {
      if (isExcludedDirectory(segment)) {
        return true;
      }
    } else if (isExcludedDirectory(segment) || isExcludedFile(segment)) {
      return true;
    }
  }
  return false;
}
