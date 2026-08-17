import type { AgentEvent } from '../shared/protocol.js';

export interface DemoTurnInput {
  threadId: string;
  turnId: string;
  modelProfileId?: string;
  text: string;
  approvalResponse?: Promise<boolean>;
}

export type EmitAgentEvent = (event: AgentEvent) => void | Promise<void>;

type SequencedEvent = Exclude<AgentEvent, { type: 'snapshot' }>;
type StripEnvelope<T> = T extends unknown ? Omit<T, 'threadId' | 'turnId' | 'modelProfileId' | 'sequence'> : never;
type SequencedEventPayload = StripEnvelope<SequencedEvent>;

export async function runDemoTurn(input: DemoTurnInput, emit: EmitAgentEvent, signal: AbortSignal): Promise<void> {
  let sequence = 1;
  const next = async (event: SequencedEventPayload) => {
    throwIfAborted(signal);
    await emit({
      ...event,
      threadId: input.threadId,
      turnId: input.turnId,
      modelProfileId: input.modelProfileId ?? '__demo__',
      sequence: sequence++,
    } as SequencedEvent);
    await tick(signal);
  };

  await next({ type: 'turn.started', title: titleFromPrompt(input.text) });
  await next({ type: 'tool.started', toolId: `tool-${input.turnId}-plan`, title: 'Plan local task' });

  if (requiresApproval(input.text)) {
    await next({
      type: 'tool.output',
      toolId: `tool-${input.turnId}-plan`,
      output: 'No filesystem changes were made. A local approval is required before any simulated write.',
    });
    await next({
      type: 'approval.required',
      approvalId: `approval-${input.turnId}`,
      title: 'Approve simulated file change',
      description: 'The demo runtime detected a write-like request. The MVP records approval only and performs no mutation.',
    });

    if (!input.approvalResponse) {
      return;
    }

    const approved = await input.approvalResponse;
    await next(
      approved
        ? { type: 'message.delta', text: 'Approval accepted. Demo mode still keeps the filesystem unchanged.' }
        : { type: 'turn.failed', error: 'Approval rejected by user.' },
    );
    if (approved) {
      await next({ type: 'turn.completed' });
    }
    return;
  }

  await next({
    type: 'tool.output',
    toolId: `tool-${input.turnId}-plan`,
    output: 'Workspace context reviewed in deterministic demo mode.',
  });

  for (const text of responseDeltas(input.text)) {
    await next({ type: 'message.delta', text });
  }

  await next({ type: 'turn.completed' });
}

export function requiresApproval(text: string): boolean {
  return /修改|删除|write|delete/i.test(text);
}

function titleFromPrompt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed || 'New task';
}

function responseDeltas(text: string): string[] {
  return [
    'I reviewed the request in local demo mode. ',
    `Prompt: "${text.trim() || 'empty request'}". `,
    'Next step would be routed to a replaceable model provider in the private deployment build.',
  ];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Turn was cancelled.', 'AbortError');
  }
}

async function tick(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await Promise.resolve();
}
