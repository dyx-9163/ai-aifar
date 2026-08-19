import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isExcludedPath, resolveWithinRoot } from '../workspace/pathSecurity.js';
import type { WorkspaceToolContext } from './toolRouter.js';
import { requireToolString, toolInputError } from './toolInput.js';

export interface PatchEdit {
  /** 1-based first line of the replaced range. */
  startLine: number;
  /** Inclusive last replaced line. `startLine - 1` means insert before `startLine`. */
  endLine: number;
  replacement: string;
}

export interface ApplyPatchOutput {
  /** Workspace-relative path using forward slashes. */
  path: string;
  action: 'created' | 'modified';
  totalLines: number;
  linesChanged: number;
  /** SHA-256 of the new file content; becomes the baseline for the next patch. */
  contentHash: string;
}

const PATCH_MAX_FILE_BYTES = 1024 * 1024;
const PATCH_MAX_EDITS = 50;

export async function runApplyPatch(
  rawInput: Record<string, unknown>,
  context: WorkspaceToolContext,
): Promise<{ output: ApplyPatchOutput; truncated: boolean }> {
  const relativePath = requireToolString(rawInput, 'path');
  const baseContentHash = requireToolString(rawInput, 'baseContentHash', { optional: true }) ?? '';
  const edits = parseEdits(rawInput.edits);

  const absolute = resolveWithinRoot(context.canonicalRootPath, relativePath);
  if (isExcludedPath(context.canonicalRootPath, absolute)) {
    throw toolInputError('excluded-path', `Path is excluded by workspace policy: ${relativePath}`);
  }

  const stat = safeStat(absolute);
  if (stat && !stat.isFile()) {
    throw toolInputError('not-a-file', `Not a file: ${relativePath}`);
  }
  if (stat && stat.size > PATCH_MAX_FILE_BYTES) {
    throw toolInputError('file-too-large', `File exceeds the ${PATCH_MAX_FILE_BYTES} byte patch limit.`);
  }

  const originalText = stat ? readFileSync(absolute, 'utf-8').replace(/\r\n/g, '\n') : '';
  let actualHash = '';
  if (stat) {
    actualHash = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (baseContentHash.toLowerCase() !== actualHash) {
      throw toolInputError(
        'stale-content',
        'File content changed since the recorded baseline. Re-read the file and retry with the new contentHash.',
      );
    }
  } else if (baseContentHash !== '') {
    throw toolInputError('invalid-input', 'Creating a new file requires an empty baseContentHash.');
  }

  const patched = applyEdits(originalText, edits);
  const newContentHash = createHash('sha256').update(Buffer.from(patched.text, 'utf-8')).digest('hex');
  const normalizedRelativePath = path.relative(context.canonicalRootPath, absolute).split(path.sep).join('/');

  // Snapshot the pre-change state before touching the disk so the turn stays
  // rollable even when a later patch targets the same file again.
  context.recordFileChange?.({
    relativePath: normalizedRelativePath,
    previousAction: stat ? 'existed' : 'absent',
    previousContent: stat ? originalText : null,
    previousContentHash: actualHash,
    newContentHash,
  });

  if (!stat) {
    mkdirSync(path.dirname(absolute), { recursive: true });
  }
  writeFileSync(absolute, patched.text, 'utf-8');

  return {
    output: {
      path: normalizedRelativePath,
      action: stat ? 'modified' : 'created',
      totalLines: patched.totalLines,
      linesChanged: patched.linesChanged,
      contentHash: newContentHash,
    },
    truncated: false,
  };
}

function parseEdits(value: unknown): PatchEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw toolInputError('invalid-input', 'Tool input "edits" must be a non-empty array.');
  }
  if (value.length > PATCH_MAX_EDITS) {
    throw toolInputError('invalid-input', `At most ${PATCH_MAX_EDITS} edits are allowed per patch.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw toolInputError('invalid-input', `Edit ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    let startLine = record.startLine;
    let endLine = record.endLine;
    // Models often express "insert at the top of the file" as line 0; that is
    // the same insertion slot as { startLine: 1, endLine: 0 }.
    if (Number(startLine) === 0 && Number(endLine) === 0) {
      startLine = 1;
      endLine = 0;
    }
    if (!Number.isInteger(startLine) || Number(startLine) < 1) {
      throw toolInputError('invalid-input', `Edit ${index + 1} needs a positive integer "startLine".`);
    }
    if (!Number.isInteger(endLine) || Number(endLine) < Number(startLine) - 1) {
      throw toolInputError('invalid-input', `Edit ${index + 1} needs "endLine" >= startLine - 1.`);
    }
    if (typeof record.replacement !== 'string') {
      throw toolInputError('invalid-input', `Edit ${index + 1} needs a string "replacement".`);
    }
    return {
      startLine: Number(startLine),
      endLine: Number(endLine),
      replacement: (record.replacement as string).replace(/\r\n/g, '\n'),
    };
  });
}

function applyEdits(
  originalText: string,
  edits: PatchEdit[],
): { text: string; totalLines: number; linesChanged: number } {
  const lines = originalText === '' ? [] : originalText.split('\n');
  // A trailing newline produces one empty split element that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const hadTrailingNewline = originalText.endsWith('\n') && originalText.length > 0;
  const normalized = lines;
  const totalBefore = normalized.length;

  const sorted = [...edits].sort((left, right) => right.startLine - left.startLine);
  let minAllowedStart = totalBefore + 1;
  let linesChanged = 0;

  for (const edit of sorted) {
    if (edit.startLine > minAllowedStart || edit.endLine > totalBefore) {
      throw toolInputError(
        'invalid-input',
        `Edit at line ${edit.startLine} is out of range or overlaps a previous edit (file has ${totalBefore} lines).`,
      );
    }
    const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
    const removed = Math.max(edit.endLine - edit.startLine + 1, 0);
    normalized.splice(edit.startLine - 1, removed, ...replacementLines);
    linesChanged += removed + replacementLines.length;
    // Edits are applied bottom-up: nothing may touch this range or the
    // insertion slot directly above it anymore.
    minAllowedStart = edit.startLine - 2;
  }

  let text = normalized.join('\n');
  // Preserve the original trailing-newline convention; brand-new files follow
  // the replacement text as written.
  if (text.length > 0 && hadTrailingNewline && !text.endsWith('\n')) {
    text = `${text}\n`;
  }
  return { text, totalLines: normalized.length, linesChanged };
}

function safeStat(target: string) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}
