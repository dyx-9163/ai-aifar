import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import { runDemoTurn, type DemoTurnInput } from '../src/agent/demoAgent';
import { createTurnEventEmitter } from '../src/agent/worker';

function input(text: string): DemoTurnInput {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    text,
  };
}

describe('demo agent runtime', () => {
  it('sequences each turn independently and closes the stream after a terminal event', async () => {
    const events: AgentEvent[] = [];
    const first = createTurnEventEmitter('thread-1', 'turn-1', 'model-1', async (event) => {
      events.push(event);
    });
    const second = createTurnEventEmitter('thread-2', 'turn-2', 'model-2', async (event) => {
      events.push(event);
    });

    await Promise.all([
      first({ type: 'turn.queued', queuePosition: 1 }),
      second({ type: 'turn.started', title: 'second' }),
      first({ type: 'turn.started', title: 'first' }),
      second({ type: 'answer.delta', text: 'answer' }),
      first({ type: 'reasoning.raw.delta', text: 'raw' }),
      second({ type: 'turn.completed' }),
      first({ type: 'reasoning.summary.delta', text: 'summary' }),
      first({ type: 'turn.failed', error: 'failed' }),
    ]);
    await second({ type: 'answer.delta', text: 'late' });
    await second({ type: 'turn.cancelled' });

    expect(events.filter((event) => event.type !== 'snapshot' && event.turnId === 'turn-1').map((event) => event.sequence))
      .toEqual([1, 2, 3, 4, 5]);
    expect(events.filter((event) => event.type !== 'snapshot' && event.turnId === 'turn-2').map((event) => event.sequence))
      .toEqual([1, 2, 3]);
    expect(events.some((event) => event.type === 'answer.delta' && event.text === 'late')).toBe(false);
    expect(events.filter((event) => event.type === 'turn.cancelled')).toHaveLength(0);
  });

  it('streams a visible response in sequence order', async () => {
    const events: AgentEvent[] = [];

    await runDemoWithLifecycle(input('Summarize this workspace'), events);

    expect(events.map((event) => ('sequence' in event ? event.sequence : 0))).toEqual(
      [...events.map((event) => ('sequence' in event ? event.sequence : 0))].sort((a, b) => a - b),
    );
    expect(events.some((event) => event.type === 'message.delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  it('requests approval for a simulated write request', async () => {
    const events: AgentEvent[] = [];

    await runDemoWithLifecycle(input('修改配置文件'), events);

    expect(events.some((event) => event.type === 'approval.required')).toBe(true);
    expect(events.some((event) => event.type === 'tool.output' && event.output.includes('No filesystem changes'))).toBe(true);
  });
});

async function runDemoWithLifecycle(input: DemoTurnInput, events: AgentEvent[]): Promise<void> {
  const next = createTurnEventEmitter(input.threadId, input.turnId, input.modelProfileId ?? '__demo__', async (event) => {
    events.push(event);
  });
  await next({ type: 'turn.started', title: input.text });
  const outcome = await runDemoTurn(input, next, new AbortController().signal);
  if (outcome === 'completed') await next({ type: 'turn.completed' });
}
