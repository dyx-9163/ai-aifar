import type { ModelRunMetrics } from '../shared/domain';
import type { AgentEvent, SequencedAgentEvent } from '../shared/protocol';

export type AgUiBoundaryEvent =
  | {
      type: 'RUN_STARTED';
      threadId: string;
      runId: string;
      sequence: number;
      title: string;
    }
  | {
      type: 'TEXT_MESSAGE_CONTENT';
      threadId: string;
      runId: string;
      messageId: string;
      delta: string;
      sequence: number;
    }
  | {
      type: 'TOOL_CALL_STARTED';
      threadId: string;
      runId: string;
      toolCallId: string;
      name: string;
      sequence: number;
    }
  | {
      type: 'TOOL_CALL_RESULT';
      threadId: string;
      runId: string;
      toolCallId: string;
      content: string;
      sequence: number;
    }
  | {
      type: 'RUN_FINISHED';
      threadId: string;
      runId: string;
      sequence: number;
    }
  | {
      type: 'RUN_ERROR';
      threadId: string;
      runId: string;
      message: string;
      sequence: number;
    }
  | {
      type: 'CUSTOM';
      name: 'approval.required' | 'model.metrics';
      threadId: string;
      runId: string;
      sequence: number;
      value: unknown;
    };

export function mapAgentEventToAgUiEvents(event: AgentEvent): AgUiBoundaryEvent[] {
  if (event.type === 'snapshot') {
    return [];
  }

  switch (event.type) {
    case 'turn.started':
      return [baseRunEvent(event, 'RUN_STARTED', { title: event.title })];
    case 'message.delta':
      return [
        {
          type: 'TEXT_MESSAGE_CONTENT',
          threadId: event.threadId,
          runId: event.turnId,
          messageId: `message-${event.turnId}`,
          delta: event.text,
          sequence: event.sequence,
        },
      ];
    case 'tool.started':
      return [
        {
          type: 'TOOL_CALL_STARTED',
          threadId: event.threadId,
          runId: event.turnId,
          toolCallId: event.toolId,
          name: event.title,
          sequence: event.sequence,
        },
      ];
    case 'tool.output':
      return [
        {
          type: 'TOOL_CALL_RESULT',
          threadId: event.threadId,
          runId: event.turnId,
          toolCallId: event.toolId,
          content: event.output,
          sequence: event.sequence,
        },
      ];
    case 'approval.required':
      return [customEvent(event, 'approval.required', { approvalId: event.approvalId, title: event.title, description: event.description })];
    case 'model.metrics':
      return [customEvent(event, 'model.metrics', event.metrics)];
    case 'turn.completed':
      return [baseRunEvent(event, 'RUN_FINISHED', {})];
    case 'turn.failed':
      return [baseRunEvent(event, 'RUN_ERROR', { message: event.error })];
    default:
      return [];
  }
}

function baseRunEvent<TType extends 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR'>(
  event: SequencedAgentEvent,
  type: TType,
  extra: Omit<Extract<AgUiBoundaryEvent, { type: TType }>, 'type' | 'threadId' | 'runId' | 'sequence'>,
): Extract<AgUiBoundaryEvent, { type: TType }> {
  return {
    type,
    threadId: event.threadId,
    runId: event.turnId,
    sequence: event.sequence,
    ...extra,
  } as Extract<AgUiBoundaryEvent, { type: TType }>;
}

function customEvent(
  event: SequencedAgentEvent,
  name: 'approval.required' | 'model.metrics',
  value: ModelRunMetrics | { approvalId: string; title: string; description: string },
): Extract<AgUiBoundaryEvent, { type: 'CUSTOM' }> {
  return {
    type: 'CUSTOM',
    name,
    threadId: event.threadId,
    runId: event.turnId,
    sequence: event.sequence,
    value,
  };
}
