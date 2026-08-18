import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRequestBroker } from '../src/main/agentRequestBroker';

afterEach(() => {
  vi.useRealTimers();
});

describe('agent request broker', () => {
  it('rejects and removes every request when its deadline expires', async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const broker = new AgentRequestBroker(25);
    broker.connect({ postMessage: (message) => sent.push(message) });

    const snapshot = broker.request({ type: 'snapshot.get' });
    const rejection = expect(snapshot).rejects.toThrow('timed out after 25ms');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(sent).toHaveLength(1);
    expect(broker.pendingCount).toBe(0);
  });

  it.each(['worker exited', 'agent port closed'])('rejects snapshot and connection test when %s', async (reason) => {
    const broker = new AgentRequestBroker(30_000);
    broker.connect({ postMessage: () => undefined });
    const snapshot = broker.request({ type: 'snapshot.get' });
    const connection = broker.request({ type: 'modelProfile.test' });
    const snapshotRejection = expect(snapshot).rejects.toThrow(reason);
    const connectionRejection = expect(connection).rejects.toThrow(reason);

    broker.disconnect(reason);

    await Promise.all([snapshotRejection, connectionRejection]);
    expect(broker.pendingCount).toBe(0);
    expect(broker.handleReply({ type: 'agent.reply', requestId: 'request-1', ok: true })).toBe(false);
  });
});
