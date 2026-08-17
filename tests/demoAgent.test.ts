import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import { runDemoTurn, type DemoTurnInput } from '../src/agent/demoAgent';

function input(text: string): DemoTurnInput {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    text,
  };
}

describe('demo agent runtime', () => {
  it('streams a visible response in sequence order', async () => {
    const events: AgentEvent[] = [];

    await runDemoTurn(input('Summarize this workspace'), (event) => events.push(event), new AbortController().signal);

    expect(events.map((event) => ('sequence' in event ? event.sequence : 0))).toEqual(
      [...events.map((event) => ('sequence' in event ? event.sequence : 0))].sort((a, b) => a - b),
    );
    expect(events.some((event) => event.type === 'message.delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  it('requests approval for a simulated write request', async () => {
    const events: AgentEvent[] = [];

    await runDemoTurn(input('修改配置文件'), (event) => events.push(event), new AbortController().signal);

    expect(events.some((event) => event.type === 'approval.required')).toBe(true);
    expect(events.some((event) => event.type === 'tool.output' && event.output.includes('No filesystem changes'))).toBe(true);
  });
});
