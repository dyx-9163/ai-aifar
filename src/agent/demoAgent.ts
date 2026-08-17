import type { SequencedAgentEvent } from '../shared/protocol.js';

export interface DemoTurnInput {
  threadId: string;
  turnId: string;
  modelProfileId?: string;
  text: string;
  approvalResponse?: Promise<boolean>;
}

type StripEnvelope<T> = T extends unknown ? Omit<T, 'threadId' | 'turnId' | 'modelProfileId' | 'sequence'> : never;
export type DemoEventPayload = StripEnvelope<SequencedAgentEvent>;
export type EmitDemoEvent = (event: DemoEventPayload) => void | Promise<void>;
export type DemoTurnOutcome = 'completed' | 'awaiting-approval';

export async function runDemoTurn(
  input: DemoTurnInput,
  emit: EmitDemoEvent,
  signal: AbortSignal,
): Promise<DemoTurnOutcome> {
  const next = async (event: DemoEventPayload) => {
    throwIfAborted(signal);
    await emit(event);
    await tick(signal);
  };

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
      return 'awaiting-approval';
    }

    const approved = await abortableApproval(input.approvalResponse, signal);
    if (!approved) {
      throw new Error('Approval rejected by user.');
    }
    await next({ type: 'message.delta', text: 'Approval accepted. Demo mode still keeps the filesystem unchanged.' });
    return 'completed';
  }

  await next({
    type: 'tool.output',
    toolId: `tool-${input.turnId}-plan`,
    output: 'Workspace context reviewed in deterministic demo mode.',
  });

  for (const text of responseDeltas(input.text)) {
    await next({ type: 'message.delta', text });
  }

  return 'completed';
}

export function requiresApproval(text: string): boolean {
  return /修改|删除|write|delete/i.test(text);
}

export function demoTurnTitle(text: string): string {
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

function abortableApproval(approval: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(new DOMException('Turn was cancelled.', 'AbortError'));
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Turn was cancelled.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void approval.then(
      (approved) => {
        signal.removeEventListener('abort', onAbort);
        resolve(approved);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
