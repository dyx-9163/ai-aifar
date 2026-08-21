import type { ChatContentPart, ChatMessage, NativeStreamedToolCall, StreamedMetrics } from '../modelProvider.js';
import type { NativeToolSchema } from '../tools/toolSchemas.js';
import type { ProviderAdapter, ProviderStreamInput } from './types.js';
import { adapterHeaders, mergeCustomFields, readProviderSse, requireResponseBody } from './types.js';

export const anthropicMessagesAdapter: ProviderAdapter = {
  protocol: 'anthropic-messages',
  async stream(input) {
    const response = await input.fetchImpl(`${input.profile.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: adapterHeaders(input, 'anthropic'),
      signal: input.signal,
      body: JSON.stringify(anthropicBody(input)),
    });
    return readAnthropicStream(requireResponseBody(response), input);
  },
};

function anthropicBody(input: ProviderStreamInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.profile.model,
    messages: toAnthropicMessages(input.messages),
    stream: true,
    max_tokens: input.profile.maxOutputTokens,
  };
  const system = input.messages.filter((message) => message.role === 'system').map((message) => contentAsText(message.content)).join('\n\n');
  if (system) body.system = system;
  if (input.tools?.length) body.tools = toAnthropicTools(input.tools);
  if (input.profile.thinkingMode === 'custom') {
    mergeCustomFields(body, input.profile.customRequestBody, ['model', 'messages', 'system', 'stream', 'max_tokens', 'tools']);
  }
  return body;
}

function toAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: contentAsText(message.content) }] });
      continue;
    }
    const content: unknown[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(anthropicContentPart);
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: 'tool_use', id: call.id, name: call.function.name,
        input: parseArgumentsOrEmpty(call.function.arguments),
      });
    }
    result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return result;
}

function anthropicContentPart(part: ChatContentPart): Record<string, unknown> {
  if (part.type === 'text') return part;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
  if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  return { type: 'image', source: { type: 'url', url: part.image_url.url } };
}

function toAnthropicTools(tools: readonly NativeToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  input: ProviderStreamInput,
): Promise<StreamedMetrics> {
  const metrics: StreamedMetrics = {};
  const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
  let answerObserved = false;
  let toolObserved = false;
  let stopped = false;

  const finishTools = async () => {
    const calls: NativeStreamedToolCall[] = [...blocks.values()]
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: parseArguments(block.name, block.json) }));
    blocks.clear();
    toolObserved ||= calls.length > 0;
    if (calls.length) await input.handlers.onNativeToolCalls?.(calls);
  };

  await readProviderSse(body, input.signal, async ({ event, data }) => {
    let payload: Record<string, any>;
    try { payload = JSON.parse(data) as Record<string, any>; }
    catch { throw new Error('Anthropic Messages stream returned malformed JSON.'); }
    if (event === 'error') throw new Error('Anthropic Messages request failed.');
    if (event === 'message_start') {
      const usage = payload.message?.usage;
      if (typeof usage?.input_tokens === 'number') metrics.promptTokens = usage.input_tokens;
      if (typeof usage?.output_tokens === 'number') metrics.completionTokens = usage.output_tokens;
    } else if (event === 'content_block_start') {
      const block = payload.content_block ?? {};
      blocks.set(Number(payload.index), {
        type: String(block.type ?? ''), id: String(block.id ?? ''), name: String(block.name ?? ''),
        json: block.type === 'tool_use' && block.input ? JSON.stringify(block.input) : '',
      });
    } else if (event === 'content_block_delta') {
      const delta = payload.delta ?? {};
      const block = blocks.get(Number(payload.index));
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        metrics.reasoningObserved = true;
        await input.handlers.onPhase('reasoning');
        await input.handlers.onRawReasoningDelta(delta.thinking);
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        answerObserved ||= delta.text.length > 0;
        await input.handlers.onPhase('answering');
        await input.handlers.onAnswerDelta(delta.text);
      } else if (delta.type === 'input_json_delta' && block && typeof delta.partial_json === 'string') {
        block.json += delta.partial_json;
      }
    } else if (event === 'message_delta') {
      if (typeof payload.usage?.output_tokens === 'number') metrics.completionTokens = payload.usage.output_tokens;
      metrics.finishReason = payload.delta?.stop_reason === 'max_tokens' ? 'length' : String(payload.delta?.stop_reason ?? 'stop');
    } else if (event === 'message_stop') {
      stopped = true;
      await finishTools();
      return true;
    }
    return false;
  });
  await finishTools();
  if (typeof metrics.promptTokens === 'number' && typeof metrics.completionTokens === 'number') {
    metrics.totalTokens = metrics.promptTokens + metrics.completionTokens;
  }
  if (!stopped) throw new Error('Anthropic Messages stream ended before message_stop.');
  if (!answerObserved && !toolObserved && metrics.finishReason !== 'length') throw new Error('Model stream ended without producing a final answer.');
  return metrics;
}

function parseArguments(name: string, text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text.trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Model returned tool call "${name}" with invalid JSON arguments.`);
  }
}

function parseArgumentsOrEmpty(text: string): Record<string, unknown> {
  try { return JSON.parse(text || '{}') as Record<string, unknown>; }
  catch { return {}; }
}

function contentAsText(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : content.map((part) => part.type === 'text' ? part.text : '[Image]').join('\n');
}
