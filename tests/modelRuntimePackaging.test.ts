import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import forgeConfig from '../forge.config';

describe('local model packaging boundary', () => {
  it('ignores GGUF files and runtime overrides', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignore).toContain('models/*.gguf');
    expect(ignore).toContain('model-runtime/.env');
  });

  it('uses a production runtime allowlist for Electron archives', () => {
    const patterns = forgeConfig.packagerConfig?.ignore as RegExp[];
    const isIgnored = (candidate: string) => patterns.some((value) => value.test(candidate));
    for (const allowed of ['/package.json', '/.vite/build/main.js', '/.vite/renderer/main_window/index.html']) {
      expect(isIgnored(allowed), allowed).toBe(false);
    }
    for (const excluded of [
      '/models/model.gguf',
      '/model-runtime/compose.yaml',
      '/model-runtime/.env',
      '/.superpowers/sdd/evidence.md',
      '/.electron-cache/electron.zip',
      '/src/main.ts',
      '/tests/modelProvider.test.ts',
      '/docs/design.md',
      '/test-results/results.json',
      '/node_modules/vue/index.js',
      '/README.md',
    ]) {
      expect(isIgnored(excluded), excluded).toBe(true);
    }
  });

  it('keeps the Electron download cache outside the project root', () => {
    const cacheRoot = forgeConfig.packagerConfig?.download?.cacheRoot;
    expect(typeof cacheRoot).toBe('string');
    expect(resolve(String(cacheRoot)).startsWith(`${resolve(process.cwd())}\\`)).toBe(false);
    expect(resolve(String(cacheRoot)).startsWith(resolve(tmpdir()))).toBe(true);
  });
});
