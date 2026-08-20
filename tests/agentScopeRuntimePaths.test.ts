import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentScopeRuntimeManifest } from '../src/main/agentScopeProtocol';
import {
  resolveAgentScopeRuntimePaths,
  resolveAgentScopeRuntimeRoot,
} from '../src/main/agentScopeRuntimePaths';

const manifest = (): AgentScopeRuntimeManifest => ({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  pythonVersion: '3.11.16',
  agentScopeVersion: '2.0.6',
  protocolVersion: '1',
  pythonRelativePath: 'python\\python.exe',
  appRelativePath: 'app/private_ai_agentscope',
  sitePackagesRelativePath: 'python\\Lib\\site-packages',
  files: [{ path: 'app/private_ai_agentscope/__init__.py', sha256: 'a'.repeat(64), size: 1 }],
});

describe('AgentScope runtime root', () => {
  it('uses resourcesPath in packaged mode', () => {
    expect(
      resolveAgentScopeRuntimeRoot({
        isPackaged: true,
        resourcesPath: 'C:\\PrivateAI\\resources',
        appPath: 'C:\\ignored',
      }),
    ).toBe(path.resolve('C:\\PrivateAI\\resources', 'agentscope-runtime'));
  });

  it('uses appPath/resources in development mode', () => {
    expect(
      resolveAgentScopeRuntimeRoot({
        isPackaged: false,
        resourcesPath: 'C:\\ignored',
        appPath: 'D:\\workspace\\ai-aifar',
      }),
    ).toBe(path.resolve('D:\\workspace\\ai-aifar', 'resources', 'agentscope-runtime'));
  });
});

describe('AgentScope manifest-derived runtime paths', () => {
  it.each([
    {
      isPackaged: true,
      resourcesPath: 'C:\\PrivateAI\\resources',
      appPath: 'C:\\ignored',
    },
    {
      isPackaged: false,
      resourcesPath: 'C:\\ignored',
      appPath: 'D:\\workspace\\ai-aifar',
    },
  ])('resolves valid contained paths in packaged/development mode', (input) => {
    const root = resolveAgentScopeRuntimeRoot(input);
    const resolved = resolveAgentScopeRuntimePaths(input, manifest());

    expect(resolved).toEqual({
      root,
      manifest: path.resolve(root, 'runtime-manifest.json'),
      pythonPath: path.resolve(root, 'python', 'python.exe'),
      applicationPath: path.resolve(root, 'app', 'private_ai_agentscope'),
      sitePackagesPath: path.resolve(root, 'python', 'Lib', 'site-packages'),
      filePaths: [path.resolve(root, 'app', 'private_ai_agentscope', '__init__.py')],
    });
  });

  it.each([
    ['root equality', '.'],
    ['normalized root equality', 'folder/..'],
    ['parent traversal', '../python.exe'],
    ['nested traversal', 'folder/../../python.exe'],
    ['sibling-prefix escape', '../agentscope-runtime-evil/python.exe'],
    ['drive absolute', 'C:\\outside\\python.exe'],
    ['drive relative', 'C:outside\\python.exe'],
    ['UNC', '\\\\server\\share\\python.exe'],
  ])('rejects a %s interpreter path after resolution', (_label, pythonRelativePath) => {
    expect(() =>
      resolveAgentScopeRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: 'C:\\PrivateAI\\resources',
          appPath: 'C:\\ignored',
        },
        { ...manifest(), pythonRelativePath },
      ),
    ).toThrow(/contained relative path/i);
  });

  it.each([
    ['application', { appRelativePath: '../outside-app' }],
    ['site-packages', { sitePackagesRelativePath: '../outside-site-packages' }],
    ['inventory', { files: [{ ...manifest().files[0], path: '../outside-file' }] }],
  ])('independently contains the %s path', (_label, replacement) => {
    expect(() =>
      resolveAgentScopeRuntimePaths(
        {
          isPackaged: false,
          resourcesPath: 'C:\\ignored',
          appPath: 'D:\\workspace\\ai-aifar',
        },
        { ...manifest(), ...replacement },
      ),
    ).toThrow(/contained relative path/i);
  });
});
