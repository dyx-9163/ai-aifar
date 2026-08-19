import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isExcludedDirectory,
  isExcludedFile,
  isExcludedPath,
  normalizeWorkspacePath,
  resolveWithinRoot,
  WorkspaceSecurityError,
} from '../src/agent/workspace/pathSecurity';

let tempDirectories: string[] = [];

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-pathsec-'));
  tempDirectories.push(directory);
  return directory;
}

function expectSecurityError(run: () => unknown, code: WorkspaceSecurityError['code']): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected a WorkspaceSecurityError to be thrown').toBeInstanceOf(WorkspaceSecurityError);
  expect((caught as WorkspaceSecurityError).code).toBe(code);
}

const isWindows = process.platform === 'win32';

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('normalizeWorkspacePath', () => {
  it('canonicalizes an existing directory through realpath', () => {
    const directory = createTempDir();
    const nested = join(directory, 'project');
    mkdirSync(nested);
    const canonical = realpathSync.native(nested).replace(/^([A-Za-z]):/, (match, letter: string) =>
      isWindows ? `${letter.toLowerCase()}:` : match,
    );
    expect(normalizeWorkspacePath(nested)).toBe(canonical);
  });

  it('rejects relative paths', () => {
    expectSecurityError(() => normalizeWorkspacePath('relative/dir'), 'not-absolute');
    expectSecurityError(() => normalizeWorkspacePath(''), 'not-absolute');
  });

  it('rejects missing paths', () => {
    const directory = createTempDir();
    expectSecurityError(() => normalizeWorkspacePath(join(directory, 'missing')), 'not-found');
  });

  it('rejects UNC network paths', () => {
    expectSecurityError(() => normalizeWorkspacePath('\\\\attacker-server\\share'), 'unc-root');
  });

  it('rejects device paths', () => {
    expectSecurityError(() => normalizeWorkspacePath('\\\\.\\C:'), 'device-path');
  });

  it('strips a trailing separator', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expect(normalizeWorkspacePath(`${directory}${isWindows ? '\\' : '/'}`)).toBe(canonical);
  });

  it.skipIf(!isWindows)('normalizes drive letter casing on Windows', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    const flipped = canonical.replace(/^([a-z]):/, (match, letter: string) => `${letter.toUpperCase()}:`);
    expect(normalizeWorkspacePath(flipped)).toBe(canonical);
  });
});

describe('resolveWithinRoot', () => {
  it('returns the canonical root for "." and "./"', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expect(resolveWithinRoot(canonical, '.')).toBe(canonical);
    expect(resolveWithinRoot(canonical, './')).toBe(canonical);
    expect(resolveWithinRoot(canonical, '')).toBe(canonical);
  });

  it('resolves nested existing paths inside the root', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    const nested = join(canonical, 'src', 'agent');
    mkdirSync(nested, { recursive: true });
    const file = join(nested, 'worker.ts');
    writeFileSync(file, 'export {};\n');

    expect(resolveWithinRoot(canonical, 'src/agent/worker.ts')).toBe(file);
    expect(resolveWithinRoot(canonical, join(canonical, 'src', 'agent', 'worker.ts'))).toBe(file);
  });

  it('allows nonexistent targets that stay inside the root', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expect(resolveWithinRoot(canonical, 'does/not/exist.txt')).toBe(join(canonical, 'does', 'not', 'exist.txt'));
  });

  it('blocks dot-dot traversal escaping the root', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expectSecurityError(() => resolveWithinRoot(canonical, '../../outside.txt'), 'outside-workspace');
    expectSecurityError(() => resolveWithinRoot(canonical, join(canonical, '..', '..', 'outside.txt')), 'outside-workspace');
  });

  it('blocks symlinks and junctions pointing outside the root', () => {
    const directory = createTempDir();
    const outside = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    const outsideCanonical = normalizeWorkspacePath(outside);

    const linkName = 'escape-link';
    const linkPath = join(canonical, linkName);
    symlinkSync(outsideCanonical, linkPath, isWindows ? 'junction' : 'dir');

    expectSecurityError(() => resolveWithinRoot(canonical, linkName), 'outside-workspace');
    expectSecurityError(() => resolveWithinRoot(canonical, join(linkName, 'file.txt')), 'outside-workspace');
  });

  it('rejects device paths passed as tool input', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expectSecurityError(() => resolveWithinRoot(canonical, '\\\\.\\C:\\secret.txt'), 'device-path');
  });
});

describe('exclusion rules', () => {
  it('flags excluded directory names', () => {
    expect(isExcludedDirectory('node_modules')).toBe(true);
    expect(isExcludedDirectory('.git')).toBe(true);
    expect(isExcludedDirectory('src')).toBe(false);
  });

  it('flags excluded file names', () => {
    expect(isExcludedFile('.env')).toBe(true);
    expect(isExcludedFile('.env.local')).toBe(true);
    expect(isExcludedFile('pnpm-lock.yaml')).toBe(true);
    expect(isExcludedFile('worker.ts')).toBe(false);
  });

  it('flags paths containing excluded segments', () => {
    const directory = createTempDir();
    const canonical = normalizeWorkspacePath(directory);
    expect(isExcludedPath(canonical, join(canonical, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(isExcludedPath(canonical, join(canonical, 'src', '.env'))).toBe(true);
    expect(isExcludedPath(canonical, join(canonical, 'src', 'main.ts'))).toBe(false);
    expect(isExcludedPath(canonical, canonical)).toBe(false);
  });
});
