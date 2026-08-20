import { describe, expect, it } from 'vitest';
import { buildNativeToolSchemas, type NativeToolSchema } from '../src/agent/tools/toolSchemas';
import { READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/agent/tools/toolRouter';

function names(schemas: NativeToolSchema[]): string[] {
  return schemas.map((schema) => schema.function.name);
}

describe('buildNativeToolSchemas', () => {
  it('exposes only read-only tools in read-only workspaces', () => {
    const schemas = buildNativeToolSchemas('read-only');
    expect(names(schemas)).toEqual([...READ_ONLY_TOOL_NAMES]);
  });

  it('adds write tools in read-write workspaces', () => {
    const schemas = buildNativeToolSchemas('read-write');
    expect(names(schemas)).toEqual([...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
  });

  it('produces OpenAI function-calling shaped schemas', () => {
    for (const schema of buildNativeToolSchemas('read-write')) {
      expect(schema.type).toBe('function');
      expect(schema.function.name.length).toBeGreaterThan(0);
      expect(schema.function.description.length).toBeGreaterThan(0);
      expect(schema.function.parameters.type).toBe('object');
    }
  });

  it('pins the required input fields of the core tools', () => {
    const schemas = buildNativeToolSchemas('read-write');
    const requiredFor = (tool: string): unknown =>
      schemas.find((schema) => schema.function.name === tool)?.function.parameters.required;
    expect(requiredFor('read_file')).toEqual(['path']);
    expect(requiredFor('search_code')).toEqual(['query']);
    expect(requiredFor('run_command')).toEqual(['command']);
    // apply_patch accepts either a single-file or a batch changeset, so no
    // field is globally required; the model picks one shape.
    expect(requiredFor('apply_patch')).toEqual([]);
    expect(requiredFor('git_status')).toEqual([]);
  });

  it('describes apply_patch batch changesets so native callers can emit them', () => {
    const schemas = buildNativeToolSchemas('read-write');
    const applyPatch = schemas.find((schema) => schema.function.name === 'apply_patch');
    expect(applyPatch?.function.description).toContain('files');
    expect(applyPatch?.function.parameters.properties).toHaveProperty('files');
    expect(applyPatch?.function.parameters.properties).toHaveProperty('edits');
    expect(applyPatch?.function.parameters.properties).toHaveProperty('baseContentHash');
  });
});
