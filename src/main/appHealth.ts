type DegradedReason =
  | 'missing-runtime'
  | 'invalid-manifest'
  | 'protocol-mismatch'
  | 'health-failed'
  | 'start-timeout'
  | 'exited';

type AgentScopeHealthSource =
  | { state: 'stopped' }
  | { state: 'starting'; attempt: number }
  | {
      state: 'ready';
      pid: number;
      port: number;
      runtimeVersion: '1.0.0';
      agentScopeVersion: '2.0.6';
    }
  | { state: 'degraded'; reason: DegradedReason; detail: string };

const PUBLIC_DEGRADED_DETAILS: Record<DegradedReason, string> = {
  'missing-runtime': 'AgentScope runtime is unavailable.',
  'invalid-manifest': 'AgentScope runtime manifest validation failed.',
  'protocol-mismatch': 'AgentScope runtime readiness validation failed.',
  'health-failed': 'AgentScope runtime health check failed.',
  'start-timeout': 'AgentScope runtime startup timed out.',
  exited: 'AgentScope runtime exited unexpectedly.',
};

export interface DesktopHealth {
  ok: true;
  version: string;
  agentBackend: 'legacy';
  agentScope:
    | { state: 'stopped' | 'starting' }
    | { state: 'ready'; runtimeVersion: '1.0.0'; agentScopeVersion: '2.0.6' }
    | { state: 'degraded'; reason: DegradedReason; detail: string };
}

export function buildAppHealth(
  version: string,
  agentScopeState: AgentScopeHealthSource,
): DesktopHealth {
  switch (agentScopeState.state) {
    case 'stopped':
    case 'starting':
      return {
        ok: true,
        version,
        agentBackend: 'legacy',
        agentScope: { state: agentScopeState.state },
      };
    case 'ready':
      return {
        ok: true,
        version,
        agentBackend: 'legacy',
        agentScope: {
          state: 'ready',
          runtimeVersion: agentScopeState.runtimeVersion,
          agentScopeVersion: agentScopeState.agentScopeVersion,
        },
      };
    case 'degraded':
      return {
        ok: true,
        version,
        agentBackend: 'legacy',
        agentScope: {
          state: 'degraded',
          reason: agentScopeState.reason,
          detail: PUBLIC_DEGRADED_DETAILS[agentScopeState.reason],
        },
      };
  }
}
