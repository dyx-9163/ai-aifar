import { readSseDeltas, requestChatCompletion } from '../modelProvider.js';
import type { ProviderAdapter } from './types.js';
import { adapterHeaders, requireResponseBody } from './types.js';

export const openAiChatCompletionsAdapter: ProviderAdapter = {
  protocol: 'openai-chat-completions',
  async stream(input) {
    const response = await requestChatCompletion(
      input.profile,
      input.messages,
      adapterHeaders(input, 'openai'),
      input.signal,
      input.fetchImpl,
      input.tools,
    );
    return readSseDeltas(
      requireResponseBody(response),
      input.handlers,
      input.signal,
      input.allowLengthWithoutAnswer,
    );
  },
};
