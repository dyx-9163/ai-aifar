import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isExcludedDirectory,
  isExcludedFile,
  resolveWithinRoot,
} from '../workspace/pathSecurity.js';
import type { WorkspaceToolContext } from './toolRouter.js';
import { requireToolString, toolInputError, toToolInteger } from './toolInput.js';

export interface WorkspaceTreeInput {
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}

export interface WorkspaceTreeEntry {
  /** Workspace-relative path using forward slashes. */
  path: string;
  type: 'directory' | 'file';
  size?: number;
  /** True when traversal stopped here because of workspace exclusion rules. */
  ignored: boolean;
}

export interface WorkspaceTreeOutput {
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
}

export const WORKSPACE_TREE_DEFAULT_DEPTH = 3;
export const WORKSPACE_TREE_MAX_DEPTH = 6;
export const WORKSPACE_TREE_DEFAULT_ENTRIES = 200;
export const WORKSPACE_TREE_MAX_ENTRIES = 1000;

export async function runWorkspaceTree(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
): Promise<{ output: WorkspaceTreeOutput; truncated: boolean }> {
  const relativePath = requireToolString(rawInput, 'path', { optional: true, emptyAsUndefined: true }) ?? '.';
  const maxDepth = toToolInteger(rawInput, 'maxDepth', WORKSPACE_TREE_DEFAULT_DEPTH, 1, WORKSPACE_TREE_MAX_DEPTH);
  const maxEntries = toToolInteger(rawInput, 'maxEntries', WORKSPACE_TREE_DEFAULT_ENTRIES, 1, WORKSPACE_TREE_MAX_ENTRIES);

  const root = resolveWithinRoot(context.canonicalRootPath, relativePath);
  const rootStat = safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) {
    throw toolInputError('not-a-directory', `Not a directory: ${relativePath}`);
  }

  const entries: WorkspaceTreeEntry[] = [];
  let truncated = false;

  const visit = (directory: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    const children = safeReaddir(directory);
    if (children === undefined) {
      truncated = true;
      return;
    }
    children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const absolute = path.join(directory, name);
      const relative = toRelativePosix(context.canonicalRootPath, absolute);
      const stat = safeStat(absolute);
      if (stat?.isDirectory()) {
        const ignored = isExcludedDirectory(name);
        entries.push({ path: relative, type: 'directory', ignored });
        if (!ignored) {
          visit(absolute, depth + 1);
        }
      } else if (stat?.isFile()) {
        entries.push({ path: relative, type: 'file', size: stat.size, ignored: isExcludedFile(name) });
      }
    }
  };

  visit(root, 1);
  return { output: { entries, truncated }, truncated };
}

function toRelativePosix(canonicalRoot: string, absolute: string): string {
  return path.relative(canonicalRoot, absolute).split(path.sep).join('/');
}

function safeStat(target: string) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}

function safeReaddir(directory: string): string[] | undefined {
  try {
    return readdirSync(directory);
  } catch {
    return undefined;
  }
}
