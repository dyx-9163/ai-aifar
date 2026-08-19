import { describe, expect, it } from 'vitest';
import { buildChatMessages, compactHistoryMessageText } from '../src/agent/chatContext';
import type { MessageItem } from '../src/shared/domain';

function message(role: 'user' | 'assistant' | 'system', text: string, id: string): MessageItem {
  return {
    id,
    threadId: 'thread-1',
    kind: 'message',
    role,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('chat context compaction', () => {
  it('keeps short history messages untouched', () => {
    expect(compactHistoryMessageText('short answer')).toBe('short answer');
  });

  it('compacts oversized messages to head and tail with an omission notice', () => {
    const text = 'H'.repeat(2_800) + 'M'.repeat(2_000) + 'T'.repeat(2_800);
    const compacted = compactHistoryMessageText(text);
    expect(compacted.length).toBeLessThan(text.length);
    expect(compacted).toContain('omitted by local context compaction');
    expect(compacted.startsWith('H'.repeat(2_800))).toBe(true);
    expect(compacted.endsWith('T'.repeat(2_800))).toBe(true);
    expect(compacted).not.toContain('M'.repeat(2_000));
  });

  it('compacts older entries but keeps the latest message intact', () => {
    const huge = 'x'.repeat(10_000);
    const messages = buildChatMessages([
      message('user', 'first request', 'm1'),
      message('assistant', huge, 'm2'),
      message('user', huge, 'm3'),
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: expect.stringContaining('omitted by local context compaction') });
    expect(messages[2]).toEqual({ role: 'user', content: huge });
  });

  it('respects the message limit before compaction', () => {
    const messages = buildChatMessages(
      [
        message('user', 'old', 'm1'),
        message('assistant', 'old answer', 'm2'),
        message('user', 'new', 'm3'),
      ],
      2,
    );
    expect(messages.map((entry) => entry.content)).toEqual(['old answer', 'new']);
  });
});
