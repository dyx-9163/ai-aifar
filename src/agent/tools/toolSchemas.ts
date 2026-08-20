/**
 * OpenAI-style function-calling schemas for the workspace tools.
 *
 * Providers that support native tool calling (the dashscope compatible
 * endpoint and any OpenAI-compatible cloud model) receive these schemas via
 * the `tools` request field instead of the fenced-JSON tutorial in the system
 * prompt, which removes the whole text-protocol parse/repair surface.
 */

import type { WorkspaceTrustLevel } from '../../shared/domain.js';
import { READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from './toolRouter.js';

export interface NativeToolParameters {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export interface NativeToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: NativeToolParameters };
}

const EDIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    startLine: { type: 'integer', description: '1-based first line to replace.' },
    endLine: { type: 'integer', description: 'Last line to replace; startLine - 1 inserts before startLine.' },
    replacement: { type: 'string', description: 'Replacement text; keep it at most ~120 lines per edit.' },
  },
  required: ['startLine', 'endLine', 'replacement'],
};

const SINGLE_FILE_SCHEMA: Record<string, Record<string, unknown>> = {
  path: { type: 'string', description: 'Workspace-relative file path.' },
  baseContentHash: {
    type: 'string',
    description: 'contentHash from a fresh read_file of the same file; empty string for a brand-new file.',
  },
  edits: { type: 'array', items: EDIT_SCHEMA, description: 'Line edits applied in one atomic changeset.' },
};

const TOOL_SCHEMAS: Record<string, NativeToolSchema> = {
  workspace_tree: {
    type: 'function',
    function: {
      name: 'workspace_tree',
      description: 'List the workspace directory tree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory to start from.' },
          maxDepth: { type: 'integer' },
          maxEntries: { type: 'integer' },
        },
        required: [],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and its contentHash; apply_patch needs a fresh contentHash before writing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  search_code: {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search file contents in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          maxResults: { type: 'integer' },
        },
        required: ['query'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show working-tree state: branch, staged/unstaged/untracked entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the unified diff of working-tree or staged changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          staged: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  apply_patch: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: [
        'Apply line edits to one file (path + baseContentHash + edits) or to several files at once',
        'as one atomic changeset via a "files" array of such objects.',
        'For a brand-new file use baseContentHash "" with a single insertion edit.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          ...SINGLE_FILE_SCHEMA,
          files: {
            type: 'array',
            items: { type: 'object', properties: SINGLE_FILE_SCHEMA, required: ['path', 'baseContentHash', 'edits'] },
            description: 'Batch form: change several related files in one atomic changeset.',
          },
        },
        required: [],
      },
    },
  },
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a command inside the workspace directory; forbidden commands are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'integer' },
        },
        required: ['command'],
      },
    },
  },
};

/** Schemas for every tool the trust level allows, in presentation order. */
export function buildNativeToolSchemas(trustLevel: WorkspaceTrustLevel): NativeToolSchema[] {
  const toolNames =
    trustLevel === 'read-only'
      ? [...READ_ONLY_TOOL_NAMES]
      : [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES];
  return toolNames.map((name) => TOOL_SCHEMAS[name]);
}
