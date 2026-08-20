import { listPackage } from '@electron/asar';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRuntimeManifest,
  verifyRuntimeArtifact,
} from './agentscope-runtime/verify.mjs';

export const MAX_ASAR_BYTES = 2 * 1024 * 1024;

const allowedAsarEntry = /^(?:package\.json|\.vite(?:\/|$))/;
const requiredAsarFiles = [
  'package.json',
  '.vite/build/main.js',
  '.vite/build/preload.js',
  '.vite/build/worker.js',
  '.vite/renderer/main_window/index.html',
];
const forbiddenOuterSegments = new Set([
  '.electron-cache',
  '.git',
  '.github',
  '.superpowers',
  'app.asar.unpacked',
  'coverage',
  'docs',
  'model-runtime',
  'models',
  'node_modules',
  'playwright-report',
  'src',
  'test-results',
  'tests',
]);
const allowedOuterRootFiles = new Set([
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'LICENSE',
  'LICENSES.chromium.html',
  'Private AI Desktop.exe',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'version',
  'vk_swiftshader_icd.json',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
]);
const localeFile = /^locales\/[a-z]{2,3}(?:-(?:[A-Z]{2}|[0-9]{3}))?\.pak$/;
const runtimeOuterPrefix = 'resources/agentscope-runtime/';
const forbiddenRuntimeSecretNames = new Set([
  '.secret',
  '.secrets',
  'credentials.json',
  'credentials.toml',
  'credentials.yaml',
  'credentials.yml',
  'secret.json',
  'secret.toml',
  'secret.yaml',
  'secret.yml',
  'token.txt',
]);

function normalizeInventoryPath(candidate) {
  return String(candidate).replaceAll('\\', '/').replace(/^\/+/, '');
}

function allowsManifestBackedDependencySource(file, forbiddenSegments) {
  return forbiddenSegments.length > 0 &&
    forbiddenSegments.every((segment) => segment === 'src') &&
    /^resources\/agentscope-runtime\/site-packages\/(?:[^/]+\/)+src\/[^/]+/.test(file);
}

export function validateAsarInventory(entries, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ASAR_BYTES) {
    throw new Error(`ASAR size limit exceeded: ${bytes} bytes (limit ${MAX_ASAR_BYTES}).`);
  }

  const normalized = entries.map(normalizeInventoryPath);
  const forbidden = normalized.find((entry) => !allowedAsarEntry.test(entry));
  if (forbidden) {
    throw new Error(`Forbidden ASAR entry: ${forbidden}`);
  }
  for (const required of requiredAsarFiles) {
    if (!normalized.includes(required)) {
      throw new Error(`Required packaged runtime entry is missing: ${required}`);
    }
  }
  return { entries: normalized.length, bytes };
}

export function validateOuterInventory(files, runtimeManifestFiles = []) {
  const normalized = files.map(normalizeInventoryPath);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Outer-package inventory contains duplicate paths.');
  }
  const allowedRuntimeFiles = new Set(runtimeManifestFiles.length > 0 ? [
    `${runtimeOuterPrefix}runtime-manifest.json`,
    ...runtimeManifestFiles.map((file) => {
      const relativePath = typeof file === 'string' ? file : file?.path;
      return `${runtimeOuterPrefix}${normalizeInventoryPath(relativePath)}`;
    }),
  ] : []);
  for (const file of normalized) {
    const isAllowedRuntimeFile = allowedRuntimeFiles.has(file);
    const segments = file.toLowerCase().split('/');
    const name = segments.at(-1) ?? '';
    const forbiddenSegments = segments.filter((segment) => forbiddenOuterSegments.has(segment));
    if (
      name === '.env' ||
      name.startsWith('.env.') ||
      name.endsWith('.gguf') ||
      (
        forbiddenSegments.length > 0 &&
        !(
          isAllowedRuntimeFile &&
          allowsManifestBackedDependencySource(file, forbiddenSegments)
        )
      )
    ) {
      throw new Error(`Forbidden outer-package file: ${file}`);
    }
    const allowed = allowedOuterRootFiles.has(file) ||
      localeFile.test(file) ||
      file === 'resources/app.asar' ||
      isAllowedRuntimeFile;
    if (!allowed) {
      throw new Error(`Unexpected outer-package file: ${file}`);
    }
  }
  if (!normalized.includes('resources/app.asar')) {
    throw new Error('Packaged application is missing resources/app.asar.');
  }
  if (runtimeManifestFiles.length > 0) {
    for (const required of allowedRuntimeFiles) {
      if (!normalized.includes(required)) {
        throw new Error(`Manifest-backed runtime file is missing from package: ${required}`);
      }
    }
  }
  return { files: normalized.length };
}

function canonicalNativePath(candidate) {
  const normalized = path.normalize(candidate);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertRealPathContained(rootRealPath, candidateRealPath, label) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes the outer package root.`);
  }
}

async function inspectOuterEntry(rootRealPath, candidate, label) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink or reparse point.`);
  }
  const resolved = await realpath(candidate);
  assertRealPathContained(rootRealPath, resolved, label);
  if (canonicalNativePath(resolved) !== canonicalNativePath(path.resolve(candidate))) {
    throw new Error(`${label} must not resolve through a symlink or reparse point.`);
  }
  return metadata;
}

async function enumerateOuterDirectory(root, rootRealPath, current) {
  const results = [];
  const entries = await readdir(current);
  entries.sort((left, right) => left.localeCompare(right, 'en'));
  for (const entry of entries) {
    const absolute = path.join(current, entry);
    const relative = normalizeInventoryPath(path.relative(root, absolute));
    const metadata = await inspectOuterEntry(rootRealPath, absolute, `Outer-package entry ${relative}`);
    if (metadata.isDirectory()) {
      results.push(...await enumerateOuterDirectory(root, rootRealPath, absolute));
    } else if (metadata.isFile()) {
      results.push(normalizeInventoryPath(path.relative(root, absolute)));
    } else {
      throw new Error(`Outer-package entry must be a regular file or directory: ${relative}`);
    }
  }
  return results;
}

export async function enumerateOuterFiles(root) {
  const packageRoot = path.resolve(root);
  const rootMetadata = await lstat(packageRoot);
  if (rootMetadata.isSymbolicLink()) {
    throw new Error('Outer package root must not be a symlink or reparse point.');
  }
  if (!rootMetadata.isDirectory()) {
    throw new Error('Outer package root must be a directory.');
  }
  const rootRealPath = await realpath(packageRoot);
  if (canonicalNativePath(rootRealPath) !== canonicalNativePath(packageRoot)) {
    throw new Error('Outer package root must not resolve through a symlink or reparse point.');
  }
  return enumerateOuterDirectory(packageRoot, rootRealPath, packageRoot);
}

export async function verifyPackagedAgentScopeRuntime(packageRoot, options = {}) {
  const resourcesRoot = path.join(path.resolve(packageRoot), 'resources');
  const asarPath = path.join(resourcesRoot, 'app.asar');
  const asarMetadata = await lstat(asarPath);
  if (!asarMetadata.isFile() || asarMetadata.isSymbolicLink()) {
    throw new Error('Packaged application resources/app.asar must be a regular file.');
  }

  const runtimeRoot = path.join(resourcesRoot, 'agentscope-runtime');
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const manifestBefore = await readFile(manifestPath);
  let manifest;
  try {
    manifest = parseRuntimeManifest(JSON.parse(manifestBefore.toString('utf8')));
  } catch (error) {
    throw new Error(
      `Packaged AgentScope runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const secretFile = manifest.files.find((file) => {
    const name = file.path.split('/').at(-1)?.toLowerCase() ?? '';
    return forbiddenRuntimeSecretNames.has(name);
  });
  if (secretFile) {
    throw new Error(`Secret or credential file is forbidden in packaged runtime: ${secretFile.path}`);
  }
  const verified = await verifyRuntimeArtifact(runtimeRoot, options);
  const manifestAfter = await readFile(manifestPath);
  if (!manifestBefore.equals(manifestAfter)) {
    throw new Error('Packaged AgentScope runtime manifest changed during verification.');
  }
  return { ...verified, manifest };
}

export async function verifyPackagedApp(projectRoot = process.cwd(), options = {}) {
  const packageRoot = path.join(
    projectRoot,
    'out',
    `Private AI Desktop-${process.platform}-${process.arch}`,
  );
  const outerFiles = await enumerateOuterFiles(packageRoot);
  const runtime = await verifyPackagedAgentScopeRuntime(packageRoot, options);
  const outer = validateOuterInventory(outerFiles, runtime.manifest.files);
  const asarPath = path.join(packageRoot, 'resources', 'app.asar');
  const asarStat = await stat(asarPath);
  const asarEntries = listPackage(asarPath);
  const asar = validateAsarInventory(asarEntries, asarStat.size);
  return { packageRoot, outer, asar, runtime };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await verifyPackagedApp();
    console.log(
      `Package content verified: outerFiles=${result.outer.files} ` +
      `asarEntries=${result.asar.entries} asarBytes=${result.asar.bytes} ` +
      `agentScopeFiles=${result.runtime.inventory.files} ` +
      `agentScopeManifestSha256=${result.runtime.manifestSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
