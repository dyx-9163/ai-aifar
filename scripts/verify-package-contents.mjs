import { listPackage } from '@electron/asar';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function normalizeInventoryPath(candidate) {
  return String(candidate).replaceAll('\\', '/').replace(/^\/+/, '');
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

export function validateOuterInventory(files) {
  const normalized = files.map(normalizeInventoryPath);
  for (const file of normalized) {
    const segments = file.toLowerCase().split('/');
    const name = segments.at(-1) ?? '';
    if (
      segments.some((segment) => forbiddenOuterSegments.has(segment)) ||
      name === '.env' ||
      name.startsWith('.env.') ||
      name.endsWith('.gguf')
    ) {
      throw new Error(`Forbidden outer-package file: ${file}`);
    }
  }
  if (!normalized.includes('resources/app.asar')) {
    throw new Error('Packaged application is missing resources/app.asar.');
  }
  return { files: normalized.length };
}

async function enumerateFiles(root, current = root) {
  const results = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...await enumerateFiles(root, absolute));
    } else {
      results.push(normalizeInventoryPath(path.relative(root, absolute)));
    }
  }
  return results;
}

export async function verifyPackagedApp(projectRoot = process.cwd()) {
  const packageRoot = path.join(
    projectRoot,
    'out',
    `Private AI Desktop-${process.platform}-${process.arch}`,
  );
  const outerFiles = await enumerateFiles(packageRoot);
  const outer = validateOuterInventory(outerFiles);
  const asarPath = path.join(packageRoot, 'resources', 'app.asar');
  const asarStat = await stat(asarPath);
  const asarEntries = listPackage(asarPath);
  const asar = validateAsarInventory(asarEntries, asarStat.size);
  return { packageRoot, outer, asar };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await verifyPackagedApp();
    console.log(
      `Package content verified: outerFiles=${result.outer.files} ` +
      `asarEntries=${result.asar.entries} asarBytes=${result.asar.bytes}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
