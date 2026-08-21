import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function requireUsableExecutable(executable, label) {
  let metadata;
  try {
    metadata = await lstat(executable);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${executable}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${executable}`);
  }
  if (metadata.size === 0) {
    throw new Error(`${label} is empty: ${executable}`);
  }
  return executable;
}

export async function resolveBuildUvExecutable({ repositoryRoot, environment }) {
  const explicit = environment.UV_BINARY?.trim();
  if (explicit) {
    if (path.isAbsolute(explicit) || explicit.includes('/') || explicit.includes('\\')) {
      return requireUsableExecutable(path.resolve(repositoryRoot, explicit), 'Configured uv executable');
    }
    return explicit;
  }

  const repositoryUv = path.join(repositoryRoot, '.tmp-uv', 'uv.exe');
  try {
    return await requireUsableExecutable(repositoryUv, 'Repository uv executable');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Repository uv executable does not exist: ${repositoryUv}`
    ) {
      return 'uv';
    }
    throw error;
  }
}

export function createSimpleBuildInvocations(repositoryRoot, nodeExecutable = process.execPath) {
  const forgeCli = path.join(
    repositoryRoot,
    'node_modules',
    '@electron-forge',
    'cli',
    'dist',
    'electron-forge.js',
  );
  const nodeCommand = (...args) => ({ command: nodeExecutable, args });
  return {
    verifyRuntime: nodeCommand(
      path.join(repositoryRoot, 'scripts', 'agentscope-runtime', 'verify.mjs'),
    ),
    buildRuntime: nodeCommand(
      path.join(repositoryRoot, 'scripts', 'agentscope-runtime', 'build.mjs'),
    ),
    packageApplication: nodeCommand(forgeCli, 'package'),
    verifyPackage: nodeCommand(
      path.join(repositoryRoot, 'scripts', 'verify-package-contents.mjs'),
    ),
    makeZip: nodeCommand(forgeCli, 'make', '--skip-package'),
  };
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `Build command was terminated by ${signal}.`
          : `Build command failed with exit code ${String(code)}.`,
      ));
    });
  });
}

async function collectZipArtifacts(root) {
  const artifacts = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        artifacts.push(absolute);
      }
    }
  };
  await visit(root);
  return artifacts.sort((left, right) => left.localeCompare(right, 'en'));
}

export function isDirectCliInvocation(moduleUrl, argvEntry, platform = process.platform) {
  if (!argvEntry) return false;
  const modulePath = path.resolve(fileURLToPath(moduleUrl));
  const invokedPath = path.resolve(argvEntry);
  return platform === 'win32'
    ? modulePath.toLowerCase() === invokedPath.toLowerCase()
    : modulePath === invokedPath;
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const uvExecutable = await resolveBuildUvExecutable({
    repositoryRoot,
    environment: process.env,
  });
  const buildEnvironment = {
    ...process.env,
    UV_BINARY: uvExecutable,
  };

  console.log(`[1/4] Checking build tools (${uvExecutable})...`);
  try {
    await runCommand(uvExecutable, ['--version'], {
      cwd: repositoryRoot,
      env: buildEnvironment,
    });
  } catch (error) {
    throw new Error(
      'A working uv executable is required. Install uv or place uv.exe in .tmp-uv.',
      { cause: error },
    );
  }

  const invocations = createSimpleBuildInvocations(repositoryRoot);
  console.log('[2/4] Checking the embedded AgentScope runtime...');
  try {
    await runCommand(invocations.verifyRuntime.command, invocations.verifyRuntime.args, {
      cwd: repositoryRoot,
      env: buildEnvironment,
    });
    console.log('Using the existing verified AgentScope runtime.');
  } catch {
    console.log('AgentScope runtime is missing or invalid; rebuilding it now...');
    await runCommand(invocations.buildRuntime.command, invocations.buildRuntime.args, {
      cwd: repositoryRoot,
      env: buildEnvironment,
    });
    await runCommand(invocations.verifyRuntime.command, invocations.verifyRuntime.args, {
      cwd: repositoryRoot,
      env: buildEnvironment,
    });
  }

  console.log('[3/4] Packaging Private AI Desktop...');
  await runCommand(invocations.packageApplication.command, invocations.packageApplication.args, {
    cwd: repositoryRoot,
    env: buildEnvironment,
  });
  await runCommand(invocations.verifyPackage.command, invocations.verifyPackage.args, {
    cwd: repositoryRoot,
    env: buildEnvironment,
  });
  await runCommand(invocations.makeZip.command, invocations.makeZip.args, {
    cwd: repositoryRoot,
    env: buildEnvironment,
  });

  const artifacts = await collectZipArtifacts(path.join(repositoryRoot, 'out', 'make'));
  if (artifacts.length === 0) {
    throw new Error('Build completed without a ZIP artifact in out\\make.');
  }

  console.log('[4/4] Build completed.');
  for (const artifact of artifacts) {
    console.log(`Output: ${artifact}`);
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
