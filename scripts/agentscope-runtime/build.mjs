import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_VERSIONS,
  verifyRuntimeArtifact,
} from './verify.mjs';

const execFileAsync = promisify(execFile);
export const UV_PYTHON_INSTALL_TIMEOUT_MS = 30_000;
const FORBIDDEN_SEGMENTS = new Set([
  '.cache',
  '.git',
  '__pycache__',
  'cache',
  'caches',
  'ensurepip',
  'installer',
  'installers',
  'pip',
  'test',
  'tests',
  'uv',
  'uv-cache',
  'wheel',
  'wheels',
]);

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function repositoryRootFromModule(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function resolveRuntimeTarget(platform, arch) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Unsupported embedded runtime target: ${platform}-${arch}.`);
  }
  return { platform: 'win32', arch: 'x64' };
}

export function resolveBuildPaths(repositoryRootInput, processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error('AgentScope runtime build process id must be a positive safe integer.');
  }
  const repositoryRoot = path.resolve(repositoryRootInput);
  const resourcesRoot = path.join(repositoryRoot, 'resources');
  return {
    repositoryRoot,
    resourcesRoot,
    outputRoot: path.join(resourcesRoot, 'agentscope-runtime'),
    stagingRoot: path.join(resourcesRoot, `.agentscope-runtime-staging-${processId}`),
    previousRoot: path.join(resourcesRoot, `.agentscope-runtime-staging-${processId}-previous`),
  };
}

export function assertSafeRuntimeOutput(candidateInput, repositoryRootInput = repositoryRootFromModule()) {
  if (typeof candidateInput !== 'string' || candidateInput.trim() === '') {
    throw new Error('Unsafe runtime output: path is unresolved.');
  }
  const repositoryRoot = path.resolve(repositoryRootInput);
  const resourcesRoot = path.join(repositoryRoot, 'resources');
  const candidate = path.resolve(candidateInput);
  if (candidate === repositoryRoot || candidate === resourcesRoot) {
    throw new Error(`Unsafe runtime output: ${candidate}`);
  }
  const relative = path.relative(resourcesRoot, candidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`Unsafe runtime output: ${candidate}`);
  }
  if (
    relative !== 'agentscope-runtime' &&
    !/^\.agentscope-runtime-staging-[1-9]\d*(?:-previous)?$/.test(relative)
  ) {
    throw new Error(`Unsafe runtime output: ${candidate}`);
  }
  return candidate;
}

export function isForbiddenRuntimePath(relativePath) {
  const portable = String(relativePath).replaceAll('\\', '/').toLowerCase();
  const segments = portable.split('/');
  const name = segments.at(-1) ?? '';
  return (
    (segments[0] === 'site-packages' && segments[1] === 'bin') ||
    segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name === 'requirements.lock' ||
    name.endsWith('.key') ||
    name.endsWith('.pem') ||
    name.endsWith('.pth') ||
    name.endsWith('.pyc') ||
    name.endsWith('.pyo') ||
    name.endsWith('.whl') ||
    name.endsWith('.msi') ||
    name === 'uv.exe' ||
    name === 'uvx.exe' ||
    name === 'pip.exe' ||
    /(?:^|[-_.])installer(?:[-_.]|$)/.test(name)
  );
}

function isDistInfoRecordPath(relativePath) {
  const portable = String(relativePath).replaceAll('\\', '/').toLowerCase();
  const segments = portable.split('/');
  return segments.at(-1) === 'record' &&
    segments.slice(0, -1).some((segment) => segment.endsWith('.dist-info'));
}

export function canonicalizeDistInfoRecordText(text) {
  const rows = String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  while (rows.at(-1) === '') {
    rows.pop();
  }
  const canonicalRows = rows.map((row) => {
    const firstComma = row.indexOf(',');
    const recordPath = firstComma >= 0 ? row.slice(0, firstComma) : row;
    return /^bin\/[^,\r\n]+\.exe$/i.test(recordPath) ? `${recordPath},,` : row;
  });
  return `${canonicalRows.sort(comparePortablePaths).join('\n')}\n`;
}

export function validateManagedPythonFallback(input) {
  const managedRoot = path.resolve(input.managedRoot);
  const foundPythonPath = path.resolve(input.foundPythonPath);
  const relative = path.relative(managedRoot, foundPythonPath);
  const segments = relative.split(path.sep);
  const machine = String(input.machine).toLowerCase();
  const invalidReason =
    path.parse(managedRoot).root === managedRoot ? 'managed root is a filesystem root' :
    relative === '' ? 'interpreter equals the managed root' :
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? 'interpreter is outside the managed root' :
    segments.length !== 2 ? 'interpreter is not a direct installation child' :
    segments[0] !== 'cpython-3.11.16-windows-x86_64-none' ? 'installation name is not pinned' :
    segments[1].toLowerCase() !== 'python.exe' ? 'interpreter name is not python.exe' :
    input.version !== RUNTIME_VERSIONS.pythonVersion ? `version is ${String(input.version)}` :
    input.platform !== RUNTIME_VERSIONS.platform ? `platform is ${String(input.platform)}` :
    machine !== 'amd64' && machine !== 'x86_64' && machine !== 'win-amd64'
      ? `machine is ${String(input.machine)}` :
    input.pointerBits !== 64 ? `pointer width is ${String(input.pointerBits)}` :
    '';
  if (invalidReason) {
    throw new Error(
      `Managed CPython fallback must be exact uv-managed CPython 3.11.16 win32-x64 (${invalidReason}).`,
    );
  }
  return {
    sourceRoot: path.dirname(foundPythonPath),
    installationName: segments[0],
  };
}

function canonicalNativePath(candidate) {
  const normalized = path.normalize(candidate);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function removeTreeEntryNoFollow(candidate) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await unlink(candidate);
    return;
  }
  const resolved = await realpath(candidate);
  if (canonicalNativePath(resolved) !== canonicalNativePath(path.resolve(candidate))) {
    throw new Error(`Cannot safely unlink an unknown reparse point: ${candidate}`);
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(candidate);
    for (const entry of entries) {
      await removeTreeEntryNoFollow(path.join(candidate, entry));
    }
    await rmdir(candidate);
    return;
  }
  if (metadata.isFile()) {
    await unlink(candidate);
    return;
  }
  throw new Error(`Cannot safely clean a non-file runtime entry: ${candidate}`);
}

export async function removeContainedDirectoryNoFollow(candidateInput, containmentRootInput) {
  const candidate = path.resolve(candidateInput);
  const containmentRoot = path.resolve(containmentRootInput);
  const relative = path.relative(containmentRoot, candidate);
  if (
    path.parse(containmentRoot).root === containmentRoot ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    relative !== 'python-install'
  ) {
    throw new Error(`Unsafe contained cleanup target: ${candidate}`);
  }
  await assertNotReparsePoint(containmentRoot, 'Contained cleanup parent');
  if (!await pathExists(candidate)) {
    return;
  }
  await assertNotReparsePoint(candidate, 'Contained cleanup root');
  await removeTreeEntryNoFollow(candidate);
}

async function assertNotReparsePoint(candidate, label) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink or reparse point.`);
  }
  const resolved = await realpath(candidate);
  if (canonicalNativePath(resolved) !== canonicalNativePath(path.resolve(candidate))) {
    throw new Error(`${label} must not resolve through a symlink or reparse point.`);
  }
  return metadata;
}

async function assertSafeBuildRoots(paths) {
  if (path.parse(paths.repositoryRoot).root === paths.repositoryRoot) {
    throw new Error('Repository root must not be a filesystem root.');
  }
  const repositoryMetadata = await assertNotReparsePoint(paths.repositoryRoot, 'Repository root');
  if (!repositoryMetadata.isDirectory()) {
    throw new Error('Repository root must be a directory.');
  }
  await mkdir(paths.resourcesRoot, { recursive: true });
  const resourcesMetadata = await assertNotReparsePoint(paths.resourcesRoot, 'Resources root');
  if (!resourcesMetadata.isDirectory()) {
    throw new Error('Resources root must be a directory.');
  }
  for (const candidate of [paths.outputRoot, paths.stagingRoot, paths.previousRoot]) {
    assertSafeRuntimeOutput(candidate, paths.repositoryRoot);
  }
}

async function removeRuntimePath(candidate, repositoryRoot) {
  const safePath = assertSafeRuntimeOutput(candidate, repositoryRoot);
  if (!await pathExists(safePath)) {
    return;
  }
  await assertNotReparsePoint(safePath, 'Runtime cleanup target');
  await removeTreeEntryNoFollow(safePath);
}

function isolatedEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  for (const key of [
    'CONDA_PREFIX',
    'PYTHONHOME',
    'PYTHONPATH',
    'VIRTUAL_ENV',
    'UV_PYTHON',
    'UV_PYTHON_INSTALL_DIR',
  ]) {
    delete environment[key];
  }
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.PYTHONUTF8 = '1';
  environment.PYTHONUNBUFFERED = '1';
  return environment;
}

async function runCommand(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      killSignal: 'SIGTERM',
      windowsHide: true,
    });
  } catch (error) {
    const timedOut = Number.isFinite(options.timeoutMs) &&
      error && typeof error === 'object' && error.killed === true;
    if (timedOut) {
      throw new Error(
        `${path.basename(executable)} ${args[0] ?? ''} timed out after ${options.timeoutMs}ms.`,
      );
    }
    const stderr = error && typeof error === 'object' && typeof error.stderr === 'string'
      ? error.stderr.trim().slice(-4000)
      : '';
    throw new Error(
      `${path.basename(executable)} ${args[0] ?? ''} failed${stderr ? `: ${stderr}` : '.'}`,
    );
  }
}

async function findFilesByName(root, expectedName, current = root) {
  const matches = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const metadata = await assertNotReparsePoint(absolute, `Python installation entry ${absolute}`);
    if (metadata.isDirectory()) {
      matches.push(...await findFilesByName(root, expectedName, absolute));
    } else if (metadata.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) {
      matches.push(absolute);
    }
  }
  return matches;
}

async function resolveBundledPython(pythonInstallRoot) {
  const candidates = await findFilesByName(pythonInstallRoot, 'python.exe');
  const exact = [];
  for (const candidate of candidates) {
    const { stdout } = await runCommand(
      candidate,
      ['-I', '-c', "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
      { cwd: pythonInstallRoot, env: isolatedEnvironment({}) },
    );
    if (stdout.trim() === RUNTIME_VERSIONS.pythonVersion) {
      exact.push(candidate);
    }
  }
  if (exact.length !== 1) {
    throw new Error(
      `Expected exactly one bundled CPython ${RUNTIME_VERSIONS.pythonVersion} interpreter; found ${exact.length}.`,
    );
  }
  return exact[0];
}

async function inspectPythonInterpreter(pythonPath, cwd) {
  const code = [
    'import json, struct, sys, sysconfig',
    "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'platform': sys.platform, 'machine': sysconfig.get_platform(), 'pointerBits': struct.calcsize('P') * 8}))",
  ].join('; ');
  const { stdout } = await runCommand(
    pythonPath,
    ['-I', '-c', code],
    { cwd, env: isolatedEnvironment({}) },
  );
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error('Managed CPython fallback returned invalid interpreter facts.');
  }
}

async function copyDirectoryTree(sourceRoot, destinationRoot, current = sourceRoot) {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(current, entry.name);
    const relative = path.relative(sourceRoot, source);
    const metadata = await assertNotReparsePoint(source, `Managed Python entry ${relative}`);
    const destination = path.join(destinationRoot, relative);
    if (metadata.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyDirectoryTree(sourceRoot, destinationRoot, source);
    } else if (metadata.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new Error(`Managed Python entry must be a regular file or directory: ${relative}`);
    }
  }
}

async function provisionManagedPythonFallback(
  uvExecutable,
  pythonInstallRoot,
  repositoryRoot,
  toolEnvironment,
) {
  const fallbackEnvironment = isolatedEnvironment(toolEnvironment);
  fallbackEnvironment.UV_MANAGED_PYTHON = '1';
  fallbackEnvironment.UV_PYTHON_DOWNLOADS = 'never';
  delete fallbackEnvironment.UV_PYTHON;
  delete fallbackEnvironment.UV_PYTHON_INSTALL_DIR;

  const [{ stdout: managedRootOutput }, { stdout: pythonPathOutput }] = await Promise.all([
    runCommand(uvExecutable, [
      'python',
      'dir',
      '--managed-python',
      '--no-python-downloads',
    ], { cwd: repositoryRoot, env: fallbackEnvironment }),
    runCommand(uvExecutable, [
      'python',
      'find',
      '--managed-python',
      '--no-python-downloads',
      '--no-project',
      '--resolve-links',
      RUNTIME_VERSIONS.pythonVersion,
    ], { cwd: repositoryRoot, env: fallbackEnvironment }),
  ]);
  const managedRoot = path.resolve(managedRootOutput.trim());
  const foundPythonPath = path.resolve(pythonPathOutput.trim());
  await assertNotReparsePoint(managedRoot, 'uv-managed Python root');
  await assertNotReparsePoint(foundPythonPath, 'uv-managed Python interpreter');
  const facts = await inspectPythonInterpreter(foundPythonPath, managedRoot);
  const fallback = validateManagedPythonFallback({
    managedRoot,
    foundPythonPath,
    ...facts,
  });
  await assertNotReparsePoint(fallback.sourceRoot, 'uv-managed CPython installation');
  const destinationRoot = path.join(pythonInstallRoot, fallback.installationName);
  await copyDirectoryTree(fallback.sourceRoot, destinationRoot);
  const copiedPythonPath = path.join(destinationRoot, 'python.exe');
  const copiedFacts = await inspectPythonInterpreter(copiedPythonPath, destinationRoot);
  validateManagedPythonFallback({
    managedRoot: pythonInstallRoot,
    foundPythonPath: copiedPythonPath,
    ...copiedFacts,
  });
  return copiedPythonPath;
}

async function copyApplicationTree(sourceRoot, destinationRoot, current = sourceRoot) {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(current, entry.name);
    const relative = path.relative(sourceRoot, source).split(path.sep).join('/');
    const metadata = await assertNotReparsePoint(source, `Application source ${relative}`);
    if (isForbiddenRuntimePath(relative)) {
      continue;
    }
    const destination = path.join(destinationRoot, ...relative.split('/'));
    if (metadata.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyApplicationTree(sourceRoot, destinationRoot, source);
    } else if (metadata.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new Error(`Application source must be a regular file or directory: ${relative}`);
    }
  }
}

async function cleanGeneratedRuntime(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = await assertNotReparsePoint(absolute, `Generated runtime entry ${relative}`);
    if (isForbiddenRuntimePath(relative)) {
      await removeTreeEntryNoFollow(absolute);
      continue;
    }
    if (metadata.isDirectory()) {
      await cleanGeneratedRuntime(root, absolute);
    } else if (!metadata.isFile()) {
      throw new Error(`Generated runtime entry must be a regular file or directory: ${relative}`);
    }
  }
}

async function canonicalizeGeneratedInstallerRecords(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = await assertNotReparsePoint(absolute, `Generated runtime entry ${relative}`);
    if (metadata.isDirectory()) {
      await canonicalizeGeneratedInstallerRecords(root, absolute);
    } else if (metadata.isFile() && isDistInfoRecordPath(relative)) {
      const content = await readFile(absolute, 'utf8');
      await writeFile(absolute, canonicalizeDistInfoRecordText(content), 'utf8');
    } else if (!metadata.isFile()) {
      throw new Error(`Generated runtime entry must be a regular file or directory: ${relative}`);
    }
  }
}

async function inventoryRuntimeFiles(root, current = root) {
  const inventory = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => comparePortablePaths(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = await assertNotReparsePoint(absolute, `Runtime inventory entry ${relative}`);
    if (metadata.isDirectory()) {
      inventory.push(...await inventoryRuntimeFiles(root, absolute));
    } else if (metadata.isFile()) {
      if (relative !== 'runtime-manifest.json') {
        const content = await readFile(absolute);
        inventory.push({
          path: relative,
          sha256: createHash('sha256').update(content).digest('hex'),
          size: metadata.size,
        });
      }
    } else {
      throw new Error(`Runtime inventory entry must be a regular file: ${relative}`);
    }
  }
  return inventory.sort((left, right) => comparePortablePaths(left.path, right.path));
}

async function replaceRuntimeArtifact(paths) {
  await removeRuntimePath(paths.previousRoot, paths.repositoryRoot);
  const hadPreviousOutput = await pathExists(paths.outputRoot);
  if (hadPreviousOutput) {
    await assertNotReparsePoint(paths.outputRoot, 'Existing runtime output');
    await rename(paths.outputRoot, paths.previousRoot);
  }
  try {
    await rename(paths.stagingRoot, paths.outputRoot);
  } catch (error) {
    if (hadPreviousOutput && await pathExists(paths.previousRoot) && !await pathExists(paths.outputRoot)) {
      await rename(paths.previousRoot, paths.outputRoot);
    }
    throw error;
  }
  if (hadPreviousOutput) {
    await removeRuntimePath(paths.previousRoot, paths.repositoryRoot);
  }
}

function resolveUvExecutable(repositoryRoot, environment) {
  if (typeof environment.UV_BINARY === 'string' && environment.UV_BINARY.trim() !== '') {
    return path.resolve(environment.UV_BINARY);
  }
  return 'uv';
}

export async function buildRuntimeArtifact(options = {}) {
  resolveRuntimeTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? repositoryRootFromModule());
  const paths = resolveBuildPaths(repositoryRoot, options.processId ?? process.pid);
  await assertSafeBuildRoots(paths);
  await removeRuntimePath(paths.stagingRoot, repositoryRoot);
  await removeRuntimePath(paths.previousRoot, repositoryRoot);
  await mkdir(paths.stagingRoot);

  const uvExecutable = resolveUvExecutable(repositoryRoot, options.environment ?? process.env);
  const pythonInstallRoot = path.join(paths.stagingRoot, 'python-install');
  const sitePackagesRoot = path.join(paths.stagingRoot, 'site-packages');
  const applicationRoot = path.join(paths.stagingRoot, 'app');
  const requirementsPath = path.join(paths.stagingRoot, 'requirements.lock');
  const uvCacheRoot = path.join(paths.stagingRoot, 'uv-cache');
  const projectRoot = path.join(repositoryRoot, 'agentscope-runtime');
  const sourceRoot = path.join(projectRoot, 'src', 'private_ai_agentscope');
  const toolEnvironment = isolatedEnvironment(options.environment ?? process.env);
  toolEnvironment.UV_CACHE_DIR = uvCacheRoot;

  try {
    let provisioning = 'uv-install';
    let pythonPath;
    try {
      await runCommand(uvExecutable, [
        'python',
        'install',
        RUNTIME_VERSIONS.pythonVersion,
        '--install-dir',
        pythonInstallRoot,
        '--no-bin',
        '--no-registry',
      ], {
        cwd: repositoryRoot,
        env: toolEnvironment,
        timeoutMs: UV_PYTHON_INSTALL_TIMEOUT_MS,
      });
      pythonPath = await resolveBundledPython(pythonInstallRoot);
    } catch (installError) {
      provisioning = 'uv-managed-copy-fallback';
      await removeContainedDirectoryNoFollow(pythonInstallRoot, paths.stagingRoot);
      pythonPath = await provisionManagedPythonFallback(
        uvExecutable,
        pythonInstallRoot,
        repositoryRoot,
        toolEnvironment,
      );
      if (!pythonPath) {
        throw installError;
      }
    }
    const exactUvEnvironment = {
      ...toolEnvironment,
      UV_MANAGED_PYTHON: '1',
      UV_PYTHON: pythonPath,
      UV_PYTHON_DOWNLOADS: 'never',
      UV_PYTHON_INSTALL_DIR: pythonInstallRoot,
    };
    await runCommand(uvExecutable, [
      'export',
      '--project',
      projectRoot,
      '--locked',
      '--no-dev',
      '--format',
      'requirements-txt',
      '--no-emit-project',
      '--output-file',
      requirementsPath,
    ], { cwd: repositoryRoot, env: exactUvEnvironment });
    await runCommand(uvExecutable, [
      'pip',
      'install',
      '--python',
      pythonPath,
      '--target',
      sitePackagesRoot,
      '--requirements',
      requirementsPath,
      '--strict',
      '--link-mode',
      'copy',
      '--no-python-downloads',
    ], { cwd: repositoryRoot, env: exactUvEnvironment });

    await copyApplicationTree(sourceRoot, path.join(applicationRoot, 'private_ai_agentscope'));
    await canonicalizeGeneratedInstallerRecords(paths.stagingRoot);
    await cleanGeneratedRuntime(paths.stagingRoot);

    const pythonRelativePath = path.relative(paths.stagingRoot, pythonPath).split(path.sep).join('/');
    const files = await inventoryRuntimeFiles(paths.stagingRoot);
    const manifest = {
      schemaVersion: RUNTIME_VERSIONS.schemaVersion,
      platform: RUNTIME_VERSIONS.platform,
      arch: RUNTIME_VERSIONS.arch,
      pythonVersion: RUNTIME_VERSIONS.pythonVersion,
      agentScopeVersion: RUNTIME_VERSIONS.agentScopeVersion,
      protocolVersion: RUNTIME_VERSIONS.protocolVersion,
      pythonRelativePath,
      appRelativePath: 'app',
      sitePackagesRelativePath: 'site-packages',
      files,
    };
    await writeFile(
      path.join(paths.stagingRoot, 'runtime-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );

    const verification = await verifyRuntimeArtifact(paths.stagingRoot);
    await replaceRuntimeArtifact(paths);
    return { ...verification, root: paths.outputRoot, provisioning };
  } catch (error) {
    try {
      await removeRuntimePath(paths.stagingRoot, repositoryRoot);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime build and safe staging cleanup failed.');
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await buildRuntimeArtifact();
    console.log(
      `AgentScope runtime built: files=${result.inventory.files} ` +
      `python=${result.versions.pythonVersion} agentscope=${result.versions.agentScopeVersion} ` +
      `runtime=${result.versions.runtimeVersion} provisioning=${result.provisioning} ` +
      `manifestSha256=${result.manifestSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
