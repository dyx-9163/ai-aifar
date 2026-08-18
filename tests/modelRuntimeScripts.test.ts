import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const scripts = ['runtime-common.ps1', 'start-model.ps1', 'stop-model.ps1', 'status-model.ps1', 'verify-model.ps1'];

describe('runtime scripts', () => {
  it.each(scripts)('%s parses', (name) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('model-runtime/${name}',[ref]$null,[ref]$e);if($e.Count){exit 1}`]);
    expect(result.status).toBe(0);
  });

  it('scopes mutations and never controls Electron', () => {
    const source = scripts.map((name) => readFileSync(`model-runtime/${name}`, 'utf8')).join('\n');
    expect(source).toContain("$script:ModelComposeProject = 'ai-aifar-model'");
    expect(source).not.toMatch(/electron|pnpm start|D:\\workspace\\AI\\aifar\\compose\.yaml/i);
  });

  it('verifies artifacts before the first Docker call during startup', () => {
    const source = readFileSync('model-runtime/start-model.ps1', 'utf8');
    expect(source.indexOf('Assert-ModelArtifacts')).toBeLessThan(source.indexOf('Assert-ModelDockerDaemon'));
  });

  it('encodes a real non-ASCII completion prompt as UTF-8 bytes', () => {
    const source = readFileSync('model-runtime/verify-model.ps1', 'utf8');
    expect(source).toContain('[System.Text.Encoding]::UTF8.GetBytes');
    expect(source).not.toContain('\\u4f60\\u597d');
  });
});
