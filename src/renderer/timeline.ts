import type { Item, ModelRunMetrics, ModelRunPhase } from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

export type TimelineEntry =
  | {
      id: string;
      kind: 'message';
      role: string;
      text: string;
      turnId?: string;
      live: boolean;
    }
  | {
      id: string;
      kind: 'tool';
      text: string;
      status?: 'running' | 'completed' | 'failed';
    }
  | {
      id: string;
      kind: 'metrics';
      text: string;
    }
  | {
      id: string;
      kind: 'progress';
      phase: ModelRunPhase;
    };

export function createTimelineEntries(items: Item[], events: AgentEvent[] = []): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const terminalTurns = new Set(
    events.filter((event) => event.type === 'turn.completed' || event.type === 'turn.failed').map((event) => event.turnId),
  );
  const progressByTurn = new Map<string, Extract<AgentEvent, { type: 'model.progress' }>>();

  for (const item of items) {
    if (item.kind === 'message') {
      appendMessage(entries, {
        id: item.id,
        role: item.role,
        text: item.text,
        turnId: item.turnId,
        live: item.id.endsWith('-assistant-live'),
      });
      continue;
    }

    if (item.kind === 'reasoning') {
      continue;
    }

    entries.push({
      id: item.id,
      kind: 'message',
      role: item.kind,
      text: item.kind === 'change' ? item.summary : (item.output ?? item.title),
      turnId: item.turnId,
      live: false,
    });
  }

  for (const event of events) {
    if (event.type === 'model.progress') {
      progressByTurn.set(event.turnId, event);
    }
    if (event.type === 'tool.started' || event.type === 'tool.output') {
      entries.push({
        id: `${event.type}-${event.turnId}-${event.sequence}`,
        kind: 'tool',
        text: event.type === 'tool.started' ? event.title : event.output,
        status: event.type === 'tool.started' ? 'running' : 'completed',
      });
    }
    if (event.type === 'turn.failed') {
      entries.push({
        id: `${event.type}-${event.turnId}-${event.sequence}`,
        kind: 'tool',
        status: 'failed',
        text: event.error,
      });
    }
    if (event.type === 'model.metrics') {
      entries.push({
        id: `${event.type}-${event.turnId}-${event.sequence}`,
        kind: 'metrics',
        text: formatMetrics(event.metrics),
      });
    }
  }

  for (const [turnId, event] of progressByTurn) {
    if (!terminalTurns.has(turnId)) {
      entries.push({ id: `model.progress-${turnId}`, kind: 'progress', phase: event.phase });
    }
  }

  return entries;
}

function formatMetrics(metrics: ModelRunMetrics): string {
  const reasoning =
    metrics.reasoningRequested && metrics.reasoningProtocol
      ? `${metrics.reasoningRequested}/${metrics.reasoningProtocol}`
      : metrics.thinkingEnabled
        ? '开'
        : '关';
  const parts = [`思考：${reasoning}`, `${(metrics.durationMs / 1000).toFixed(1)}s`];
  if (typeof metrics.tokensPerSecond === 'number') {
    parts.push(`${metrics.tokensPerSecond.toFixed(1)} tok/s (${metrics.speedSource ?? 'unavailable'})`);
  }
  if (metrics.responseSpeed) {
    parts.push(`速度：${metrics.responseSpeed}`);
  }
  if (typeof metrics.completionTokens === 'number') {
    parts.push(`${metrics.completionTokens} tokens (${metrics.usageSource ?? 'unavailable'})`);
  }
  if (metrics.finishReason) {
    parts.push(metrics.finishReason);
  }
  return parts.join(' · ');
}

type MessageDraft = Omit<Extract<TimelineEntry, { kind: 'message' }>, 'kind'>;

function appendMessage(entries: TimelineEntry[], next: MessageDraft): void {
  const previous = entries.at(-1);
  if (
    previous?.kind === 'message' &&
    previous.role === 'assistant' &&
    next.role === 'assistant' &&
    previous.turnId === next.turnId &&
    !previous.live &&
    next.live
  ) {
    previous.text = next.text.startsWith(previous.text) ? next.text : previous.text + next.text;
    previous.live = true;
    return;
  }

  if (
    previous?.kind === 'message' &&
    previous.role === 'assistant' &&
    next.role === 'assistant' &&
    previous.turnId === next.turnId &&
    previous.live === next.live
  ) {
    previous.text += next.text;
    return;
  }

  entries.push({ ...next, kind: 'message' });
}
