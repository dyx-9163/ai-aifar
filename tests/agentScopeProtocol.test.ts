import { describe, expect, it } from 'vitest';
import {
  parseAgentScopeReady,
  parseRuntimeManifest,
  type AgentScopeRuntimeManifest,
  type AgentScopeRuntimeState,
} from '../src/main/agentScopeProtocol';

const validReady = () => ({
  type: 'agentscope.ready',
  protocol_version: '1',
  runtime_version: '1.0.0',
  agentscope_version: '2.0.6',
  port: 49152,
  pid: 1234,
});

const validManifest = (): AgentScopeRuntimeManifest => ({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  pythonVersion: '3.11.16',
  agentScopeVersion: '2.0.6',
  protocolVersion: '1',
  pythonRelativePath: 'python/python.exe',
  appRelativePath: 'app',
  sitePackagesRelativePath: 'python/Lib/site-packages',
  files: [
    {
      path: 'python/python.exe',
      sha256: 'a'.repeat(64),
      size: 123456,
    },
  ],
});

describe('AgentScope bootstrap readiness protocol', () => {
  it('accepts the exact pinned readiness object', () => {
    expect(parseAgentScopeReady(JSON.stringify(validReady()))).toEqual(validReady());
  });

  it.each([
    ['invalid JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['missing field', JSON.stringify((({ pid: _pid, ...value }) => value)(validReady()))],
    ['unknown key', JSON.stringify({ ...validReady(), extra: true })],
    ['wrong type', JSON.stringify({ ...validReady(), port: '49152' })],
  ])('rejects %s', (_label, input) => {
    expect(() => parseAgentScopeReady(input)).toThrow();
  });

  it.each([
    ['type', 'other'],
    ['protocol_version', '2'],
    ['runtime_version', '1.0.1'],
    ['agentscope_version', '2.0.5'],
  ] as const)('rejects a mismatched %s', (key, value) => {
    expect(() => parseAgentScopeReady(JSON.stringify({ ...validReady(), [key]: value }))).toThrow(
      new RegExp(key.replace('_', ' '), 'i'),
    );
  });

  it.each([
    ['port below range', { port: 0 }],
    ['port above range', { port: 65536 }],
    ['fractional port', { port: 42.5 }],
    ['non-positive pid', { pid: 0 }],
    ['fractional pid', { pid: 12.5 }],
  ])('rejects %s', (_label, replacement) => {
    expect(() => parseAgentScopeReady(JSON.stringify({ ...validReady(), ...replacement }))).toThrow();
  });
});

describe('AgentScope runtime manifest protocol', () => {
  it('accepts an exact pinned manifest and returns a detached value', () => {
    const input = validManifest();
    const parsed = parseRuntimeManifest(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.files).not.toBe(input.files);
    expect(parsed.files[0]).not.toBe(input.files[0]);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['unknown top-level key', { ...validManifest(), extra: true }],
    ['missing top-level key', (({ files: _files, ...value }) => value)(validManifest())],
    [
      'unknown file key',
      { ...validManifest(), files: [{ ...validManifest().files[0], extra: true }] },
    ],
    ['non-array files', { ...validManifest(), files: {} }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseRuntimeManifest(input)).toThrow();
  });

  it.each([
    ['schemaVersion', 2],
    ['platform', 'linux'],
    ['arch', 'arm64'],
    ['pythonVersion', '3.11.15'],
    ['agentScopeVersion', '2.0.5'],
    ['protocolVersion', '2'],
  ] as const)('rejects a mismatched %s', (key, value) => {
    expect(() => parseRuntimeManifest({ ...validManifest(), [key]: value })).toThrow(
      new RegExp(key, 'i'),
    );
  });

  it.each(['pythonRelativePath', 'appRelativePath', 'sitePackagesRelativePath'] as const)(
    'rejects invalid %s values',
    (key) => {
      for (const value of [
        '',
        '   ',
        '.',
        'folder/..',
        '../escape',
        'folder/../../escape',
        '/absolute/path',
        '\\absolute\\path',
        'C:\\absolute\\path',
        'C:drive-relative',
        '\\\\server\\share\\file',
      ]) {
        expect(() => parseRuntimeManifest({ ...validManifest(), [key]: value }), value).toThrow(
          /relative path/i,
        );
      }
    },
  );

  it.each([
    ['empty inventory path', { path: '' }],
    ['escaping inventory path', { path: '../escape' }],
    ['uppercase digest', { sha256: 'A'.repeat(64) }],
    ['short digest', { sha256: 'a'.repeat(63) }],
    ['non-hex digest', { sha256: 'g'.repeat(64) }],
    ['negative size', { size: -1 }],
    ['fractional size', { size: 1.5 }],
    ['unsafe size', { size: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', (_label, replacement) => {
    expect(() =>
      parseRuntimeManifest({
        ...validManifest(),
        files: [{ ...validManifest().files[0], ...replacement }],
      }),
    ).toThrow();
  });
});

describe('AgentScope runtime state type', () => {
  it('supports only the approved finite states and degraded reasons', () => {
    const states: AgentScopeRuntimeState[] = [
      { state: 'stopped' },
      { state: 'starting', attempt: 1 },
      {
        state: 'ready',
        pid: 1234,
        port: 49152,
        runtimeVersion: '1.0.0',
        agentScopeVersion: '2.0.6',
      },
      ...(
        [
          'missing-runtime',
          'invalid-manifest',
          'protocol-mismatch',
          'health-failed',
          'start-timeout',
          'exited',
        ] as const
      ).map((reason): AgentScopeRuntimeState => ({ state: 'degraded', reason, detail: reason })),
    ];

    expect(states).toHaveLength(9);
  });
});
