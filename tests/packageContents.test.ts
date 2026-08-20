import { describe, expect, it } from 'vitest';
import {
  MAX_ASAR_BYTES,
  validateAsarInventory,
  validateOuterInventory,
} from '../scripts/verify-package-contents.mjs';

describe('packaged application content policy', () => {
  it('accepts only the bundled runtime roots inside ASAR', () => {
    expect(validateAsarInventory([
      '/package.json',
      '/.vite',
      '/.vite/build',
      '/.vite/build/main.js',
      '/.vite/build/preload.js',
      '/.vite/build/worker.js',
      '/.vite/renderer/main_window/index.html',
    ], 250_000)).toEqual({ entries: 7, bytes: 250_000 });
  });

  it.each([
    '/.superpowers/sdd/report.md',
    '/.electron-cache/electron.zip',
    '/src/main.ts',
    '/tests/modelProvider.test.ts',
    '/docs/design.md',
    '/test-results/result.json',
    '/node_modules/vue/index.js',
    '/model-runtime/.env',
    '/models/model.gguf',
    '/README.md',
  ])('rejects non-runtime ASAR content: %s', (entry) => {
    expect(() => validateAsarInventory(['/package.json', entry], 250_000)).toThrow(/forbidden ASAR entry/i);
  });

  it('rejects an oversized ASAR', () => {
    expect(() => validateAsarInventory(['/package.json'], MAX_ASAR_BYTES + 1)).toThrow(/size limit/i);
  });

  it('checks outer package files independently of ASAR entries', () => {
    expect(validateOuterInventory([
      'Private AI Desktop.exe',
      'resources/app.asar',
      'locales/en-US.pak',
      'locales/es-419.pak',
    ])).toEqual({ files: 4 });
    for (const forbidden of [
      'resources/.superpowers/report.md',
      'resources/app/src/main.ts',
      'resources/app.asar.unpacked/tests/fixture.js',
      'resources/models/model.gguf',
      'resources/model-runtime/.env',
    ]) {
      expect(() => validateOuterInventory(['resources/app.asar', forbidden])).toThrow(/forbidden outer-package file/i);
    }
  });

  it('rejects arbitrary outer files instead of allowing all resources', () => {
    expect(() => validateOuterInventory([
      'Private AI Desktop.exe',
      'resources/app.asar',
      'resources/uninventoried.bin',
    ])).toThrow(/unexpected outer-package file/i);
  });

  it('allows dependency source paths only when the runtime manifest inventories them', () => {
    const runtimeFile = 'site-packages/numpy/f2py/src/fortranobject.c';
    expect(validateOuterInventory([
      'resources/app.asar',
      'resources/agentscope-runtime/runtime-manifest.json',
      `resources/agentscope-runtime/${runtimeFile}`,
    ], [runtimeFile])).toEqual({ files: 3 });
    expect(() => validateOuterInventory([
      'resources/app.asar',
      'resources/vendor/src/fortranobject.c',
    ])).toThrow(/forbidden outer-package file/i);
  });
});
