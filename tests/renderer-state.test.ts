import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import { emptyState, reduceEvent } from '../src/renderer/composables/useApp';

function deltaEvent(sequence: number): AgentEvent {
  return {
    type: 'message.delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence,
    text: 'Hello',
  };
}

function approvalEvent(): AgentEvent {
  return {
    type: 'approval.required',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence: 2,
    approvalId: 'approval-1',
    title: 'Approve change',
    description: 'Simulated write approval.',
  };
}

describe('renderer state reducer', () => {
  it('deduplicates events by thread and sequence', () => {
    const state = reduceEvent(emptyState(), deltaEvent(1));

    expect(reduceEvent(state, deltaEvent(1))).toEqual(state);
  });

  it('marks a required approval as pending', () => {
    const state = reduceEvent(emptyState(), approvalEvent());

    expect(state.pendingApproval?.status).toBe('pending');
  });
});
