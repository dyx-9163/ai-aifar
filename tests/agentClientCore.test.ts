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

function historicalTurnsSnapshot(
  oldStatus: AppSnapshot['turns'][number]['status'] = 'completed',
  newestStatus: AppSnapshot['turns'][number]['status'] = 'completed',
): AgentEvent {
  return {
    type: 'snapshot',
    snapshot: snapshotFixture({
      turns: [
        {
          id: 'turn-old',
          threadId: 'thread-1',
          status: oldStatus,
          createdAt: '2026-08-17T00:00:00.000Z',
          startedAt: oldStatus === 'interrupted' ? '2026-08-17T00:00:01.000Z' : undefined,
          completedAt: oldStatus === 'running' ? undefined : '2026-08-17T00:00:30.000Z',
          error: oldStatus === 'failed' ? 'old failure' : undefined,
          incomplete: oldStatus !== 'completed',
        },
        {
          id: 'turn-new',
          threadId: 'thread-1',
          status: newestStatus,
          createdAt: '2026-08-17T00:01:00.000Z',
          completedAt: newestStatus === 'running' ? undefined : '2026-08-17T00:01:30.000Z',
          error: newestStatus === 'failed' ? 'new failure' : undefined,
          incomplete: newestStatus !== 'completed',
        },
      ],
    }),
  };
}

describe('Agent Client Core', () => {
  it('keeps desktop snapshots, active chat, and optimistic messages in one pure state model', () => {
    const snapshot: AgentEvent = {
      type: 'snapshot',
      snapshot: snapshotFixture({
        threads: [
          {
            id: 'thread-1',
            workspaceId: 'ws-1',
            pinned: false,
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
    expect(withAssistant.snapshot.threads[0]).toMatchObject({ workspaceId: 'ws-1', pinned: false });
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

  it('keeps a background approval scoped away from the active thread inspector', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), {
      type: 'snapshot',
      snapshot: snapshotFixture({
        threads: [
          {
            id: 'thread-1', pinned: false, title: 'Active', status: 'running',
            createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
          },
          {
            id: 'thread-2', pinned: false, title: 'Background', status: 'running',
            createdAt: '2026-08-17T00:00:01.000Z', updatedAt: '2026-08-17T00:00:01.000Z',
          },
        ],
        approvals: [{
          id: 'approval-active', threadId: 'thread-1', turnId: 'turn-1', title: 'Active approval',
          description: 'Visible', status: 'pending', createdAt: '2026-08-17T00:00:02.000Z',
        }],
      }),
    });

    state = reduceAgentEvent(state, {
      type: 'approval.required', ...envelope('thread-2', 'turn-2', 1), approvalId: 'approval-background',
      title: 'Background approval', description: 'Must not replace the active approval',
    });

    expect(state.activeThreadId).toBe('thread-1');
    expect(state.pendingApproval?.id).toBe('approval-active');
    expect(state.snapshot.approvals).toContainEqual(expect.objectContaining({
      id: 'approval-background', threadId: 'thread-2', turnId: 'turn-2', status: 'pending',
    }));
  });

  it('carries the file-change diff from approval events into the pending approval', () => {
    let state = { ...emptyAgentClientState(), activeThreadId: 'thread-1' };
    state = reduceAgentEvent(state, started('thread-1', 'turn-1', 1));
    const fileChange = {
      relativePath: 'src/new.ts',
      action: 'created' as const,
      lines: [{ kind: 'added' as const, text: 'export const fresh = true;' }],
    };
    state = reduceAgentEvent(state, {
      type: 'approval.required', ...envelope('thread-1', 'turn-1', 2), approvalId: 'approval-diff',
      title: 'Edit file: src/new.ts', description: 'The agent wants to create "src/new.ts" in the workspace.',
      fileChange,
    });

    expect(state.pendingApproval?.id).toBe('approval-diff');
    expect(state.pendingApproval?.fileChange).toEqual(fileChange);
    expect(state.snapshot.approvals).toContainEqual(expect.objectContaining({
      id: 'approval-diff', fileChange, status: 'pending',
    }));
  });

  it('tracks two running chats independently', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, started('thread-2', 'turn-2', 1));

    expect(state.runtimeByThread).toMatchObject({
      'thread-1': { turnId: 'turn-1', status: 'running' },
      'thread-2': { turnId: 'turn-2', status: 'running' },
    });
  });

  it.each([
    {
      name: 'queued',
      event: queued('thread-1', 'turn-1', 1),
      want: { turnId: 'turn-1', modelProfileId: 'model-1', status: 'queued', queuePosition: 1 },
    },
    {
      name: 'started',
      event: started('thread-1', 'turn-1', 1),
      want: { turnId: 'turn-1', modelProfileId: 'model-1', status: 'running' },
    },
    {
      name: 'answer delta',
      event: answerDelta('thread-1', 'turn-1', 1, 'answer'),
      want: { turnId: 'turn-1', modelProfileId: 'model-1', status: 'running' },
    },
    {
      name: 'model progress',
      event: {
        type: 'model.progress' as const,
        ...envelope('thread-1', 'turn-1', 1),
        phase: 'reasoning' as const,
      },
      want: { turnId: 'turn-1', modelProfileId: 'model-1', status: 'running' },
    },
  ])('derives $name state when the first worker event claims an optimistic placeholder', ({ event, want }) => {
    const optimistic = {
      ...emptyAgentClientState(),
      runtimeByThread: {
        'thread-1': { threadId: 'thread-1', status: 'queued' as const },
      },
      optimisticThreads: { 'thread-1': true as const },
    };

    const claimed = reduceAgentEvent(optimistic, event);

    expect(claimed.runtimeByThread['thread-1']).toMatchObject(want);
    expect(claimed.currentTurnByThread['thread-1']).toBe('turn-1');
    expect(claimed.optimisticThreads['thread-1']).toBeUndefined();
  });

  it.each([
    answerDelta('thread-1', 'turn-1', 1, 'answer'),
    {
      type: 'model.progress' as const,
      ...envelope('thread-1', 'turn-1', 1),
      phase: 'answering' as const,
    },
  ])('does not downgrade a running turn when queued arrives after $type', (firstEvent) => {
    const optimistic = {
      ...emptyAgentClientState(),
      runtimeByThread: {
        'thread-1': { threadId: 'thread-1', status: 'queued' as const },
      },
      optimisticThreads: { 'thread-1': true as const },
    };

    let state = reduceAgentEvent(optimistic, firstEvent);
    state = reduceAgentEvent(state, { ...queued('thread-1', 'turn-1', 1), sequence: 2 });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });
    expect(state.runtimeByThread['thread-1'].queuePosition).toBeUndefined();
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
    state = reduceAgentEvent(state, { type: 'turn.cancelling', ...envelope('thread-1', 'turn-1', 2) });
    state = reduceAgentEvent(state, { type: 'turn.failed', ...envelope('thread-2', 'turn-2', 2), error: 'HTTP 503' });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'cancelling' });
    expect(state.runtimeByThread['thread-2']).toMatchObject({ turnId: 'turn-2', status: 'failed', error: 'HTTP 503' });

    state = reduceAgentEvent(state, { type: 'turn.cancelled', ...envelope('thread-1', 'turn-1', 3) });
    state = reduceAgentEvent(state, started('thread-3', 'turn-3', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-3', 'turn-3', 2) });
    expect(state.runtimeByThread['thread-1'].status).toBe('cancelled');
    expect(state.runtimeByThread['thread-2'].status).toBe('failed');
    expect(state.runtimeByThread['thread-3'].status).toBe('completed');
  });

  it('does not let a stale snapshot roll back a live terminal runtime or complete content', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-live', 1));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-live', 2, '完整答案'));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-live', 3) });

    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [{
          id: 'turn-live',
          threadId: 'thread-1',
          modelProfileId: 'model-1',
          status: 'queued',
          createdAt: '2026-08-17T00:00:00.000Z',
          incomplete: true,
        }],
        items: {
          'thread-1': [{
            id: 'item-turn-live-assistant',
            threadId: 'thread-1',
            turnId: 'turn-live',
            kind: 'message',
            role: 'assistant',
            text: '完整',
            incomplete: true,
            createdAt: '2026-08-17T00:00:01.000Z',
          }],
        },
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-live', status: 'completed' });
    expect(state.snapshot.items['thread-1']).toMatchObject([
      { turnId: 'turn-live', text: '完整答案', incomplete: false },
    ]);
  });

  it.each([
    { type: 'turn.failed' as const, error: 'HTTP 503', wantStatus: 'failed' as const },
    { type: 'turn.cancelled' as const, wantStatus: 'cancelled' as const },
  ])('does not let stale complete item metadata override a live $wantStatus turn', (terminal) => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-live', 1));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-live', 2, '部分答案'));
    state = reduceAgentEvent(state, {
      ...terminal,
      threadId: 'thread-1',
      turnId: 'turn-live',
      modelProfileId: 'model-1',
      sequence: 3,
    });

    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [{
          id: 'turn-live',
          threadId: 'thread-1',
          modelProfileId: 'model-1',
          status: 'running',
          createdAt: '2026-08-17T00:00:00.000Z',
          startedAt: '2026-08-17T00:00:01.000Z',
          incomplete: true,
        }],
        items: {
          'thread-1': [{
            id: 'item-turn-live-assistant',
            threadId: 'thread-1',
            turnId: 'turn-live',
            kind: 'message',
            role: 'assistant',
            text: '部分答案',
            incomplete: false,
            createdAt: '2026-08-17T00:00:02.000Z',
          }],
        },
      }),
    });

    expect(state.runtimeByThread['thread-1'].status).toBe(terminal.wantStatus);
    expect(state.snapshot.items['thread-1']).toMatchObject([{ incomplete: true }]);
  });

  it('accepts a newer terminal snapshot for the live current turn', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 2, '答案'));
    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [{
          id: 'turn-1',
          threadId: 'thread-1',
          modelProfileId: 'model-1',
          status: 'completed',
          createdAt: '2026-08-17T00:00:00.000Z',
          startedAt: '2026-08-17T00:00:01.000Z',
          completedAt: '2026-08-17T00:00:02.000Z',
          incomplete: false,
        }],
        items: {
          'thread-1': [{
            id: 'item-turn-1-assistant',
            threadId: 'thread-1',
            turnId: 'turn-1',
            kind: 'message',
            role: 'assistant',
            text: '答案',
            incomplete: false,
            createdAt: '2026-08-17T00:00:01.000Z',
          }],
        },
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'completed' });
    expect(state.snapshot.items['thread-1']).toMatchObject([{ text: '答案', incomplete: false }]);
  });

  it('selects the newest snapshot turn overall before mapping its terminal status', () => {
    const sameCreatedAt = '2026-08-17T00:00:00.000Z';
    const state = reduceAgentEvent(emptyAgentClientState(), {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-z-old',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'interrupted',
            createdAt: sameCreatedAt,
            startedAt: '2026-08-17T00:01:00.000Z',
            incomplete: true,
          },
          {
            id: 'turn-a-new',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'completed',
            createdAt: sameCreatedAt,
            startedAt: '2026-08-17T00:02:00.000Z',
            completedAt: '2026-08-17T00:03:00.000Z',
            incomplete: false,
          },
        ],
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-a-new', status: 'completed' });
  });

  it('uses turn id as a stable tie-breaker when all snapshot timestamps match', () => {
    const timestamp = '2026-08-17T00:00:00.000Z';
    const state = reduceAgentEvent(emptyAgentClientState(), {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-a',
            threadId: 'thread-1',
            status: 'interrupted',
            createdAt: timestamp,
            startedAt: timestamp,
            completedAt: timestamp,
            incomplete: true,
          },
          {
            id: 'turn-z',
            threadId: 'thread-1',
            status: 'failed',
            createdAt: timestamp,
            startedAt: timestamp,
            completedAt: timestamp,
            error: 'stable winner',
            incomplete: true,
          },
        ],
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({
      turnId: 'turn-z',
      status: 'failed',
      error: 'stable winner',
    });
  });

  it.each([
    { name: 'queued', event: queued('thread-1', 'turn-old', 2) },
    { name: 'started', event: started('thread-1', 'turn-old', 1) },
    { name: 'answer delta', event: answerDelta('thread-1', 'turn-old', 1, 'late') },
    { name: 'terminal', event: { type: 'turn.completed' as const, ...envelope('thread-1', 'turn-old', 1) } },
  ])('keeps the newest completed snapshot turn current after a historical $name event', ({ event }) => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot());

    const afterLateEvent = reduceAgentEvent(loaded, event);

    expect(loaded.supersededTurns['thread-1:turn-old']).toBe(true);
    expect(afterLateEvent.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'completed' });
  });

  it('keeps a newer terminal snapshot turn current when an older interrupted turn starts late', () => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot('interrupted', 'failed'));

    const afterLateStart = reduceAgentEvent(loaded, started('thread-1', 'turn-old', 1));

    expect(afterLateStart.runtimeByThread['thread-1']).toMatchObject({
      turnId: 'turn-new',
      status: 'failed',
      error: 'new failure',
    });
  });

  it('does not let snapshot history claim an optimistic window', () => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot());
    const optimistic = {
      ...loaded,
      runtimeByThread: {
        ...loaded.runtimeByThread,
        'thread-1': { threadId: 'thread-1', status: 'queued' as const },
      },
      optimisticThreads: { ...loaded.optimisticThreads, 'thread-1': true as const },
    };

    const afterLateStart = reduceAgentEvent(optimistic, started('thread-1', 'turn-old', 1));

    expect(afterLateStart.runtimeByThread['thread-1']).toMatchObject({ status: 'queued' });
    expect(afterLateStart.runtimeByThread['thread-1'].turnId).toBeUndefined();
    expect(afterLateStart.optimisticThreads['thread-1']).toBe(true);

    const afterFutureStart = reduceAgentEvent(afterLateStart, started('thread-1', 'turn-future', 1));
    expect(afterFutureStart.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-future', status: 'running' });
    expect(afterFutureStart.optimisticThreads['thread-1']).toBeUndefined();
  });

  it('lets a worker snapshot turn claim a first-turn optimistic placeholder', () => {
    let state = {
      ...emptyAgentClientState(),
      runtimeByThread: {
        'thread-1': { threadId: 'thread-1', status: 'queued' as const },
      },
      optimisticThreads: { 'thread-1': true as const },
    };

    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-old',
            threadId: 'thread-1',
            status: 'completed',
            createdAt: '2026-08-17T00:00:00.000Z',
            incomplete: false,
          },
          {
            id: 'turn-real',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'queued',
            createdAt: '2026-08-17T00:01:00.000Z',
            incomplete: true,
          },
        ],
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-real', status: 'queued' });
    expect(state.currentTurnByThread['thread-1']).toBe('turn-real');
    expect(state.optimisticThreads['thread-1']).toBeUndefined();
    expect(state.supersededTurns['thread-1:turn-old']).toBe(true);
    expect(state.supersededTurns['thread-1:turn-real']).toBeUndefined();

    state = reduceAgentEvent(state, started('thread-1', 'turn-real', 1));
    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-real', status: 'running' });
  });

  it('treats a stale snapshot as history when its live current turn is not persisted yet', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-live', 1));
    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [{
          id: 'turn-old',
          threadId: 'thread-1',
          status: 'completed',
          createdAt: '2026-08-17T00:00:00.000Z',
          incomplete: false,
        }],
      }),
    });

    expect(state.supersededTurns['thread-1:turn-old']).toBe(true);
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-live', 2) });
    state = reduceAgentEvent(state, started('thread-1', 'turn-old', 1));
    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-live', status: 'completed' });

    state = reduceAgentEvent(state, started('thread-1', 'turn-future', 1));
    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-future', status: 'running' });
  });

  it('does not mark a genuinely future turn as superseded when loading snapshot history', () => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot());

    const afterFutureStart = reduceAgentEvent(loaded, started('thread-1', 'turn-future', 1));

    expect(loaded.supersededTurns['thread-1:turn-future']).toBeUndefined();
    expect(afterFutureStart.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-future', status: 'running' });
  });

  it.each([
    { name: 'answer', event: answerDelta('thread-1', 'turn-old', 1, 'answer'), kind: 'message', mode: undefined },
    { name: 'raw reasoning', event: rawDelta('thread-1', 'turn-old', 1, 'raw'), kind: 'reasoning', mode: 'raw' },
    { name: 'summary reasoning', event: summaryDelta('thread-1', 'turn-old', 1, 'summary'), kind: 'reasoning', mode: 'summary' },
  ])('keeps late $name content complete for a historical completed snapshot turn', ({ event, kind, mode }) => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot());

    const afterLateDelta = reduceAgentEvent(loaded, event);

    expect(afterLateDelta.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'completed' });
    expect(afterLateDelta.snapshot.items['thread-1']).toContainEqual(expect.objectContaining({
      turnId: 'turn-old',
      kind,
      ...(mode ? { mode } : {}),
      incomplete: false,
    }));
  });

  it.each([
    { status: 'failed' as const, incomplete: true },
    { status: 'cancelled' as const, incomplete: true },
    { status: 'interrupted' as const, incomplete: true },
  ])('keeps late content incomplete for a historical $status snapshot turn', ({ status, incomplete }) => {
    const loaded = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot(status));

    const afterLateDelta = reduceAgentEvent(loaded, answerDelta('thread-1', 'turn-old', 1, 'late'));

    expect(afterLateDelta.snapshot.items['thread-1']).toContainEqual(expect.objectContaining({
      turnId: 'turn-old',
      incomplete: true,
    }));
  });

  it('synchronizes historical terminal knowledge after a snapshot refresh', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot('running'));
    state = reduceAgentEvent(state, historicalTurnsSnapshot('completed'));

    state = reduceAgentEvent(state, rawDelta('thread-1', 'turn-old', 1, 'late raw'));

    expect(state.snapshot.items['thread-1']).toContainEqual(expect.objectContaining({
      turnId: 'turn-old',
      mode: 'raw',
      incomplete: false,
    }));
  });

  it.each([
    {
      snapshotStatus: 'completed' as const,
      terminal: { type: 'turn.failed' as const, error: 'late failure' },
      wantIncomplete: false,
    },
    {
      snapshotStatus: 'failed' as const,
      terminal: { type: 'turn.completed' as const },
      wantIncomplete: true,
    },
    {
      snapshotStatus: 'completed' as const,
      terminal: { type: 'turn.completed' as const },
      wantIncomplete: false,
    },
    {
      snapshotStatus: 'failed' as const,
      terminal: { type: 'turn.failed' as const, error: 'same failure' },
      wantIncomplete: true,
    },
  ])(
    'keeps snapshot $snapshotStatus as the first-known historical terminal after duplicate $terminal.type events',
    ({ snapshotStatus, terminal, wantIncomplete }) => {
      let state = reduceAgentEvent(emptyAgentClientState(), historicalTurnsSnapshot(snapshotStatus));
      state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-old', 1, 'late answer'));
      state = reduceAgentEvent(state, {
        ...terminal,
        ...envelope('thread-1', 'turn-old', 2),
      });
      state = reduceAgentEvent(state, {
        ...terminal,
        ...envelope('thread-1', 'turn-old', 3),
      });

      expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'completed' });
      expect(state.snapshot.items['thread-1']).toContainEqual(expect.objectContaining({
        turnId: 'turn-old',
        incomplete: wantIncomplete,
      }));
    },
  );

  it.each([
    {
      snapshotStatus: 'completed' as const,
      terminal: { type: 'turn.failed' as const, error: 'late failure' },
      wantIncomplete: false,
    },
    {
      snapshotStatus: 'failed' as const,
      terminal: { type: 'turn.completed' as const },
      wantIncomplete: true,
    },
  ])(
    'keeps a current snapshot $snapshotStatus runtime consistent after conflicting $terminal.type',
    ({ snapshotStatus, terminal, wantIncomplete }) => {
      let state = reduceAgentEvent(emptyAgentClientState(), {
        type: 'snapshot',
        snapshot: snapshotFixture({
          turns: [{
            id: 'turn-current',
            threadId: 'thread-1',
            status: snapshotStatus,
            createdAt: '2026-08-17T00:00:00.000Z',
            incomplete: wantIncomplete,
          }],
        }),
      });
      state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-current', 1, 'answer'));
      state = reduceAgentEvent(state, { ...terminal, ...envelope('thread-1', 'turn-current', 2) });

      expect(state.runtimeByThread['thread-1'].status).toBe(snapshotStatus);
      expect(state.snapshot.items['thread-1']).toMatchObject([{ incomplete: wantIncomplete }]);
    },
  );

  it.each([
    {
      terminal: { type: 'turn.completed' as const },
      staleStatus: 'failed' as const,
      staleIncomplete: true,
      wantIncomplete: false,
    },
    {
      terminal: { type: 'turn.failed' as const, error: 'live failure' },
      staleStatus: 'completed' as const,
      staleIncomplete: false,
      wantIncomplete: true,
    },
  ])('keeps superseded live terminal metadata when snapshot says $staleStatus', (input) => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-old', 1));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-old', 2, '旧答案'));
    state = reduceAgentEvent(state, {
      ...input.terminal,
      threadId: 'thread-1',
      turnId: 'turn-old',
      modelProfileId: 'model-1',
      sequence: 3,
    });
    state = reduceAgentEvent(state, started('thread-1', 'turn-new', 1));

    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-old',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: input.staleStatus,
            createdAt: '2026-08-17T00:00:00.000Z',
            startedAt: '2026-08-17T00:00:01.000Z',
            completedAt: '2026-08-17T00:00:02.000Z',
            incomplete: input.staleStatus !== 'completed',
          },
          {
            id: 'turn-new',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'running',
            createdAt: '2026-08-17T00:01:00.000Z',
            startedAt: '2026-08-17T00:01:01.000Z',
            incomplete: true,
          },
        ],
        items: {
          'thread-1': [{
            id: 'item-turn-old-assistant',
            threadId: 'thread-1',
            turnId: 'turn-old',
            kind: 'message',
            role: 'assistant',
            text: '旧答案',
            incomplete: input.staleIncomplete,
            createdAt: '2026-08-17T00:00:01.000Z',
          }],
        },
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'running' });
    expect(state.snapshot.items['thread-1']).toMatchObject([{ turnId: 'turn-old', incomplete: input.wantIncomplete }]);
  });

  it('keeps a new running turn current while sealing content from superseded turn events', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-old', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-old', 2) });
    state = reduceAgentEvent(state, queued('thread-1', 'turn-new', 1));
    state = reduceAgentEvent(state, started('thread-1', 'turn-new', 2));

    state = reduceAgentEvent(state, started('thread-1', 'turn-old', 3));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-old', 4, '迟到答案'));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-old', 5) });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'running' });
    expect(state.snapshot.items['thread-1']).toContainEqual(expect.objectContaining({
      turnId: 'turn-old',
      text: '迟到答案',
      incomplete: false,
    }));
  });

  it('does not let superseded nonterminal or terminal events replace a new terminal runtime', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-old', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-old', 2) });
    state = reduceAgentEvent(state, started('thread-1', 'turn-new', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-new', 2) });

    state = reduceAgentEvent(state, started('thread-1', 'turn-old', 3));
    state = reduceAgentEvent(state, { type: 'turn.failed', ...envelope('thread-1', 'turn-old', 4), error: 'late failure' });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'completed' });
  });

  it.each([
    {
      first: { type: 'turn.completed' as const },
      second: { type: 'turn.failed' as const, error: 'late conflicting failure' },
      wantStatus: 'completed' as const,
      wantIncomplete: false,
    },
    {
      first: { type: 'turn.failed' as const, error: 'first failure' },
      second: { type: 'turn.completed' as const },
      wantStatus: 'failed' as const,
      wantIncomplete: true,
    },
  ])('keeps the first terminal projection when a conflicting $second.type arrives', (input) => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-1', 1));
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 2, '答案'));
    state = reduceAgentEvent(state, {
      ...input.first,
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelProfileId: 'model-1',
      sequence: 3,
    });
    state = reduceAgentEvent(state, {
      ...input.second,
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelProfileId: 'model-1',
      sequence: 4,
    });

    expect(state.runtimeByThread['thread-1'].status).toBe(input.wantStatus);
    expect(state.snapshot.items['thread-1']).toMatchObject([{ incomplete: input.wantIncomplete }]);
  });

  it('keeps completed content sealed when a later delta is retained for the same turn', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), answerDelta('thread-1', 'turn-1', 1, '前'));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-1', 2) });
    state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 3, '后'));

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'completed' });
    expect(state.snapshot.items['thread-1']).toMatchObject([{ text: '前后', incomplete: false }]);
  });

  it('accepts a complete snapshot chain that contains a newer turn after the live terminal', () => {
    let state = reduceAgentEvent(emptyAgentClientState(), started('thread-1', 'turn-old', 1));
    state = reduceAgentEvent(state, { type: 'turn.completed', ...envelope('thread-1', 'turn-old', 2) });
    state = reduceAgentEvent(state, {
      type: 'snapshot',
      snapshot: snapshotFixture({
        turns: [
          {
            id: 'turn-old',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'completed',
            createdAt: '2026-08-17T00:00:00.000Z',
            completedAt: '2026-08-17T00:00:01.000Z',
            incomplete: false,
          },
          {
            id: 'turn-new',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'running',
            createdAt: '2026-08-17T00:01:00.000Z',
            startedAt: '2026-08-17T00:01:01.000Z',
            incomplete: true,
          },
        ],
      }),
    });

    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'running' });
    expect(state.supersededTurns['thread-1:turn-old']).toBe(true);
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
