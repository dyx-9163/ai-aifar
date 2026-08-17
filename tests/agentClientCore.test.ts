import { describe, expect, it } from 'vitest';
import {
  appendOptimisticUserMessage,
  applyAssistantDeltaToSnapshot,
  emptyAgentClientState,
  reduceAgentEvent,
} from '../src/agentClient/core';
import { mapAgentEventToAgUiEvents } from '../src/agentClient/agUiAdapter';
import type { AgentEvent } from '../src/shared/protocol';

describe('Agent Client Core', () => {
  it('keeps desktop snapshots, active chat, active group, and optimistic messages in one pure state model', () => {
    const snapshot: AgentEvent = {
      type: 'snapshot',
      snapshot: {
        groups: [{ id: 'group-1', name: '运维问答', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z' }],
        threads: [
          {
            id: 'thread-1',
            groupId: 'group-1',
            title: 'Redis',
            status: 'ready',
            createdAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z',
          },
        ],
        items: {},
        approvals: [],
        modelProfiles: [],
        settings: { theme: 'system', language: 'zh-CN' },
      },
    };

    const loaded = reduceAgentEvent(emptyAgentClientState(), snapshot);
    const withUser = appendOptimisticUserMessage(loaded, 'thread-1', 'turn-1', '请部署 Redis');
    const withAssistant = applyAssistantDeltaToSnapshot(withUser, 'thread-1', 'turn-1', '可以，');

    expect(withAssistant.activeThreadId).toBe('thread-1');
    expect(withAssistant.activeGroupId).toBe('group-1');
    expect(withAssistant.snapshot.items['thread-1']).toMatchObject([
      { role: 'user', text: '请部署 Redis' },
      { role: 'assistant', text: '可以，' },
    ]);
  });

  it('maps internal agent events into dependency-free AG-UI boundary events', () => {
    expect(
      mapAgentEventToAgUiEvents({
        type: 'message.delta',
        threadId: 'thread-1',
        turnId: 'turn-1',
        sequence: 2,
        text: 'hello',
      }),
    ).toEqual([
      {
        type: 'TEXT_MESSAGE_CONTENT',
        threadId: 'thread-1',
        runId: 'turn-1',
        messageId: 'message-turn-1',
        delta: 'hello',
        sequence: 2,
      },
    ]);

    expect(
      mapAgentEventToAgUiEvents({
        type: 'model.metrics',
        threadId: 'thread-1',
        turnId: 'turn-1',
        sequence: 9,
        metrics: { thinkingEnabled: false, durationMs: 1200, tokensPerSecond: 18.4 },
      }),
    ).toEqual([
      {
        type: 'CUSTOM',
        name: 'model.metrics',
        threadId: 'thread-1',
        runId: 'turn-1',
        sequence: 9,
        value: { thinkingEnabled: false, durationMs: 1200, tokensPerSecond: 18.4 },
      },
    ]);
  });
});
