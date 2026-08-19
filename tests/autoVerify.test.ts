import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectVerificationCommand, runAutoVerification } from '../src/agent/tools/autoVerify';

let tempDirectories: string[] = [];
let root = '';

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'private-ai-autoverify-')));
  tempDirectories.push(root);
});

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('detectVerificationCommand', () => {
  it('returns null when the workspace has no package.json', () => {
    expect(detectVerificationCommand(root)).toBeNull();
  });

  it('returns null when no verification script exists', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    expect(detectVerificationCommand(root)).toBeNull();
  });

  it('prefers typecheck over build and picks the lockfile package manager', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build', typecheck: 'vue-tsc --noEmit' },
    }));
    expect(detectVerificationCommand(root)).toEqual({
      command: 'npm',
      args: ['run', 'typecheck'],
      label: 'npm run typecheck',
    });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(detectVerificationCommand(root)).toEqual({
      command: 'pnpm',
      args: ['run', 'typecheck'],
      label: 'pnpm run typecheck',
    });
  });

  it('falls back to build when only a bundler script exists', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    expect(detectVerificationCommand(root)).toMatchObject({ command: 'npm', args: ['run', 'build'] });
  });
});

describe('runAutoVerification', () => {
  it('returns null when nothing is verifiable', async () => {
    await expect(runAutoVerification(root)).resolves.toBeNull();
  });

  it('reports a passing verification', async () => {
    writeFileSync(join(root, 'verify.js'), 'console.log("all good");\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node verify.js' } }));
    const report = await runAutoVerification(root);
    expect(report).toContain('[auto-verify] npm run typecheck passed');
  }, 30_000);

  it('feeds failing verification output back for the model to fix', async () => {
    writeFileSync(join(root, 'verify.js'), 'console.error("src/App.vue(3,1): error TS1111: boom"); process.exit(2);\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node verify.js' } }));
    const report = await runAutoVerification(root);
    expect(report).toContain('[auto-verify] npm run typecheck exited 2');
    expect(report).toContain('TS1111');
    expect(report).toContain('follow-up apply_patch');
  }, 30_000);
});
