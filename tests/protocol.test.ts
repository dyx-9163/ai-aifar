import { describe, expect, it } from 'vitest';
import { isAgentEvent, isDesktopRequest } from '../src/shared/protocol';

describe('desktop protocol guards', () => {
  it('rejects a turn request without text', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1' })).toBe(false);
  });

  it('accepts a streamed message event', () => {
    expect(
      isAgentEvent({
        type: 'message.delta',
        threadId: 't1',
        turnId: 'u1',
        sequence: 1,
        text: 'Hi',
      }),
    ).toBe(true);
  });
});
