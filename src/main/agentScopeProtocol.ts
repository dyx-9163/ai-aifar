import path from 'node:path';

export interface AgentScopeBootstrapReady {
  type: 'agentscope.ready';
  protocol_version: '1';
  runtime_version: '1.0.0';
  agentscope_version: '2.0.6';
  port: number;
  pid: number;
}

export interface AgentScopeRuntimeFile {
  path: string;
  sha256: string;
  size: number;
}

export interface AgentScopeRuntimeManifest {
  schemaVersion: 1;
  platform: 'win32';
  arch: 'x64';
  pythonVersion: '3.11.16';
  agentScopeVersion: '2.0.6';
  protocolVersion: '1';
  pythonRelativePath: string;
  appRelativePath: string;
  sitePackagesRelativePath: string;
  files: AgentScopeRuntimeFile[];
}

export type AgentScopeRuntimeState =
  | { state: 'stopped' }
  | { state: 'starting'; attempt: number }
  | {
      state: 'ready';
      pid: number;
      port: number;
      runtimeVersion: '1.0.0';
      agentScopeVersion: '2.0.6';
    }
  | {
      state: 'degraded';
      reason:
        | 'missing-runtime'
        | 'invalid-manifest'
        | 'protocol-mismatch'
        | 'health-failed'
        | 'start-timeout'
        | 'exited';
      detail: string;
    };

const READY_KEYS = [
  'type',
  'protocol_version',
  'runtime_version',
  'agentscope_version',
  'port',
  'pid',
] as const;

const MANIFEST_KEYS = [
  'schemaVersion',
  'platform',
  'arch',
  'pythonVersion',
  'agentScopeVersion',
  'protocolVersion',
  'pythonRelativePath',
  'appRelativePath',
  'sitePackagesRelativePath',
  'files',
] as const;

const FILE_KEYS = ['path', 'sha256', 'size'] as const;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown key "${key}".`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing required key "${key}".`);
    }
  }
}

function requireExactValue<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new Error(`${label} must be exactly ${JSON.stringify(expected)}.`);
  }
  return expected;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a safe integer in the range ${minimum}..${maximum}.`);
  }
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

export function requireContainedRelativePath(value: unknown, label: string): string {
  const relativePath = requireString(value, label);
  if (relativePath.trim().length === 0 || relativePath.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }

  const portablePath = relativePath.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(portablePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`${label} must be a contained relative path.`);
  }

  const normalized = path.posix.normalize(portablePath);
  const normalizedWithoutTrailingSeparators = normalized.replace(/\/+$/, '');
  if (
    normalizedWithoutTrailingSeparators === '.' ||
    normalizedWithoutTrailingSeparators === '..' ||
    normalizedWithoutTrailingSeparators.startsWith('../')
  ) {
    throw new Error(`${label} must be a contained relative path.`);
  }
  return relativePath;
}

export function parseAgentScopeReady(line: string): AgentScopeBootstrapReady {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line) as unknown;
  } catch {
    throw new Error('AgentScope readiness line must be valid JSON.');
  }

  const ready = requireRecord(decoded, 'AgentScope readiness');
  requireExactKeys(ready, READY_KEYS, 'AgentScope readiness');

  return {
    type: requireExactValue(ready.type, 'agentscope.ready', 'readiness type'),
    protocol_version: requireExactValue(
      ready.protocol_version,
      '1',
      'readiness protocol version',
    ),
    runtime_version: requireExactValue(
      ready.runtime_version,
      '1.0.0',
      'readiness runtime version',
    ),
    agentscope_version: requireExactValue(
      ready.agentscope_version,
      '2.0.6',
      'readiness AgentScope version',
    ),
    port: requireInteger(ready.port, 'readiness port', 1, 65535),
    pid: requireInteger(ready.pid, 'readiness pid', 1),
  };
}

export function parseRuntimeManifest(input: unknown): AgentScopeRuntimeManifest {
  const manifest = requireRecord(input, 'AgentScope runtime manifest');
  requireExactKeys(manifest, MANIFEST_KEYS, 'AgentScope runtime manifest');

  if (!Array.isArray(manifest.files)) {
    throw new Error('AgentScope runtime manifest files must be an array.');
  }

  const files = manifest.files.map((inputFile, index): AgentScopeRuntimeFile => {
    const file = requireRecord(inputFile, `AgentScope runtime manifest file ${index}`);
    requireExactKeys(file, FILE_KEYS, `AgentScope runtime manifest file ${index}`);
    const sha256 = requireString(file.sha256, `AgentScope runtime manifest file ${index} sha256`);
    if (!LOWERCASE_SHA256.test(sha256)) {
      throw new Error(
        `AgentScope runtime manifest file ${index} sha256 must be 64 lowercase hexadecimal characters.`,
      );
    }
    return {
      path: requireContainedRelativePath(
        file.path,
        `AgentScope runtime manifest file ${index} path`,
      ),
      sha256,
      size: requireInteger(file.size, `AgentScope runtime manifest file ${index} size`, 0),
    };
  });

  return {
    schemaVersion: requireExactValue(manifest.schemaVersion, 1, 'manifest schemaVersion'),
    platform: requireExactValue(manifest.platform, 'win32', 'manifest platform'),
    arch: requireExactValue(manifest.arch, 'x64', 'manifest arch'),
    pythonVersion: requireExactValue(manifest.pythonVersion, '3.11.16', 'manifest pythonVersion'),
    agentScopeVersion: requireExactValue(
      manifest.agentScopeVersion,
      '2.0.6',
      'manifest agentScopeVersion',
    ),
    protocolVersion: requireExactValue(manifest.protocolVersion, '1', 'manifest protocolVersion'),
    pythonRelativePath: requireContainedRelativePath(
      manifest.pythonRelativePath,
      'manifest pythonRelativePath',
    ),
    appRelativePath: requireContainedRelativePath(
      manifest.appRelativePath,
      'manifest appRelativePath',
    ),
    sitePackagesRelativePath: requireContainedRelativePath(
      manifest.sitePackagesRelativePath,
      'manifest sitePackagesRelativePath',
    ),
    files,
  };
}
