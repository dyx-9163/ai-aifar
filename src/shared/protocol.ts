import type { AppSnapshot, ThemePreference } from './domain.js';

export type DesktopRequest =
  | { type: 'snapshot.get' }
  | { type: 'thread.create'; title: string }
  | { type: 'turn.start'; threadId: string; text: string }
  | { type: 'turn.cancel'; threadId: string; turnId: string }
  | { type: 'approval.respond'; approvalId: string; approved: boolean }
  | { type: 'theme.set'; theme: ThemePreference };

export type SequencedAgentEvent =
  | { type: 'turn.started'; threadId: string; turnId: string; sequence: number; title: string }
  | { type: 'message.delta'; threadId: string; turnId: string; sequence: number; text: string }
  | { type: 'tool.started'; threadId: string; turnId: string; sequence: number; toolId: string; title: string }
  | { type: 'tool.output'; threadId: string; turnId: string; sequence: number; toolId: string; output: string }
  | { type: 'approval.required'; threadId: string; turnId: string; sequence: number; approvalId: string; title: string; description: string }
  | { type: 'turn.completed'; threadId: string; turnId: string; sequence: number }
  | { type: 'turn.failed'; threadId: string; turnId: string; sequence: number; error: string };

export type AgentEvent = { type: 'snapshot'; snapshot: AppSnapshot } | SequencedAgentEvent;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === 'string' && record[key].length > 0;
}

function hasBoolean(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === 'boolean';
}

function hasSequence(record: UnknownRecord): boolean {
  return Number.isInteger(record.sequence) && Number(record.sequence) >= 0;
}

function hasThreadTurnAndSequence(record: UnknownRecord): boolean {
  return hasString(record, 'threadId') && hasString(record, 'turnId') && hasSequence(record);
}

export function isDesktopRequest(value: unknown): value is DesktopRequest {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'snapshot.get':
      return true;
    case 'thread.create':
      return hasString(value, 'title');
    case 'turn.start':
      return hasString(value, 'threadId') && hasString(value, 'text');
    case 'turn.cancel':
      return hasString(value, 'threadId') && hasString(value, 'turnId');
    case 'approval.respond':
      return hasString(value, 'approvalId') && hasBoolean(value, 'approved');
    case 'theme.set':
      return value.theme === 'system' || value.theme === 'light' || value.theme === 'dark';
    default:
      return false;
  }
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'snapshot') {
    return isRecord(value.snapshot);
  }

  if (!hasThreadTurnAndSequence(value)) {
    return false;
  }

  switch (value.type) {
    case 'turn.started':
      return hasString(value, 'title');
    case 'message.delta':
      return hasString(value, 'text');
    case 'tool.started':
      return hasString(value, 'toolId') && hasString(value, 'title');
    case 'tool.output':
      return hasString(value, 'toolId') && typeof value.output === 'string';
    case 'approval.required':
      return hasString(value, 'approvalId') && hasString(value, 'title') && hasString(value, 'description');
    case 'turn.completed':
      return true;
    case 'turn.failed':
      return hasString(value, 'error');
    default:
      return false;
  }
}
