import type { ProviderProtocol } from '../../shared/domain.js';
import { anthropicMessagesAdapter } from './anthropicMessages.js';
import { openAiChatCompletionsAdapter } from './openAiChatCompletions.js';
import { openAiResponsesAdapter } from './openAiResponses.js';
import type { ProviderAdapter } from './types.js';

const adapters = new Map<ProviderProtocol, ProviderAdapter>([
  [openAiChatCompletionsAdapter.protocol, openAiChatCompletionsAdapter],
  [openAiResponsesAdapter.protocol, openAiResponsesAdapter],
  [anthropicMessagesAdapter.protocol, anthropicMessagesAdapter],
]);

export function providerAdapterFor(protocol: ProviderProtocol): ProviderAdapter {
  const adapter = adapters.get(protocol);
  if (!adapter) throw new Error(`Unsupported provider protocol: ${protocol}`);
  return adapter;
}
