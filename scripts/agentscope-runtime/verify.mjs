import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const BUNDLED_INTERPRETER_TIMEOUT_MS = 15_000;

export async function executeFileBounded(executable, args, options = {}) {
  const { timeoutMs = BUNDLED_INTERPRETER_TIMEOUT_MS, ...execOptions } = options;
  try {
    return await execFileAsync(executable, args, {
      ...execOptions,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    const wasKilled = error && typeof error === 'object' &&
      (error.killed === true || error.signal === 'SIGKILL');
    if (wasKilled) {
      throw new Error(`Bundled interpreter verification timed out after ${timeoutMs}ms.`);
    }
    throw error;
  }
}

export const RUNTIME_VERSIONS = Object.freeze({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  pythonVersion: '3.11.16',
  agentScopeVersion: '2.0.6',
  protocolVersion: '1',
  runtimeVersion: '1.0.0',
});

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
];
const FILE_KEYS = ['path', 'sha256', 'size'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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

export function containsPrivateKeyMaterial(text) {
  const begin = /^-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----\s*$/m.exec(text);
  if (!begin) {
    return false;
  }
  const remainder = text.slice((begin.index ?? 0) + begin[0].length);
  const endPattern = new RegExp(`^-----END ${begin[1]}-----\\s*$`, 'm');
  const end = endPattern.exec(remainder);
  if (!end) {
    return false;
  }
  return remainder
    .slice(0, end.index)
    .split(/\r?\n/)
    .some((line) => /^[A-Za-z0-9+/=]{16,}$/.test(line.trim()));
}

export function containsBuildPathLeak(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return bytes.includes(Buffer.from('.agentscope-runtime-staging-', 'utf8'));
}

function isDistInfoRecordPath(relativePath) {
  const portable = String(relativePath).replaceAll('\\', '/').toLowerCase();
  const segments = portable.split('/');
  return segments.at(-1) === 'record' &&
    segments.slice(0, -1).some((segment) => segment.endsWith('.dist-info'));
}

function canonicalizeDistInfoRecordText(text) {
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

export function isCanonicalDistInfoRecordText(text) {
  return String(text) === canonicalizeDistInfoRecordText(text);
}

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(record, keys, label) {
  const actual = Object.keys(record).sort(comparePortablePaths);
  const expected = [...keys].sort(comparePortablePaths);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`);
  }
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be exactly ${JSON.stringify(expected)}.`);
  }
  return expected;
}

function requireContainedRelativePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty contained relative path.`);
  }
  const portable = value.replaceAll('\\', '/');
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${label} must be a contained relative path.`);
  }
  const normalized = path.posix.normalize(portable);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== portable ||
    normalized.endsWith('/')
  ) {
    throw new Error(`${label} must be a canonical contained relative path.`);
  }
  return normalized;
}

function isForbiddenRuntimePath(relativePath) {
  const portable = relativePath.replaceAll('\\', '/').toLowerCase();
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

export function parseRuntimeManifest(input) {
  const manifest = requireRecord(input, 'AgentScope runtime manifest');
  requireExactKeys(manifest, MANIFEST_KEYS, 'AgentScope runtime manifest');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('AgentScope runtime manifest files must be a non-empty array.');
  }

  const files = manifest.files.map((candidate, index) => {
    const file = requireRecord(candidate, `AgentScope runtime manifest file ${index}`);
    requireExactKeys(file, FILE_KEYS, `AgentScope runtime manifest file ${index}`);
    const filePath = requireContainedRelativePath(
      file.path,
      `AgentScope runtime manifest file ${index} path`,
    );
    if (filePath === 'runtime-manifest.json') {
      throw new Error('runtime-manifest.json must not inventory itself.');
    }
    if (isForbiddenRuntimePath(filePath)) {
      throw new Error(`Forbidden runtime file in manifest: ${filePath}`);
    }
    if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`AgentScope runtime manifest file ${index} has an invalid SHA-256.`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`AgentScope runtime manifest file ${index} has an invalid size.`);
    }
    return { path: filePath, sha256: file.sha256, size: file.size };
  });

  for (let index = 1; index < files.length; index += 1) {
    if (comparePortablePaths(files[index - 1].path, files[index].path) >= 0) {
      throw new Error('AgentScope runtime manifest file inventory must be strictly sorted and unique.');
    }
  }

  const parsed = {
    schemaVersion: requireExact(
      manifest.schemaVersion,
      RUNTIME_VERSIONS.schemaVersion,
      'manifest schemaVersion',
    ),
    platform: requireExact(manifest.platform, RUNTIME_VERSIONS.platform, 'manifest platform'),
    arch: requireExact(manifest.arch, RUNTIME_VERSIONS.arch, 'manifest architecture'),
    pythonVersion: requireExact(
      manifest.pythonVersion,
      RUNTIME_VERSIONS.pythonVersion,
      'manifest Python version',
    ),
    agentScopeVersion: requireExact(
      manifest.agentScopeVersion,
      RUNTIME_VERSIONS.agentScopeVersion,
      'manifest AgentScope version',
    ),
    protocolVersion: requireExact(
      manifest.protocolVersion,
      RUNTIME_VERSIONS.protocolVersion,
      'manifest protocol version',
    ),
    pythonRelativePath: requireContainedRelativePath(
      manifest.pythonRelativePath,
      'manifest Python path',
    ),
    appRelativePath: requireContainedRelativePath(
      manifest.appRelativePath,
      'manifest application path',
    ),
    sitePackagesRelativePath: requireContainedRelativePath(
      manifest.sitePackagesRelativePath,
      'manifest site-packages path',
    ),
    files,
  };

  for (const requiredPath of [
    parsed.pythonRelativePath,
    'app/private_ai_agentscope/bootstrap.py',
    'site-packages/agentscope/__init__.py',
  ]) {
    if (!files.some((file) => file.path === requiredPath)) {
      throw new Error(`Required runtime file is not inventoried: ${requiredPath}`);
    }
  }
  return parsed;
}

function resolveContained(root, relativePath, label) {
  const candidate = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes the runtime root.`);
  }
  return candidate;
}

function canonicalNativePath(candidate) {
  const normalized = path.normalize(candidate);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

async function hashFile(filePath, relativePath) {
  const content = await readFile(filePath);
  if (containsBuildPathLeak(content)) {
    throw new Error(`PID-scoped build path is forbidden in the runtime: ${filePath}`);
  }
  if (containsPrivateKeyMaterial(content.subarray(0, 2 * 1024 * 1024).toString('utf8'))) {
    throw new Error(`Private key material is forbidden in the runtime: ${filePath}`);
  }
  if (
    isDistInfoRecordPath(relativePath) &&
    !isCanonicalDistInfoRecordText(content.toString('utf8'))
  ) {
    throw new Error(`Installer RECORD metadata must be canonical: ${relativePath}`);
  }
  return createHash('sha256').update(content).digest('hex');
}

async function enumerateRuntimeFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => comparePortablePaths(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = await assertNotReparsePoint(absolute, `Runtime entry ${relativePath}`);
    if (metadata.isDirectory()) {
      if (isForbiddenRuntimePath(relativePath)) {
        throw new Error(`Forbidden runtime directory: ${relativePath}`);
      }
      files.push(...await enumerateRuntimeFiles(root, absolute));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Runtime entry must be a regular file: ${relativePath}`);
    }
    if (relativePath === 'runtime-manifest.json') {
      continue;
    }
    if (isForbiddenRuntimePath(relativePath)) {
      throw new Error(`Forbidden runtime file: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      sha256: await hashFile(absolute, relativePath),
      size: metadata.size,
    });
  }
  return files.sort((left, right) => comparePortablePaths(left.path, right.path));
}

export function compareRuntimeInventories(expectedFiles, actualFiles) {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  for (const file of expectedFiles) {
    const actual = actualByPath.get(file.path);
    if (!actual) {
      throw new Error(`Runtime file is missing: ${file.path}`);
    }
    if (actual.sha256 !== file.sha256) {
      throw new Error(`Runtime file hash mismatch: ${file.path}`);
    }
    if (actual.size !== file.size) {
      throw new Error(`Runtime file size mismatch: ${file.path}`);
    }
  }
  for (const file of actualFiles) {
    if (!expectedByPath.has(file.path)) {
      throw new Error(`Extra runtime file is not inventoried: ${file.path}`);
    }
  }
  return { files: expectedFiles.length };
}

function isolatedPythonEnvironment() {
  const environment = {
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) {
      environment[key] = process.env[key];
    }
  }
  return environment;
}

export function buildIsolatedPythonArguments(code) {
  return ['-I', '-B', '-c', code];
}

export function parseBundledInterpreterVerificationOutput(stdout) {
  let parsed;
  try {
    parsed = requireRecord(JSON.parse(String(stdout).trim()), 'Bundled interpreter output');
  } catch {
    throw new Error('Bundled interpreter returned invalid version verification output.');
  }
  const keys = [
    'pythonVersion',
    'agentScopeVersion',
    'runtimeVersion',
    'protocolVersion',
    'platform',
    'compileTarget',
    'machine',
    'pointerBits',
  ];
  requireExactKeys(parsed, keys, 'Bundled interpreter output');
  requireExact(parsed.pythonVersion, RUNTIME_VERSIONS.pythonVersion, 'interpreter Python version');
  requireExact(
    parsed.agentScopeVersion,
    RUNTIME_VERSIONS.agentScopeVersion,
    'interpreter AgentScope version',
  );
  requireExact(parsed.runtimeVersion, RUNTIME_VERSIONS.runtimeVersion, 'interpreter runtime version');
  requireExact(parsed.protocolVersion, RUNTIME_VERSIONS.protocolVersion, 'interpreter protocol version');
  if (
    parsed.platform !== RUNTIME_VERSIONS.platform ||
    String(parsed.compileTarget).toLowerCase() !== 'win-amd64'
  ) {
    throw new Error('Bundled interpreter must use the win32-x64 compile target.');
  }
  if (parsed.pointerBits !== 64) {
    throw new Error('Bundled interpreter must be 64-bit.');
  }
  return parsed;
}

async function verifyBundledInterpreter(
  runtimeRoot,
  manifest,
  executeInterpreter = executeFileBounded,
) {
  const pythonPath = resolveContained(runtimeRoot, manifest.pythonRelativePath, 'Python path');
  const appPath = resolveContained(runtimeRoot, manifest.appRelativePath, 'application path');
  const sitePackagesPath = resolveContained(
    runtimeRoot,
    manifest.sitePackagesRelativePath,
    'site-packages path',
  );
  const verificationCode = [
    'import json, platform, struct, sys, sysconfig',
    `sys.path[:0] = ${JSON.stringify([sitePackagesPath, appPath])}`,
    'import agentscope',
    'from private_ai_agentscope.protocol import AGENTSCOPE_VERSION, RUNTIME_VERSION, PROTOCOL_VERSION',
    `assert '.'.join(map(str, sys.version_info[:3])) == ${JSON.stringify(RUNTIME_VERSIONS.pythonVersion)}`,
    `assert agentscope.__version__ == ${JSON.stringify(RUNTIME_VERSIONS.agentScopeVersion)}`,
    `assert AGENTSCOPE_VERSION == ${JSON.stringify(RUNTIME_VERSIONS.agentScopeVersion)}`,
    `assert RUNTIME_VERSION == ${JSON.stringify(RUNTIME_VERSIONS.runtimeVersion)}`,
    `assert PROTOCOL_VERSION == ${JSON.stringify(RUNTIME_VERSIONS.protocolVersion)}`,
    `assert sys.platform == ${JSON.stringify(RUNTIME_VERSIONS.platform)}`,
    "assert sysconfig.get_platform().lower() == 'win-amd64'",
    "assert struct.calcsize('P') * 8 == 64",
    "print(json.dumps({'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'agentScopeVersion': agentscope.__version__, 'runtimeVersion': RUNTIME_VERSION, 'protocolVersion': PROTOCOL_VERSION, 'platform': sys.platform, 'compileTarget': sysconfig.get_platform(), 'machine': platform.machine(), 'pointerBits': struct.calcsize('P') * 8}))",
  ].join('; ');
  const { stdout } = await executeInterpreter(
    pythonPath,
    buildIsolatedPythonArguments(verificationCode),
    {
      cwd: runtimeRoot,
      env: isolatedPythonEnvironment(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return parseBundledInterpreterVerificationOutput(stdout);
}

export async function verifyRuntimeArtifact(runtimeRoot, options = {}) {
  const root = path.resolve(runtimeRoot);
  const rootMetadata = await assertNotReparsePoint(root, 'Runtime root');
  if (!rootMetadata.isDirectory()) {
    throw new Error('Runtime root must be a directory.');
  }
  const manifestPath = path.join(root, 'runtime-manifest.json');
  const manifestMetadata = await assertNotReparsePoint(manifestPath, 'Runtime manifest');
  if (!manifestMetadata.isFile()) {
    throw new Error('Runtime manifest must be a regular file.');
  }
  const originalManifestBytes = await readFile(manifestPath);
  let decoded;
  try {
    decoded = JSON.parse(originalManifestBytes.toString('utf8'));
  } catch {
    throw new Error('runtime-manifest.json must contain valid JSON.');
  }
  const manifest = parseRuntimeManifest(decoded);
  const actualFiles = await enumerateRuntimeFiles(root);
  const inventory = compareRuntimeInventories(manifest.files, actualFiles);
  const versions = await verifyBundledInterpreter(
    root,
    manifest,
    options.executeInterpreter ?? executeFileBounded,
  );
  const finalManifestBytes = await readFile(manifestPath);
  try {
    parseRuntimeManifest(JSON.parse(finalManifestBytes.toString('utf8')));
  } catch {
    throw new Error('runtime-manifest.json changed to an invalid manifest during verification.');
  }
  if (!originalManifestBytes.equals(finalManifestBytes)) {
    throw new Error('Runtime manifest changed during bundled interpreter verification.');
  }
  compareRuntimeInventories(manifest.files, await enumerateRuntimeFiles(root));
  const manifestSha256 = createHash('sha256')
    .update(originalManifestBytes)
    .digest('hex');
  return { root, inventory, versions, manifestSha256 };
}

export function repositoryRootFromModule(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function isDirectCliInvocation(invokedPath, modulePath, platform = process.platform) {
  if (typeof invokedPath !== 'string' || invokedPath.length === 0
    || typeof modulePath !== 'string' || modulePath.length === 0) {
    return false;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const canonicalize = (value) => {
    const canonicalPath = pathApi.resolve(value);
    return platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  };
  return canonicalize(invokedPath) === canonicalize(modulePath);
}

if (isDirectCliInvocation(process.argv[1] ?? '', fileURLToPath(import.meta.url))) {
  try {
    const runtimeRoot = path.join(repositoryRootFromModule(), 'resources', 'agentscope-runtime');
    const result = await verifyRuntimeArtifact(runtimeRoot);
    console.log(
      `AgentScope runtime verified: files=${result.inventory.files} ` +
      `python=${result.versions.pythonVersion} agentscope=${result.versions.agentScopeVersion} ` +
      `runtime=${result.versions.runtimeVersion} manifestSha256=${result.manifestSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
