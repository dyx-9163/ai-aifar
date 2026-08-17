import { describe, expect, it } from 'vitest';
import {
  appendOptimisticUserMessage,
  applyAssistantDeltaToSnapshot,
  emptyAgentClientState,
  reduceAgentEvent,
} from '../src/agentClient/core';
import { mapAgentEventToAgUiEvents } from '../src/agentClient/agUiAdapter';
import type { AppSnapshot } from '../src/shared/domain';
import type { AgentEvent } from '../src/shared/protocol';

const envelope = (threadId: string, turnId: string, sequence: number) => ({
  threadId,
  turnId,
  sequence,
  modelProfileId: 'model-1',
});

const queued = (threadId: string, turnId: string, queuePosition: number): AgentEvent => ({
  type: 'turn.queued',
  ...envelope(threadId, turnId, 1),
  queuePosition,
});

const started = (threadId: string, turnId: string, sequence: number): AgentEvent => ({
  type: 'turn.started',
  ...envelope(threadId, turnId, sequence),
  title: turnId,
});

const rawDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'reasoning.raw.delta',
  ...envelope(threadId, turnId, sequence),
  text,
});

const summaryDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'reasoning.summary.delta',
  ...envelope(threadId, turnId, sequence),
  text,
});

const answerDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'answer.delta',
  ...envelope(threadId, turnId, sequence),
  text,
});

function snapshotFixture(input: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    groups: [],
    threads: [],
    turns: [],
    items: {},
    approvals: [],
    modelProfiles: [],
    settings: {
      theme: 'system',
      language: 'en-US',
      showModelMetrics: true,
      contextMessageLimit: 20,
      reasoningDisplayMode: 'auto',
    },
    ...input,
  };
}

describe('Agent Client Core', () => {
  it('keeps desktop snapshots, active chat, active group, and optimistic messages in one pure state model', () => {
    const snapshot: AgentEvent = {
      type: 'snapshot',
      snapshot: snapshotFixture({
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
      }),
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

  it('keeps background turn events scoped to their thread without stealing focus', () => {
    let state = { ...emptyAgentClientState(), activeThreadId: 'thread-1' };
    state = reduceAgentEvent(state, queued('thread-2', 'turn-2', 1));
    state = reduceAgentEvent(state, started('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, started('thread-2', 'turn-2', 2));
    state = reduceAgentEvent(state, answerDelta('thread-2', 'turn-2', 3, '后台答案'));

    expect(state.activeThreadId).toBe('thread-1');
    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });
    expect(state.runtimeByThread['thread-2']).toMatchObject({ turnId: 'turn-2', status: 'running' });
    expect(state.snapshot.items['thread-2']).toMatchObject([{ kind: 'message', text: '后台答案' }]);
  });

  it('tracks two running chats independently', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, started('thread-2', 'turn-2', 1));

    expect(state.runtimeByThread).toMatchObject({
      'thread-1': { turnId: 'turn-1', status: 'running' },
      'thread-2': { turnId: 'turn-2', status: 'running' },
    });
  });

  it('suppresses duplicate and out-of-order sequences within one turn', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), answerDelta('thread-1', 'turn-1', 2, '新'));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 2, '重复'));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 1, '过期'));

    expect(state.snapshot.items['thread-1']).toMatchObject([{ text: '新' }]);
    expect(state.events).toHaveLength(1);
  });

  it('does not suppress the same sequence number across different turns', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), answerDelta('thread-1', 'turn-1', 1, '一'));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-2', 1, '二'));

    expect(state.events).toHaveLength(2);
    expect(state.snapshot.items['thread-1']).toMatchObject([{ turnId: 'turn-1', text: '一' }, { turnId: 'turn-2', text: '二' }]);
  });

  it('stores raw reasoning, summary, and answer in separate stable live items', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), rawDelta('thread-1', 'turn-1', 1, '分析'));
    state = reduceAgentEvent(state, summaryDelta('thread-1', 'turn-1', 2, '摘要'));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 3, '答案'));
    state = reduceAgentEvent(state, rawDelta('thread-1', 'turn-1', 4, '续'));

    expect(state.snapshot.items['thread-1']).toMatchObject([
      { id: 'item-turn-1-reasoning-raw-live', kind: 'reasoning', mode: 'raw', text: '分析续' },
      { id: 'item-turn-1-reasoning-summary-live', kind: 'reasoning', mode: 'summary', text: '摘要' },
      { id: 'item-turn-1-assistant-live', kind: 'message', role: 'assistant', text: '答案' },
    ]);
  });

  it('reconciles persisted and live content by turn, kind, and reasoning mode without duplication', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), rawDelta('thread-1', 'turn-1', 1, '分析续'));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 2, '答案续'));
    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        items: {
          'thread-1': [
            {
              id: 'item-turn-1-reasoning-raw',
              threadId: 'thread-1',
              turnId: 'turn-1',
              kind: 'reasoning',
              mode: 'raw',
              text: '分析',
              incomplete: true,
              createdAt: '2026-08-17T00:00:00.000Z',
            },
            {
              id: 'item-turn-1-assistant',
              threadId: 'thread-1',
              turnId: 'turn-1',
              kind: 'message',
              role: 'assistant',
              text: '答案',
              incomplete: true,
              createdAt: '2026-08-17T00:00:00.000Z',
            },
          ],
        },
      }),
    });

    expect(state.snapshot.items['thread-1']).toMatchObject([
      { id: 'item-turn-1-reasoning-raw', mode: 'raw', text: '分析续' },
      { id: 'item-turn-1-assistant', role: 'assistant', text: '答案续' },
    ]);
    expect(state.snapshot.items['thread-1']).toHaveLength(2);
  });

  it('restores the newest interrupted snapshot runtime for each thread', () => {
    const state = reduceAgentEvent(emptyAgentClientState(), {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-old',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'interrupted',
            createdAt: '2026-08-17T00:00:00.000Z',
            incomplete: true,
          },
          {
            id: 'turn-new',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'interrupted',
            createdAt: '2026-08-17T00:01:00.000Z',
            completedAt: '2026-08-17T00:02:00.000Z',
            error: 'Application restarted.',
            incomplete: true,
          },
        ],
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({
      turnId: 'turn-new',
      status: 'interrupted',
      error: 'Application restarted.',
      completedAt: Date.parse('2026-08-17T00:02:00.000Z'),
    });
  });

  it('applies queued cancellation and terminal events only to the matching thread', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), queued('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, started('thread-2', 'turn-2', 1));
    state = reduceAgentEvent(state, { type: 'turn.cancelled', ...envelope('thread-1', 'turn-1', 2) });
    state = reduceAgentEvent(state, { type: 'turn.failed', ...envelope('thread-2', 'turn-2', 2), error: 'HTTP 503' });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'cancelled' });
    expect(state.runtimeByThread['thread-2']).toMatchObject({ turnId: 'turn-2', status: 'failed', error: 'HTTP 503' });

    state = reduceAgentEvent(state, started('thread-3', 'turn-3', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-3', 'turn-3', 2) });
    expect(state.runtimeByThread['thread-1'].status).toBe('cancelled');
    expect(state.runtimeByThread['thread-2'].status).toBe('failed');
    expect(state.runtimeByThread['thread-3'].status).toBe('completed');
  });

  it('maps internal agent events into dependency-free AG-UI boundary events', () => {
    expect(mapAgentEventToAgUiEvents({ type: 'message.delta', ...envelope('thread-1', 'turn-1', 2), text: 'hello' })).toEqual([
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
        ...envelope('thread-1', 'turn-1', 9),
        metrics: {
          reasoningRequested: 'disabled',
          reasoningProtocol: 'none',
          reasoningObserved: false,
          durationMs: 1_200,
          tokensPerSecond: 18.4,
          speedSource: 'client',
          usageSource: 'unavailable',
        },
      }),
    ).toEqual([
      {
        type: 'CUSTOM',
        name: 'model.metrics',
        threadId: 'thread-1',
        runId: 'turn-1',
        sequence: 9,
        value: {
          reasoningRequested: 'disabled',
          reasoningProtocol: 'none',
          reasoningObserved: false,
          durationMs: 1_200,
          tokensPerSecond: 18.4,
          speedSource: 'client',
          usageSource: 'unavailable',
        },
      },
    ]);
  });
});
