import type { MessageItem } from '../shared/domain.js';
import type { ChatMessage } from './modelProvider.js';

/** Older history entries are capped so one huge answer cannot bloat the next prompt. */
const HISTORY_MESSAGE_MAX_CHARS = 6_000;
const HISTORY_MESSAGE_HEAD_CHARS = 2_800;
const HISTORY_MESSAGE_TAIL_CHARS = 2_800;
const HISTORY_OMISSION_NOTICE = '[… middle of this message omitted by local context compaction …]';

/** Keeps the head and tail of an oversized history message and marks the omitted middle. */
export function compactHistoryMessageText(text: string): string {
  if (text.length <= HISTORY_MESSAGE_MAX_CHARS) return text;
  return [
    text.slice(0, HISTORY_MESSAGE_HEAD_CHARS),
    HISTORY_OMISSION_NOTICE,
    text.slice(text.length - HISTORY_MESSAGE_TAIL_CHARS),
  ].join('\n');
}

export function buildChatMessages(history: MessageItem[], limit = history.length): ChatMessage[] {
  const sliced = history
    .slice(Math.max(0, history.length - limit))
    .filter((item) => item.role === 'user' || item.role === 'assistant' || item.role === 'system');
  return sliced.map((item, index) => ({
    role: item.role,
    // The latest message is the active request and stays intact; older entries may be compacted.
    content: index === sliced.length - 1 ? item.text : compactHistoryMessageText(item.text),
  }));
}
