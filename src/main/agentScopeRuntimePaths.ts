import path from 'node:path';
import type { AgentScopeRuntimeManifest } from './agentScopeProtocol';

export interface ResolveRuntimeInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export interface AgentScopeRuntimePaths {
  root: string;
  manifest: string;
  pythonPath: string;
  applicationPath: string;
  sitePackagesPath: string;
  filePaths: string[];
}

export function resolveAgentScopeRuntimeRoot(input: ResolveRuntimeInput): string {
  return input.isPackaged
    ? path.resolve(input.resourcesPath, 'agentscope-runtime')
    : path.resolve(input.appPath, 'resources', 'agentscope-runtime');
}

function resolveContainedPath(root: string, relativePath: string, label: string): string {
  if (
    relativePath.trim().length === 0 ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath.replace(/\\/g, '/')) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`${label} must be a contained relative path.`);
  }

  const nativeRelativePath = relativePath.replace(/[\\/]/g, path.sep);
  const resolved = path.resolve(root, nativeRelativePath);
  const relativeFromRoot = path.relative(root, resolved);
  if (
    relativeFromRoot === '' ||
    relativeFromRoot === '..' ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error(`${label} must be a contained relative path.`);
  }
  return resolved;
}

export function resolveAgentScopeRuntimePaths(
  input: ResolveRuntimeInput,
  manifest: AgentScopeRuntimeManifest,
): AgentScopeRuntimePaths {
  const root = resolveAgentScopeRuntimeRoot(input);
  return {
    root,
    manifest: path.resolve(root, 'runtime-manifest.json'),
    pythonPath: resolveContainedPath(root, manifest.pythonRelativePath, 'Python path'),
    applicationPath: resolveContainedPath(root, manifest.appRelativePath, 'application path'),
    sitePackagesPath: resolveContainedPath(
      root,
      manifest.sitePackagesRelativePath,
      'site-packages path',
    ),
    filePaths: manifest.files.map((file, index) =>
      resolveContainedPath(root, file.path, `file inventory path ${index}`),
    ),
  };
}
