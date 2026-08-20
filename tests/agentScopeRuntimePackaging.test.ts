import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import forgeConfig from '../forge.config';
import {
  enumerateOuterFiles,
  validateOuterInventory,
  verifyPackagedAgentScopeRuntime,
} from '../scripts/verify-package-contents.mjs';

const temporaryRoots: string[] = [];

const versionOutput = JSON.stringify({
  pythonVersion: '3.11.16',
  agentScopeVersion: '2.0.6',
  runtimeVersion: '1.0.0',
  protocolVersion: '1',
  platform: 'win32',
  compileTarget: 'win-amd64',
  machine: 'AMD64',
  pointerBits: 64,
});

const createPackageFixture = async () => {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), 'agentscope-package-'));
  temporaryRoots.push(packageRoot);
  const runtimeRoot = path.join(packageRoot, 'resources', 'agentscope-runtime');
  const contents = new Map([
    ['app/private_ai_agentscope/bootstrap.py', 'bootstrap'],
    ['python-install/cpython-3.11.16-windows-x86_64-none/python.exe', 'python'],
    ['site-packages/agentscope/__init__.py', '__version__ = "2.0.6"'],
  ]);
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  for (const [relativePath, content] of contents) {
    const absolutePath = path.join(runtimeRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
    files.push({
      path: relativePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    pythonVersion: '3.11.16',
    agentScopeVersion: '2.0.6',
    protocolVersion: '1',
    pythonRelativePath: 'python-install/cpython-3.11.16-windows-x86_64-none/python.exe',
    appRelativePath: 'app',
    sitePackagesRelativePath: 'site-packages',
    files,
  };
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(packageRoot, 'resources', 'app.asar'), 'asar', 'utf8');
  return { packageRoot, runtimeRoot, manifestPath, manifest };
};

const fakeInterpreter = async () => ({ stdout: versionOutput, stderr: '' });

const skipUnsupportedLinkPrivilege = (
  error: unknown,
  skip: (condition?: boolean, note?: string) => void,
) => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['EACCES', 'ENOSYS', 'EPERM'].includes(String(error.code))
  ) {
    skip(true, `Filesystem links are unavailable: ${String(error.code)}`);
    return true;
  }
  return false;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('embedded AgentScope package contract', () => {
  it('makes package, build, E2E, and make use the verified runtime pipeline', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
    expect(packageJson.scripts.package).toBe(
      'pnpm agentscope:bundle && electron-forge package && node scripts/verify-package-contents.mjs',
    );
    expect(packageJson.scripts.build).toBe('pnpm package');
    expect(packageJson.scripts['test:e2e']).toMatch(/^pnpm package && /);
    expect(packageJson.scripts.make).toBe('pnpm package && electron-forge make --skip-package');
  });

  it('places exactly the generated runtime tree beside ASAR', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toEqual(['resources/agentscope-runtime']);
  });

  it('accepts only the manifest-backed runtime files in the outer package', async () => {
    const fixture = await createPackageFixture();
    const result = await verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    });

    expect(result.inventory.files).toBe(3);
    expect(validateOuterInventory([
      'Private AI Desktop.exe',
      'resources/app.asar',
      'resources/agentscope-runtime/runtime-manifest.json',
      ...fixture.manifest.files.map((file) => `resources/agentscope-runtime/${file.path}`),
    ], fixture.manifest.files.map((file) => file.path))).toEqual({ files: 6 });
  });

  it('rejects a missing manifest-selected interpreter', async () => {
    const fixture = await createPackageFixture();
    await rm(path.join(fixture.runtimeRoot, ...fixture.manifest.pythonRelativePath.split('/')));
    await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    })).rejects.toThrow(/missing|manifest|python/i);
  });

  it('rejects hash and size mismatches in the packaged copy', async () => {
    const fixture = await createPackageFixture();
    await writeFile(path.join(fixture.runtimeRoot, 'app', 'private_ai_agentscope', 'bootstrap.py'), 'changed', 'utf8');
    await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    })).rejects.toThrow(/hash|size/i);
  });

  it.each([
    ['extra file', 'app/private_ai_agentscope/extra.py', 'extra'],
    ['environment file', 'app/.env', 'API_TOKEN=secret'],
    ['private key', 'app/server.key', '-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END PRIVATE KEY-----'],
    ['cache file', 'site-packages/pkg/__pycache__/module.pyc', 'cache'],
    ['test file', 'site-packages/pkg/tests/test_api.py', 'test'],
    ['package manager', 'site-packages/pip/__init__.py', 'pip'],
    ['secret file', 'app/credentials.json', '{"token":"secret"}'],
  ])('rejects packaged %s outside the manifest', async (_label, relativePath, content) => {
    const fixture = await createPackageFixture();
    const absolutePath = path.join(fixture.runtimeRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
    await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    })).rejects.toThrow(/extra|forbidden|private key|secret/i);
  });

  it('rejects a credential file even when it is added to the runtime manifest', async () => {
    const fixture = await createPackageFixture();
    const relativePath = 'app/credentials.json';
    const content = '{"token":"secret"}';
    const absolutePath = path.join(fixture.runtimeRoot, ...relativePath.split('/'));
    await writeFile(absolutePath, content, 'utf8');
    const parsed = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
    parsed.files.push({
      path: relativePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    });
    parsed.files.sort((left: { path: string }, right: { path: string }) =>
      left.path.localeCompare(right.path, 'en'));
    await writeFile(fixture.manifestPath, JSON.stringify(parsed), 'utf8');

    await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    })).rejects.toThrow(/secret|credential/i);
  });

  it('rejects absolute and escaping manifest paths', async () => {
    for (const unsafePath of ['C:/Windows/python.exe', '../python.exe']) {
      const fixture = await createPackageFixture();
      const parsed = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
      parsed.pythonRelativePath = unsafePath;
      await writeFile(fixture.manifestPath, JSON.stringify(parsed), 'utf8');
      await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
        executeInterpreter: fakeInterpreter,
      })).rejects.toThrow(/contained relative path|manifest/i);
    }
  });

  it('rejects runtime symlinks or reparse points', async () => {
    const fixture = await createPackageFixture();
    const target = path.join(fixture.runtimeRoot, 'external.txt');
    const alias = path.join(fixture.runtimeRoot, 'app', 'link.txt');
    await writeFile(target, 'external', 'utf8');
    try {
      await symlink(target, alias, 'file');
    } catch (error) {
      if (process.platform === 'win32' && error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
        return;
      }
      throw error;
    }
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    await expect(verifyPackagedAgentScopeRuntime(fixture.packageRoot, {
      executeInterpreter: fakeInterpreter,
    })).rejects.toThrow(/symlink|reparse/i);
  });

  it('rejects a symlink even when its filename is allowed by the outer policy', async ({ skip }) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agentscope-outer-link-'));
    temporaryRoots.push(parent);
    const packageRoot = path.join(parent, 'package');
    const externalFile = path.join(parent, 'external-license.txt');
    await mkdir(packageRoot);
    await writeFile(externalFile, 'external', 'utf8');
    try {
      await symlink(externalFile, path.join(packageRoot, 'LICENSE'), 'file');
    } catch (error) {
      if (skipUnsupportedLinkPrivilege(error, skip)) {
        return;
      }
      throw error;
    }

    await expect(enumerateOuterFiles(packageRoot)).rejects.toThrow(/symlink|reparse/i);
    await expect(readFile(externalFile, 'utf8')).resolves.toBe('external');
  });

  it('rejects a directory junction or reparse point without traversing it', async ({ skip }) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agentscope-outer-junction-'));
    temporaryRoots.push(parent);
    const packageRoot = path.join(parent, 'package');
    const externalDirectory = path.join(parent, 'external-locales');
    const marker = path.join(externalDirectory, 'must-survive.pak');
    await mkdir(packageRoot);
    await mkdir(externalDirectory);
    await writeFile(marker, 'external', 'utf8');
    try {
      await symlink(
        externalDirectory,
        path.join(packageRoot, 'locales'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (skipUnsupportedLinkPrivilege(error, skip)) {
        return;
      }
      throw error;
    }

    await expect(enumerateOuterFiles(packageRoot)).rejects.toThrow(/symlink|reparse/i);
    await expect(readFile(marker, 'utf8')).resolves.toBe('external');
  });
});
