import path from 'node:path';
import os from 'node:os';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  UV_PYTHON_INSTALL_TIMEOUT_MS,
  assertSafeRuntimeOutput,
  canonicalizeDistInfoRecordText,
  isForbiddenRuntimePath,
  removeContainedDirectoryNoFollow,
  resolveBuildPaths,
  resolveRuntimeTarget,
  validateManagedPythonFallback,
} from '../scripts/agentscope-runtime/build.mjs';
import {
  buildIsolatedPythonArguments,
  compareRuntimeInventories,
  containsBuildPathLeak,
  containsPrivateKeyMaterial,
  isCanonicalDistInfoRecordText,
  parseRuntimeManifest,
} from '../scripts/agentscope-runtime/verify.mjs';

const manifestFile = (filePath: string, overrides: Record<string, unknown> = {}) => ({
  path: filePath,
  sha256: 'a'.repeat(64),
  size: 7,
  ...overrides,
});

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  pythonVersion: '3.11.16',
  agentScopeVersion: '2.0.6',
  protocolVersion: '1',
  pythonRelativePath: 'python-install/cpython-3.11.16-windows-x86_64-none/python.exe',
  appRelativePath: 'app',
  sitePackagesRelativePath: 'site-packages',
  files: [
    manifestFile('app/private_ai_agentscope/bootstrap.py'),
    manifestFile('python-install/cpython-3.11.16-windows-x86_64-none/python.exe', {
      sha256: 'c'.repeat(64),
      size: 13,
    }),
    manifestFile('site-packages/agentscope/__init__.py', { sha256: 'b'.repeat(64), size: 11 }),
  ],
  ...overrides,
});

describe('AgentScope embedded runtime build policy', () => {
  it('supports only the verified win32-x64 artifact', () => {
    expect(resolveRuntimeTarget('win32', 'x64')).toEqual({ platform: 'win32', arch: 'x64' });
    expect(() => resolveRuntimeTarget('linux', 'x64')).toThrow(/unsupported embedded runtime/i);
    expect(() => resolveRuntimeTarget('win32', 'arm64')).toThrow(/unsupported embedded runtime/i);
  });

  it('derives only PID-scoped staging and exact output paths below resources', () => {
    const repositoryRoot = path.resolve('D:/workspace/ai-aifar');
    expect(resolveBuildPaths(repositoryRoot, 4321)).toEqual({
      repositoryRoot,
      resourcesRoot: path.join(repositoryRoot, 'resources'),
      outputRoot: path.join(repositoryRoot, 'resources', 'agentscope-runtime'),
      stagingRoot: path.join(repositoryRoot, 'resources', '.agentscope-runtime-staging-4321'),
      previousRoot: path.join(repositoryRoot, 'resources', '.agentscope-runtime-staging-4321-previous'),
    });
    expect(() => resolveBuildPaths(repositoryRoot, 0)).toThrow(/process id/i);
  });

  it('refuses cleanup outside the exact runtime output and staging family', () => {
    const repositoryRoot = path.resolve('D:/workspace/ai-aifar');
    const resourcesRoot = path.join(repositoryRoot, 'resources');

    expect(assertSafeRuntimeOutput(path.join(resourcesRoot, 'agentscope-runtime'), repositoryRoot))
      .toBe(path.join(resourcesRoot, 'agentscope-runtime'));
    expect(assertSafeRuntimeOutput(
      path.join(resourcesRoot, '.agentscope-runtime-staging-4321'),
      repositoryRoot,
    )).toBe(path.join(resourcesRoot, '.agentscope-runtime-staging-4321'));

    for (const unsafe of [
      '',
      repositoryRoot,
      resourcesRoot,
      path.dirname(repositoryRoot),
      path.join(repositoryRoot, 'resources-evil', 'agentscope-runtime'),
      path.join(resourcesRoot, 'agentscope-runtime-evil'),
      path.join(resourcesRoot, '.agentscope-runtime-staging-no-pid'),
    ]) {
      expect(() => assertSafeRuntimeOutput(unsafe, repositoryRoot)).toThrow(/unsafe runtime output/i);
    }
  });

  it('bounds the required uv-managed Python install attempt', () => {
    expect(UV_PYTHON_INSTALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(UV_PYTHON_INSTALL_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('unlinks a contained junction without traversing or deleting its external target', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentscope-runtime-cleanup-'));
    const stagingRoot = path.join(temporaryRoot, '.agentscope-runtime-staging-1234');
    const pythonInstallRoot = path.join(stagingRoot, 'python-install');
    const externalTarget = path.join(temporaryRoot, 'external-managed-python');
    const marker = path.join(externalTarget, 'must-survive.txt');
    const alias = path.join(pythonInstallRoot, 'cpython-3.11-windows-x86_64-none');

    await mkdir(pythonInstallRoot, { recursive: true });
    await mkdir(externalTarget, { recursive: true });
    await writeFile(marker, 'survives', 'utf8');
    await symlink(externalTarget, alias, 'junction');

    try {
      await removeContainedDirectoryNoFollow(pythonInstallRoot, stagingRoot);
      await expect(lstat(pythonInstallRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(marker, 'utf8')).resolves.toBe('survives');
    } finally {
      try {
        await unlink(alias);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects root, containment-root, nested, and out-of-scope no-follow cleanup targets', async () => {
    const temporaryRoot = path.resolve(os.tmpdir(), 'agentscope-runtime-cleanup-policy');
    const stagingRoot = path.join(temporaryRoot, '.agentscope-runtime-staging-1234');

    for (const unsafe of [
      path.parse(stagingRoot).root,
      stagingRoot,
      path.join(stagingRoot, 'nested', 'python-install'),
      path.join(temporaryRoot, 'outside-python-install'),
    ]) {
      await expect(removeContainedDirectoryNoFollow(unsafe, stagingRoot))
        .rejects.toThrow(/unsafe contained cleanup/i);
    }
  });

  it.each([
    '.env',
    'config/.env.production',
    'keys/server.pem',
    'keys/server.key',
    'app/__pycache__/bootstrap.cpython-311.pyc',
    'site-packages/pkg/tests/test_api.py',
    'site-packages/pkg/test/fixture.py',
    'site-packages/.git/config',
    'site-packages/.cache/download.bin',
    'site-packages/pip/__init__.py',
    'site-packages/bin/uvicorn.exe',
    'site-packages/private_ai_agentscope.pth',
    'site-packages/wheels/pkg.whl',
    'uv-cache/interpreter-v4/metadata.msgpack',
    'python-install/python-installer.exe',
    'requirements.lock',
  ])('classifies forbidden generated-runtime content: %s', (relativePath) => {
    expect(isForbiddenRuntimePath(relativePath)).toBe(true);
  });

  it.each([
    'python-install/cpython-3.11.16-windows-x86_64-none/python.exe',
    'app/private_ai_agentscope/bootstrap.py',
    'site-packages/agentscope/__init__.py',
  ])('keeps required runtime content: %s', (relativePath) => {
    expect(isForbiddenRuntimePath(relativePath)).toBe(false);
  });

  it('accepts only an exact win32-x64 interpreter below the uv-managed root', () => {
    const managedRoot = path.resolve('C:/Users/test/AppData/Roaming/uv/python');
    const foundPythonPath = path.join(
      managedRoot,
      'cpython-3.11.16-windows-x86_64-none',
      'python.exe',
    );
    expect(validateManagedPythonFallback({
      managedRoot,
      foundPythonPath,
      version: '3.11.16',
      platform: 'win32',
      machine: 'AMD64',
      pointerBits: 64,
    })).toEqual({
      sourceRoot: path.dirname(foundPythonPath),
      installationName: 'cpython-3.11.16-windows-x86_64-none',
    });
  });

  it.each([
    ['outside managed root', { foundPythonPath: 'C:/Python311/python.exe' }],
    ['managed root itself', { foundPythonPath: 'C:/Users/test/AppData/Roaming/uv/python/python.exe' }],
    ['nested executable', {
      foundPythonPath: 'C:/Users/test/AppData/Roaming/uv/python/cpython-3.11.16-windows-x86_64-none/bin/python.exe',
    }],
    ['wrong executable name', {
      foundPythonPath: 'C:/Users/test/AppData/Roaming/uv/python/cpython-3.11.16-windows-x86_64-none/pythonw.exe',
    }],
    ['wrong version', { version: '3.11.15' }],
    ['wrong platform', { platform: 'linux' }],
    ['wrong architecture', { machine: 'ARM64' }],
    ['wrong pointer width', { pointerBits: 32 }],
  ])('rejects fallback from %s', (_label, replacement) => {
    const managedRoot = path.resolve('C:/Users/test/AppData/Roaming/uv/python');
    expect(() => validateManagedPythonFallback({
      managedRoot,
      foundPythonPath: path.join(
        managedRoot,
        'cpython-3.11.16-windows-x86_64-none',
        'python.exe',
      ),
      version: '3.11.16',
      platform: 'win32',
      machine: 'AMD64',
      pointerBits: 64,
      ...replacement,
    })).toThrow(/managed CPython fallback/i);
  });
});

describe('independent AgentScope runtime manifest policy', () => {
  it('detects PID-scoped staging paths embedded by generated console launchers', () => {
    expect(containsBuildPathLeak(
      'D:\\repo\\resources\\.agentscope-runtime-staging-1234\\site-packages',
    )).toBe(true);
    expect(containsBuildPathLeak('app/private_ai_agentscope/bootstrap.py')).toBe(false);
  });

  it('disables bytecode writes while isolating the bundled interpreter', () => {
    expect(buildIsolatedPythonArguments('print(1)')).toEqual(['-I', '-B', '-c', 'print(1)']);
  });

  it('distinguishes actual private-key blocks from serialization source literals', () => {
    expect(containsPrivateKeyMaterial([
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'c2VjcmV0LWtleS1tYXRlcmlhbA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'))).toBe(true);
    expect(containsPrivateKeyMaterial(
      'PEM_START = b"-----BEGIN OPENSSH PRIVATE KEY-----"',
    )).toBe(false);
  });

  it('accepts only the pinned, sorted, complete manifest shape', () => {
    expect(parseRuntimeManifest(manifest())).toEqual(manifest());
  });

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['platform', { platform: 'linux' }],
    ['architecture', { arch: 'arm64' }],
    ['Python version', { pythonVersion: '3.11.15' }],
    ['AgentScope version', { agentScopeVersion: '2.0.7' }],
    ['protocol version', { protocolVersion: '2' }],
    ['absolute interpreter', { pythonRelativePath: 'C:/Python/python.exe' }],
    ['escaping application', { appRelativePath: '../app' }],
    ['root-equal site-packages', { sitePackagesRelativePath: '.' }],
    ['unknown key', { unexpected: true }],
  ])('rejects a wrong %s', (_label, replacement) => {
    expect(() => parseRuntimeManifest(manifest(replacement))).toThrow();
  });

  it('rejects duplicate, unsorted, forbidden, malformed, and self-inventoried files', () => {
    const valid = manifest().files as Array<Record<string, unknown>>;
    const invalidInventories = [
      [valid[1], valid[0]],
      [valid[0], valid[0]],
      [manifestFile('../outside.txt')],
      [manifestFile('runtime-manifest.json')],
      [manifestFile('app/.env')],
      [manifestFile('app/file.py', { sha256: 'A'.repeat(64) })],
      [manifestFile('app/file.py', { size: -1 })],
    ];

    for (const files of invalidInventories) {
      expect(() => parseRuntimeManifest(manifest({ files }))).toThrow();
    }
  });

  it('canonicalizes installer RECORD rows before inventory and verifies the canonical form', () => {
    const source = [
      'pkg/z.py,sha256=z,9',
      'bin/generated.exe,sha256=staging-path-dependent,46080',
      'pkg/a.py,sha256=a,1',
      'pkg/__init__.py,sha256=i,2',
      '',
    ].join('\r\n');
    const canonical = [
      'bin/generated.exe,,',
      'pkg/__init__.py,sha256=i,2',
      'pkg/a.py,sha256=a,1',
      'pkg/z.py,sha256=z,9',
      '',
    ].join('\n');

    expect(canonicalizeDistInfoRecordText(source)).toBe(canonical);
    expect(isCanonicalDistInfoRecordText(source)).toBe(false);
    expect(isCanonicalDistInfoRecordText(canonical)).toBe(true);
  });

  it('rejects missing, extra, hash-drifted, and size-drifted artifact files', () => {
    const expected = (manifest().files as Array<Record<string, unknown>>).map((file) => ({
      path: String(file.path),
      sha256: String(file.sha256),
      size: Number(file.size),
    }));

    expect(compareRuntimeInventories(expected, expected)).toEqual({ files: 3 });
    expect(() => compareRuntimeInventories(expected, expected.slice(0, 2))).toThrow(/missing/i);
    expect(() => compareRuntimeInventories(expected, [
      ...expected,
      manifestFile('site-packages/extra.py'),
    ])).toThrow(/extra/i);
    expect(() => compareRuntimeInventories(expected, expected.map((file, index) =>
      index === 1 ? { ...file, sha256: 'd'.repeat(64) } : file,
    ))).toThrow(/hash/i);
    expect(() => compareRuntimeInventories(expected, expected.map((file, index) =>
      index === 1 ? { ...file, size: file.size + 1 } : file,
    ))).toThrow(/size/i);
  });
});
