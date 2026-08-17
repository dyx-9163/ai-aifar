import type { MessageItem } from '../shared/domain.js';
import type { ChatMessage } from './modelProvider.js';

export function buildChatMessages(history: MessageItem[], limit = history.length): ChatMessage[] {
  return history
    .slice(Math.max(0, history.length - limit))
    .filter((item) => item.role === 'user' || item.role === 'assistant' || item.role === 'system')
    .map((item) => ({
      role: item.role,
      content: item.text,
    }));
}
