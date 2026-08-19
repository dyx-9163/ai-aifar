import type { Item, ModelRunMetrics, ModelRunPhase, ReasoningOutputMode, TurnAttachment, TurnRecord } from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';
import { createTranslator, type Translator } from './i18n';

export type TimelineEntry =
  | {
      id: string;
      kind: 'message';
      role: string;
      text: string;
      attachments?: TurnAttachment[];
      turnId?: string;
      live: boolean;
    }
  | {
      id: string;
      kind: 'reasoning';
      mode: ReasoningOutputMode;
      text: string;
      turnId?: string;
      incomplete: boolean;
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
      metrics: ModelRunMetrics;
      text: string;
    }
  | {
      id: string;
      kind: 'progress';
      phase: ModelRunPhase;
    };

export function createTimelineEntries(
  items: Item[],
  events: AgentEvent[] = [],
  turns: TurnRecord[] = [],
  t: Translator = createTranslator('en-US'),
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const terminalTurns = new Set<string>([
    ...turns
      .filter((turn) => turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled')
      .map((turn) => turn.id),
    ...events
      .filter((event) => event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled')
      .map((event) => event.turnId),
  ]);
  const progressByTurn = new Map<string, Extract<AgentEvent, { type: 'model.progress' }>>();
  const liveMetricsTurns = new Set<string>();
  const metricsByTurn = new Map<string, Extract<TimelineEntry, { kind: 'metrics' }>>();

  for (const event of events) {
    if (event.type === 'model.progress') {
      progressByTurn.set(event.turnId, event);
    }
    if (event.type === 'model.metrics') {
      liveMetricsTurns.add(event.turnId);
      metricsByTurn.set(event.turnId, {
        id: `${event.type}-${event.turnId}-${event.sequence}`,
        kind: 'metrics',
        metrics: event.metrics,
        text: formatMetrics(event.metrics, t),
      });
    }
  }

  for (const turn of turns) {
    if (!turn.metrics || liveMetricsTurns.has(turn.id)) continue;
    metricsByTurn.set(turn.id, {
      id: `model.metrics-${turn.id}-persisted`,
      kind: 'metrics',
      metrics: turn.metrics,
      text: formatMetrics(turn.metrics, t),
    });
  }

  for (const item of items) {
    if (item.kind === 'message') {
      appendMessage(entries, {
        id: item.id,
        role: item.role,
        text: item.text,
        attachments: item.attachments,
        turnId: item.turnId,
        live: item.id.endsWith('-assistant-live'),
      });
      appendMetricsIfTurnEnds(entries, metricsByTurn, item, items);
      continue;
    }

    if (item.kind === 'reasoning') {
      entries.push({
        id: item.id,
        kind: 'reasoning',
        mode: item.mode,
        text: item.text,
        turnId: item.turnId,
        incomplete: item.incomplete,
      });
      appendMetricsIfTurnEnds(entries, metricsByTurn, item, items);
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
    appendMetricsIfTurnEnds(entries, metricsByTurn, item, items);
  }

  // Tool activity is transient: one merged row per invocation while the turn
  // is live, removed once the turn reaches a terminal state. The synthetic
  // model-call row duplicates the progress indicator, so it is never shown.
  const toolEntryByCall = new Map<string, Extract<TimelineEntry, { kind: 'tool' }>>();
  for (const event of events) {
    if (event.type === 'tool.started' || event.type === 'tool.output') {
      if (terminalTurns.has(event.turnId) || event.toolId === `tool-${event.turnId}-model`) {
        continue;
      }
      const toolKey = `${event.turnId}:${event.toolId}`;
      const existing = toolEntryByCall.get(toolKey);
      if (event.type === 'tool.started') {
        if (existing) continue;
        const entry: Extract<TimelineEntry, { kind: 'tool' }> = {
          id: `tool.started-${event.turnId}-${event.toolId}`,
          kind: 'tool',
          text: event.title,
          status: 'running',
        };
        toolEntryByCall.set(toolKey, entry);
        entries.push(entry);
      } else if (existing) {
        existing.text = event.output;
        existing.status = 'completed';
      } else {
        const entry: Extract<TimelineEntry, { kind: 'tool' }> = {
          id: `tool.output-${event.turnId}-${event.toolId}`,
          kind: 'tool',
          text: event.output,
          status: 'completed',
        };
        toolEntryByCall.set(toolKey, entry);
        entries.push(entry);
      }
      continue;
    }
    if (event.type === 'turn.failed') {
      entries.push({
        id: `${event.type}-${event.turnId}-${event.sequence}`,
        kind: 'tool',
        status: 'failed',
        text: event.error,
      });
    }
  }

  for (const metric of metricsByTurn.values()) {
    entries.push(metric);
  }

  for (const [turnId, event] of progressByTurn) {
    if (!terminalTurns.has(turnId)) {
      entries.push({ id: `model.progress-${turnId}`, kind: 'progress', phase: event.phase });
    }
  }

  return entries;
}

function appendMetricsIfTurnEnds(
  entries: TimelineEntry[],
  metricsByTurn: Map<string, Extract<TimelineEntry, { kind: 'metrics' }>>,
  item: Item,
  items: Item[],
): void {
  if (!item.turnId) return;
  const currentIndex = items.indexOf(item);
  const hasLaterSameTurnItem = items.slice(currentIndex + 1).some((candidate) => candidate.turnId === item.turnId);
  if (hasLaterSameTurnItem) return;
  const metrics = metricsByTurn.get(item.turnId);
  if (!metrics) return;
  entries.push(metrics);
  metricsByTurn.delete(item.turnId);
}

function formatMetrics(metrics: ModelRunMetrics, t: Translator): string {
  const reasoning = `${metrics.reasoningRequested}/${metrics.reasoningProtocol}`;
  const parts = [
    t('metricsReasoningFormat').replace('{reasoning}', reasoning),
    `${(metrics.durationMs / 1000).toFixed(1)}s`,
  ];
  if (typeof metrics.tokensPerSecond === 'number') {
    parts.push(`${metrics.tokensPerSecond.toFixed(1)} tok/s (${metrics.speedSource ?? 'unavailable'})`);
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
