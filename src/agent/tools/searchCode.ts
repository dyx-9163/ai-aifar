import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isExcludedDirectory,
  isExcludedFile,
  resolveWithinRoot,
} from '../workspace/pathSecurity.js';
import type { WorkspaceToolContext } from './toolRouter.js';
import { requireToolString, toToolBoolean, toToolInteger } from './toolInput.js';

export interface SearchCodeMatch {
  /** Workspace-relative path using forward slashes. */
  file: string;
  line: number;
  snippet: string;
}

export interface SearchCodeOutput {
  matches: SearchCodeMatch[];
  truncated: boolean;
  filesScanned: number;
}

export const SEARCH_CODE_DEFAULT_MAX_RESULTS = 50;
export const SEARCH_CODE_MAX_RESULTS = 200;
const SEARCH_CODE_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_CODE_MAX_FILES = 5000;
const SEARCH_CODE_SNIPPET_MAX_LENGTH = 240;

export async function runSearchCode(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
): Promise<{ output: SearchCodeOutput; truncated: boolean }> {
  const query = requireToolString(rawInput, 'query');
  const glob = requireToolString(rawInput, 'glob', { optional: true, emptyAsUndefined: true });
  const caseSensitive = toToolBoolean(rawInput, 'caseSensitive', false);
  const maxResults = toToolInteger(
    rawInput,
    'maxResults',
    SEARCH_CODE_DEFAULT_MAX_RESULTS,
    1,
    SEARCH_CODE_MAX_RESULTS,
  );

  const pattern = compilePattern(query, caseSensitive);
  const globMatcher = glob ? compileGlob(glob) : undefined;

  const matches: SearchCodeMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  const visit = (directory: string): void => {
    if (truncated) return;
    const children = safeReaddir(directory);
    if (children === undefined) return;
    children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      if (truncated) return;
      const absolute = path.join(directory, name);
      const stat = safeStat(absolute);
      if (stat?.isDirectory()) {
        if (!isExcludedDirectory(name)) visit(absolute);
        continue;
      }
      if (!stat?.isFile()) continue;
      if (isExcludedFile(name)) continue;
      if (stat.size > SEARCH_CODE_MAX_FILE_BYTES) continue;
      const relative = toRelativePosix(context.canonicalRootPath, absolute);
      if (globMatcher && !globMatcher(relative, name)) continue;
      filesScanned += 1;
      if (filesScanned > SEARCH_CODE_MAX_FILES) {
        truncated = true;
        return;
      }
      scanFile(absolute, relative, pattern, matches, maxResults);
      if (matches.length >= maxResults) truncated = true;
    }
  };

  const root = resolveWithinRoot(context.canonicalRootPath, '.');
  visit(root);

  return { output: { matches, truncated, filesScanned }, truncated };
}

function scanFile(
  absolute: string,
  relative: string,
  pattern: RegExp,
  matches: SearchCodeMatch[],
  maxResults: number,
): void {
  let text: string;
  try {
    text = readFileSync(absolute, 'utf-8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= maxResults) return;
    pattern.lastIndex = 0;
    if (!pattern.test(lines[index])) continue;
    const snippet = lines[index].trim().replace(/\r$/, '');
    matches.push({
      file: relative,
      line: index + 1,
      snippet:
        snippet.length > SEARCH_CODE_SNIPPET_MAX_LENGTH
          ? `${snippet.slice(0, SEARCH_CODE_SNIPPET_MAX_LENGTH)}…`
          : snippet,
    });
  }
}

function compilePattern(query: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? 'u' : 'iu';
  try {
    return new RegExp(query, flags);
  } catch {
    // Model-supplied invalid regex: degrade to a literal match instead of failing.
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

type GlobMatcher = (relativePath: string, baseName: string) => boolean;

function compileGlob(glob: string): GlobMatcher {
  const normalized = glob.trim().split(path.sep).join('/');
  const anchored = normalized.includes('/');
  const regexSource = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:[^/]+/)*')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  const regex = new RegExp(`^${regexSource}$`, 'u');
  return (relativePath, baseName) => (anchored ? regex.test(relativePath) : regex.test(baseName));
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
