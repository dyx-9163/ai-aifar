import { describe, expect, it } from 'vitest';
import { buildAppHealth } from '../src/main/appHealth';
import type { AgentScopeRuntimeState } from '../src/main/agentScopeProtocol';

describe('buildAppHealth', () => {
  it('reports AgentScope separately while the legacy Agent stays active', () => {
    expect(buildAppHealth('1.2.3', {
      state: 'ready',
      pid: 1234,
      port: 49152,
      runtimeVersion: '1.0.0',
      agentScopeVersion: '2.0.6',
    })).toEqual({
      ok: true,
      version: '1.2.3',
      agentBackend: 'legacy',
      agentScope: {
        state: 'ready',
        runtimeVersion: '1.0.0',
        agentScopeVersion: '2.0.6',
      },
    });
  });

  it('omits internal process and bootstrap fields from every public state', () => {
    const internalStates = [
      { state: 'stopped', token: 'bootstrap-secret', pythonPath: 'C:/private/python.exe' },
      { state: 'starting', attempt: 3, port: 49152, logDir: 'C:/private/logs' },
      {
        state: 'ready',
        pid: 1234,
        port: 49152,
        runtimeVersion: '1.0.0',
        agentScopeVersion: '2.0.6',
        token: 'bootstrap-secret',
        sitePackagesPath: 'C:/private/site-packages',
      },
    ] as unknown as AgentScopeRuntimeState[];

    const serialized = internalStates.map((state) => JSON.stringify(buildAppHealth('1.2.3', state)));

    for (const health of serialized) {
      expect(health).not.toMatch(/bootstrap-secret|1234|49152|C:\/private/i);
      expect(health).not.toMatch(/"pid"|"port"|"token"|pythonPath|sitePackagesPath|logDir/i);
    }
  });

  it.each([
    ['missing-runtime', 'AgentScope runtime is unavailable.'],
    ['invalid-manifest', 'AgentScope runtime manifest validation failed.'],
  ] as const)('projects %s with a fixed redacted detail', (reason, expectedDetail) => {
    const health = buildAppHealth('1.2.3', {
      state: 'degraded',
      reason,
      detail: 'raw stderr: token=bootstrap-secret at C:/private/runtime',
    });

    expect(health).toEqual({
      ok: true,
      version: '1.2.3',
      agentBackend: 'legacy',
      agentScope: {
        state: 'degraded',
        reason,
        detail: expectedDetail,
      },
    });
    expect(JSON.stringify(health)).not.toMatch(/stderr|bootstrap-secret|C:\/private/i);
  });

  it('redacts arbitrary internal detail for every degraded supervisor reason', () => {
    const reasons = [
      'missing-runtime',
      'invalid-manifest',
      'protocol-mismatch',
      'health-failed',
      'start-timeout',
      'exited',
    ] as const;

    for (const reason of reasons) {
      const health = buildAppHealth('1.2.3', {
        state: 'degraded',
        reason,
        detail: 'token=bootstrap-secret; stderr=C:/private/runtime',
      });
      expect(JSON.stringify(health)).not.toMatch(/bootstrap-secret|stderr|C:\/private/i);
    }
  });
});
