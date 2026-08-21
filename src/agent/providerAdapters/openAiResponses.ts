import type { ChatContentPart, ChatMessage, NativeStreamedToolCall, StreamedMetrics } from '../modelProvider.js';
import type { NativeToolSchema } from '../tools/toolSchemas.js';
import type { ProviderAdapter, ProviderStreamInput } from './types.js';
import { adapterHeaders, mergeCustomFields, readProviderSse, requireResponseBody } from './types.js';

export const openAiResponsesAdapter: ProviderAdapter = {
  protocol: 'openai-responses',
  async stream(input) {
    const response = await input.fetchImpl(`${input.profile.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: adapterHeaders(input, 'openai'),
      signal: input.signal,
      body: JSON.stringify(responsesBody(input)),
    });
    return readResponsesStream(requireResponseBody(response), input);
  },
};

function responsesBody(input: ProviderStreamInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.profile.model,
    input: toResponsesInput(input.messages),
    stream: true,
    max_output_tokens: input.profile.maxOutputTokens,
  };
  if (input.tools?.length) body.tools = toResponsesTools(input.tools);
  if (input.profile.thinkingMode === 'custom') {
    mergeCustomFields(body, input.profile.customRequestBody, [
      'model', 'input', 'stream', 'max_output_tokens', 'tools', 'tool_choice', 'include',
    ]);
  }
  return body;
}

function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: contentAsText(message.content) });
      continue;
    }
    input.push({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => responsesContentPart(part, message.role)),
    });
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

function responsesContentPart(part: ChatContentPart, role: ChatMessage['role']): Record<string, unknown> {
  if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url };
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
}

function toResponsesTools(tools: readonly NativeToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({ type: 'function', ...tool.function }));
}

async function readResponsesStream(
  body: ReadableStream<Uint8Array>,
  input: ProviderStreamInput,
): Promise<StreamedMetrics> {
  const metrics: StreamedMetrics = {};
  const builders = new Map<string, { id: string; name: string; argumentsText: string }>();
  let answerObserved = false;
  let toolObserved = false;
  let completed = false;

  const finishTools = async () => {
    if (!builders.size) return;
    const calls: NativeStreamedToolCall[] = [...builders.values()].map((builder) => ({
      id: builder.id,
      name: builder.name,
      arguments: parseToolArguments(builder.name, builder.argumentsText),
    }));
    builders.clear();
    toolObserved = calls.length > 0;
    if (calls.length) await input.handlers.onNativeToolCalls?.(calls);
  };

  await readProviderSse(body, input.signal, async ({ event, data }) => {
    let payload: Record<string, any>;
    try { payload = JSON.parse(data) as Record<string, any>; }
    catch { throw new Error('OpenAI Responses stream returned malformed JSON.'); }
    if (event === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') {
      metrics.reasoningObserved = true;
      await input.handlers.onPhase('reasoning');
      await input.handlers.onReasoningSummaryDelta(payload.delta);
    } else if (event === 'response.reasoning_text.delta' && typeof payload.delta === 'string') {
      metrics.reasoningObserved = true;
      await input.handlers.onPhase('reasoning');
      await input.handlers.onRawReasoningDelta(payload.delta);
    } else if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
      answerObserved ||= payload.delta.length > 0;
      await input.handlers.onPhase('answering');
      await input.handlers.onAnswerDelta(payload.delta);
    } else if (event === 'response.output_item.added' && payload.item?.type === 'function_call') {
      const id = String(payload.item.call_id ?? payload.item.id ?? '');
      builders.set(id, { id, name: String(payload.item.name ?? ''), argumentsText: String(payload.item.arguments ?? '') });
    } else if (event === 'response.function_call_arguments.delta') {
      const id = String(payload.item_id ?? payload.call_id ?? '');
      const builder = builders.get(id) ?? { id, name: String(payload.name ?? ''), argumentsText: '' };
      if (typeof payload.delta === 'string') builder.argumentsText += payload.delta;
      builders.set(id, builder);
    } else if (event === 'response.failed' || event === 'error') {
      throw new Error('OpenAI Responses request failed.');
    } else if (event === 'response.incomplete') {
      metrics.finishReason = 'length';
      completed = true;
      return true;
    } else if (event === 'response.completed') {
      const usage = payload.response?.usage;
      if (typeof usage?.input_tokens === 'number') metrics.promptTokens = usage.input_tokens;
      if (typeof usage?.output_tokens === 'number') metrics.completionTokens = usage.output_tokens;
      if (typeof metrics.promptTokens === 'number' && typeof metrics.completionTokens === 'number') {
        metrics.totalTokens = metrics.promptTokens + metrics.completionTokens;
      }
      metrics.finishReason = payload.response?.status === 'incomplete' ? 'length' : 'stop';
      completed = true;
      await finishTools();
      return true;
    }
    return false;
  });
  await finishTools();
  if (!completed) throw new Error('OpenAI Responses stream ended before a completion event.');
  if (!answerObserved && !toolObserved && metrics.finishReason !== 'length') {
    throw new Error('Model stream ended without producing a final answer.');
  }
  return metrics;
}

function parseToolArguments(name: string, value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Model returned tool call "${name}" with invalid JSON arguments.`);
  }
}

function contentAsText(content: ChatMessage['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => part.type === 'text' ? part.text : '[Image]').join('\n');
}
