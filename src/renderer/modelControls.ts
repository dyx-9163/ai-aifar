import type {
  ModelProfile,
  ReasoningDisplayMode,
  ReasoningItem,
  ReasoningOutputMode,
  ThreadRuntimeState,
  ThreadStatus,
} from '../shared/domain';

export type ReasoningControl =
  | { kind: 'hidden' }
  | { kind: 'toggle' }
  | { kind: 'effort'; options: string[] }
  | { kind: 'custom'; warning: true };

export interface ReasoningContentSelection {
  availability: 'available' | 'unsupported' | 'empty';
  mode?: ReasoningOutputMode;
  text: string;
}

export interface ReasoningSelectionContext {
  running: boolean;
  outputModes: ReasoningOutputMode[];
}

export type ComposerAction = 'send' | 'cancel' | 'stop';

export interface ReasoningItemGroup {
  turnId: string;
  anchorId: string;
  raw?: ReasoningItem;
  summary?: ReasoningItem;
}

export interface ThreadRuntimePresentation {
  key: 'ready' | 'queued' | 'queuedPosition' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  queuePosition?: number;
  active: boolean;
}

export function reasoningControls(profile: ModelProfile): ReasoningControl {
  const capability = profile.capabilities.reasoning;
  if (capability.inputMode === 'toggle') {
    return { kind: 'toggle' };
  }
  if (capability.inputMode === 'effort' && capability.effortOptions.length > 0) {
    return { kind: 'effort', options: [...capability.effortOptions] };
  }
  if (capability.inputMode === 'custom') {
    return { kind: 'custom', warning: true };
  }
  return { kind: 'hidden' };
}

export function selectReasoningContent(
  preference: ReasoningDisplayMode,
  items: ReasoningItem[],
  context?: ReasoningSelectionContext,
): ReasoningContentSelection {
  const itemByMode = (mode: ReasoningOutputMode) => items.find((item) => item.mode === mode && item.text.length > 0);
  const selected = preference === 'auto'
    ? itemByMode('summary') ?? itemByMode('raw')
    : itemByMode(preference);

  if (selected) {
    return { availability: 'available', mode: selected.mode, text: selected.text };
  }
  if (preference !== 'auto') {
    if (context?.running && context.outputModes.includes(preference)) {
      return { availability: 'empty', mode: preference, text: '' };
    }
    return { availability: 'unsupported', mode: preference, text: '' };
  }
  return { availability: 'empty', text: '' };
}

export function reasoningMenuCommand(key: string): 'close' | 'keep' {
  return key === 'Escape' ? 'close' : 'keep';
}

export function shouldShowReasoningPanel(
  preference: ReasoningDisplayMode,
  items: ReasoningItem[],
  running: boolean,
): boolean {
  return items.length > 0 || running || preference !== 'auto';
}

export function composerAction(runtime?: ThreadRuntimeState): ComposerAction {
  if (runtime?.status === 'queued') {
    return 'cancel';
  }
  if (runtime?.status === 'running' || runtime?.status === 'cancelling') {
    return 'stop';
  }
  return 'send';
}

export function groupReasoningItems(items: ReasoningItem[]): ReasoningItemGroup[] {
  const groups = new Map<string, ReasoningItemGroup>();
  for (const item of items) {
    const turnId = item.turnId ?? item.id;
    const group = groups.get(turnId) ?? { turnId, anchorId: item.id };
    group[item.mode] = item;
    groups.set(turnId, group);
  }
  return [...groups.values()];
}

export function threadRuntimePresentation(
  runtime: ThreadRuntimeState | undefined,
  fallback: ThreadStatus,
): ThreadRuntimePresentation {
  const status = runtime && runtime.status !== 'idle' ? runtime.status : fallback;
  if (status === 'queued') {
    return typeof runtime?.queuePosition === 'number' && runtime.queuePosition >= 1
      ? { key: 'queuedPosition', queuePosition: runtime.queuePosition, active: true }
      : { key: 'queued', active: true };
  }
  if (status === 'running' || status === 'cancelling') {
    return { key: status, active: true };
  }
  return { key: status, active: false };
}
