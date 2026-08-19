import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import type { AppSnapshot, Item, ModelCapabilities, ModelConnectionResult, ModelProfile, ReasoningItem } from '../src/shared/domain';
import { openAiCapabilities, qwenCapabilities } from '../src/agent/modelCapabilities';
import {
  isBuiltInLocalQwen,
  isLocalQwenServiceProfile,
  LOCAL_QWEN_BASE_URL,
  LOCAL_QWEN_MODEL,
  LOCAL_QWEN_PROFILE_ID,
} from '../src/shared/localQwenIdentity';
import {
  appendOptimisticUserMessage,
  applyAssistantDeltaToSnapshot,
  emptyState,
  reduceEvent,
  startInitialAgentSync,
  useApp,
} from '../src/renderer/composables/useApp';
import { createTranslator, isLanguagePreference } from '../src/renderer/i18n';
import { renderMarkdown } from '../src/renderer/markdown';
import {
  buildModelProfileInput,
  captureFormOperation,
  connectionTestStateForFingerprint,
  customRequestBodyValidationIssue,
  effortValidationIssue,
  formOperationCanApply,
  isNewModelProfileDraft,
  maxOutputTokensIsValid,
  modelConnectionDiagnostic,
  modelProfileFormFingerprint,
  recommendedReasoningControlForProtocol,
  reasoningConfigurationValidationIssue,
  reconcileEffortSelection,
  runModelProfileSave,
  type ModelProfileFormValues,
} from '../src/renderer/modelProfileForm';
import {
  composerAction,
  copyTextWithFeedback,
  groupReasoningItems,
  reasoningControls,
  reasoningMenuCommand,
  reasoningProfileForRuntime,
  selectReasoningContent,
  shouldShowReasoningPanel,
  threadRuntimePresentation,
} from '../src/renderer/modelControls';
import { isNearBottom } from '../src/renderer/scrolling';
import { createTimelineEntries } from '../src/renderer/timeline';

function deltaEvent(sequence: number): AgentEvent {
  return {
    type: 'message.delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    modelProfileId: 'model-1',
    sequence,
    text: 'Hello',
  };
}

function approvalEvent(): AgentEvent {
  return {
    type: 'approval.required',
    threadId: 'thread-1',
    turnId: 'turn-1',
    modelProfileId: 'model-1',
    sequence: 2,
    approvalId: 'approval-1',
    title: 'Approve change',
    description: 'Simulated write approval.',
  };
}

function modelProfileFixture(capabilities: ModelCapabilities): ModelProfile {
  return {
    id: 'model-1',
    name: 'Fixture',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'fixture',
    apiKeyConfigured: false,
    capabilities,
    reasoning: { mode: 'enabled', protocol: 'none', display: 'auto' },
    maxConcurrency: 1,
    maxOutputTokens: 2048,
    responseSpeed: 'standard',
    isDefault: true,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

const rawReasoning: ReasoningItem = {
  id: 'raw-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  kind: 'reasoning',
  mode: 'raw',
  text: '分析',
  incomplete: false,
  createdAt: '2026-08-17T00:00:01.000Z',
};

const summaryReasoning: ReasoningItem = {
  ...rawReasoning,
  id: 'summary-1',
  mode: 'summary',
  text: '摘要',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('renderer state reducer', () => {
  it('subscribes before snapshot and replays buffered terminal state without duplicating persisted text', async () => {
    let state = emptyState();
    let listener: ((event: AgentEvent) => void) | undefined;
    const calls: string[] = [];
    let resolveSnapshot!: (snapshot: AppSnapshot) => void;
    const snapshotPromise = new Promise<AppSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const sync = startInitialAgentSync({
      readState: () => state,
      writeState: (next) => { state = next; },
      getSnapshot: () => {
        calls.push('snapshot');
        return snapshotPromise;
      },
      subscribe: (next) => {
        calls.push('subscribe');
        listener = next;
        return () => calls.push('unsubscribe');
      },
      onReady: () => calls.push('ready'),
    });

    listener?.({
      type: 'answer.delta', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 1, text: 'answer',
    });
    listener?.({
      type: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 2,
    });
    const base = emptyState().snapshot;
    resolveSnapshot({
      ...base,
      groups: [{ id: 'group-1', name: 'Group', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z' }],
      threads: [{
        id: 'thread-1', groupId: 'group-1', title: 'Chat', status: 'running', modelProfileId: 'model-1',
        createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:01.000Z',
      }],
      turns: [{
        id: 'turn-1', threadId: 'thread-1', modelProfileId: 'model-1', status: 'running',
        createdAt: '2026-08-17T00:00:00.000Z', incomplete: true,
      }],
      items: {
        'thread-1': [{
          id: 'item-turn-1-assistant', threadId: 'thread-1', turnId: 'turn-1', kind: 'message', role: 'assistant',
          text: 'answer', incomplete: true, createdAt: '2026-08-17T00:00:01.000Z',
        }],
      },
    });
    await sync.ready;

    expect(calls.slice(0, 2)).toEqual(['subscribe', 'snapshot']);
    expect(state.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'completed' });
    expect(state.snapshot.items['thread-1']).toMatchObject([{ text: 'answer', incomplete: false }]);
    sync.dispose();
    const disposedState = state;
    listener?.({
      type: 'turn.started', threadId: 'thread-2', turnId: 'turn-2', modelProfileId: 'model-1', sequence: 1, title: 'late',
    });
    expect(state).toBe(disposedState);
    expect(calls).toContain('unsubscribe');
  });

  it('does not publish a late initial snapshot after disposal', async () => {
    let state = emptyState();
    let listener: ((event: AgentEvent) => void) | undefined;
    let ready = false;
    let resolveSnapshot!: (snapshot: AppSnapshot) => void;
    const sync = startInitialAgentSync({
      readState: () => state,
      writeState: (next) => { state = next; },
      getSnapshot: () => new Promise<AppSnapshot>((resolve) => { resolveSnapshot = resolve; }),
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      onReady: () => { ready = true; },
    });
    sync.dispose();
    listener?.({
      type: 'turn.started', threadId: 'thread-late', turnId: 'turn-late', modelProfileId: 'model-1', sequence: 1, title: 'late',
    });
    resolveSnapshot(emptyState().snapshot);
    await sync.ready;

    expect(state).toEqual(emptyState());
    expect(ready).toBe(false);
  });

  it('reconciles approvals monotonically across buffered events and an older initial snapshot', async () => {
    let state = { ...emptyState(), activeThreadId: 'thread-1' };
    let listener: ((event: AgentEvent) => void) | undefined;
    let resolveSnapshot!: (snapshot: AppSnapshot) => void;
    const sync = startInitialAgentSync({
      readState: () => state,
      writeState: (next) => { state = next; },
      getSnapshot: () => new Promise<AppSnapshot>((resolve) => { resolveSnapshot = resolve; }),
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      onReady: () => undefined,
    });
    listener?.(approvalEvent());
    resolveSnapshot({
      ...emptyState().snapshot,
      groups: [{
        id: 'group-1', name: 'Group', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      }],
      threads: [{
        id: 'thread-1', groupId: 'group-1', title: 'Chat', status: 'running',
        createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      }],
      turns: [{
        id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: '2026-08-17T00:00:00.000Z', incomplete: true,
      }],
    });
    await sync.ready;

    expect(state.snapshot.approvals).toContainEqual(expect.objectContaining({ id: 'approval-1', status: 'pending' }));
    sync.dispose();

    state = reduceEvent(state, {
      type: 'turn.cancelled', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 3,
    });
    state = reduceEvent(state, {
      type: 'snapshot',
      snapshot: {
        ...state.snapshot,
        approvals: [{
          id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', title: 'Approve change',
          description: 'Stale pending approval.', status: 'pending', createdAt: '2026-08-17T00:00:00.000Z',
        }],
      },
    });
    expect(state.snapshot.approvals).toContainEqual(expect.objectContaining({ id: 'approval-1', status: 'rejected' }));
    expect(state.pendingApproval).toBeUndefined();
  });

  it('unsubscribes and stops buffering when initial snapshot loading rejects', async () => {
    let state = emptyState();
    let listener: ((event: AgentEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const sync = startInitialAgentSync({
      readState: () => state,
      writeState: (next) => { state = next; },
      getSnapshot: async () => { throw new Error('snapshot unavailable'); },
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      onReady: () => undefined,
    });

    await expect(sync.ready).rejects.toThrow('snapshot unavailable');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const failedState = state;
    listener?.(approvalEvent());
    expect(state).toBe(failedState);
    sync.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('patches only exposed model fields while preserving existing custom capabilities', () => {
    const existing: ModelProfile = {
      ...modelProfileFixture({
        text: true,
        vision: true,
        longContext: true,
        reasoning: {
          inputMode: 'custom',
          effortOptions: ['vendor-low', 'vendor-max'],
          outputModes: ['raw'],
          defaultEffort: 'vendor-low',
        },
        concurrency: { defaultLimit: 3, configurable: false, maxLimit: 9 },
        streaming: false,
        usage: { tokens: false, reasoningTokens: false },
      }),
      reasoning: { mode: 'enabled', protocol: 'custom', effort: 'vendor-low', display: 'raw' },
      maxConcurrency: 3,
      responseSpeed: 'quality',
    };
    const form: ModelProfileFormValues = {
      id: existing.id,
      name: 'Custom endpoint',
      baseUrl: existing.baseUrl,
      model: existing.model,
      apiKey: '',
      isDefault: existing.isDefault,
      reasoningMode: 'enabled',
      reasoningProtocol: 'custom',
      reasoningEffort: 'vendor-max',
      profileReasoningDisplay: 'raw',
      reasoningInputMode: 'custom',
      effortOptions: ['vendor-low', 'vendor-max'],
      defaultEffort: 'vendor-low',
      rawOutput: true,
      summaryOutput: true,
      maxConcurrency: 4,
      maxOutputTokens: 2048,
    };

    const input = buildModelProfileInput(form, existing);

    expect(input).toMatchObject({
      provider: existing.provider,
      capabilities: {
        text: true,
        vision: true,
        longContext: true,
        reasoning: {
          inputMode: 'custom',
          effortOptions: ['vendor-low', 'vendor-max'],
          outputModes: ['raw', 'summary'],
          defaultEffort: 'vendor-low',
        },
        concurrency: { defaultLimit: 3, configurable: false, maxLimit: 9 },
        streaming: false,
        usage: { tokens: false, reasoningTokens: false },
      },
      reasoning: { mode: 'enabled', protocol: 'custom', effort: 'vendor-max', display: 'raw' },
      maxConcurrency: 4,
      maxOutputTokens: 2048,
      responseSpeed: 'quality',
    });
    expect(input.apiKey).toBeUndefined();
    (input.capabilities?.reasoning?.effortOptions as string[]).push('mutated');
    expect(existing.capabilities.reasoning.effortOptions).toEqual(['vendor-low', 'vendor-max']);
  });

  it('uses canonical hidden capability defaults only for a new profile', () => {
    const input = buildModelProfileInput({
      name: 'New endpoint',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'new-model',
      apiKey: '',
      isDefault: true,
      reasoningMode: 'disabled',
      reasoningProtocol: 'none',
      reasoningEffort: '',
      profileReasoningDisplay: 'auto',
      reasoningInputMode: 'unsupported',
      effortOptions: [],
      defaultEffort: '',
      rawOutput: false,
      summaryOutput: false,
      maxConcurrency: 1,
      maxOutputTokens: 2048,
    });

    expect(input.capabilities).toMatchObject({
      text: true,
      vision: false,
      longContext: false,
      concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
      streaming: true,
      usage: { tokens: true, reasoningTokens: true },
    });
  });

  it('marks an empty form id as a new model draft even when existing profiles remain visible', () => {
    expect(isNewModelProfileDraft('', [modelProfileFixture(openAiCapabilities([]))])).toBe(true);
    expect(isNewModelProfileDraft('model-1', [modelProfileFixture(openAiCapabilities([]))])).toBe(false);
  });

  it('selects a persisted fallback when effort options remove the current and default values', () => {
    expect(reconcileEffortSelection({
      reasoningMode: 'enabled',
      inputMode: 'effort',
      options: ['max'],
      currentEffort: 'medium',
      defaultEffort: 'medium',
    })).toEqual({ currentEffort: 'max', defaultEffort: 'max' });
    expect(reconcileEffortSelection({
      reasoningMode: 'auto',
      inputMode: 'effort',
      options: ['minimal', 'max'],
      currentEffort: '',
      defaultEffort: 'max',
    })).toEqual({ currentEffort: 'max', defaultEffort: 'max' });
  });

  it('rejects incomplete or invalid active effort configuration', () => {
    expect(effortValidationIssue({
      reasoningMode: 'enabled', inputMode: 'effort', options: [], currentEffort: '', defaultEffort: '',
    })).toBe('effortOptionsRequired');
    expect(effortValidationIssue({
      reasoningMode: 'enabled', inputMode: 'effort', options: ['max'], currentEffort: 'max', defaultEffort: 'medium',
    })).toBe('defaultEffortInvalid');
    expect(effortValidationIssue({
      reasoningMode: 'auto', inputMode: 'effort', options: ['max'], currentEffort: 'medium', defaultEffort: 'max',
    })).toBe('currentEffortInvalid');
    expect(effortValidationIssue({
      reasoningMode: 'disabled', inputMode: 'effort', options: [], currentEffort: '', defaultEffort: '',
    })).toBeUndefined();
  });

  it.each([
    ['toggle', 'openai'],
    ['effort', 'qwen'],
    ['toggle', 'none'],
    ['custom', 'custom'],
  ] as const)('allows settings request format %s with provider label %s', (inputMode, protocol) => {
    expect(reasoningConfigurationValidationIssue({
      reasoningMode: 'enabled',
      inputMode,
      protocol,
    })).toBeUndefined();
  });

  it('reports invalid custom request body JSON before save or connection test', () => {
    expect(customRequestBodyValidationIssue('custom', '{"extra_body":{"thinking":true}}')).toBeUndefined();
    expect(customRequestBodyValidationIssue('custom', '[1]')).toBe('customRequestBodyInvalid');
    expect(customRequestBodyValidationIssue('custom', '{')).toBe('customRequestBodyInvalid');
    expect(customRequestBodyValidationIssue('effort', '{')).toBeUndefined();
  });

  it('recommends a matching reasoning control when the compatibility label changes', () => {
    expect(recommendedReasoningControlForProtocol('openai', {
      inputMode: 'toggle',
      effortOptions: [],
      currentEffort: '',
      defaultEffort: '',
    })).toEqual({
      inputMode: 'effort',
      effortOptions: ['high', 'max'],
      currentEffort: 'high',
      defaultEffort: 'high',
    });
    expect(recommendedReasoningControlForProtocol('qwen', {
      inputMode: 'effort',
      effortOptions: ['high', 'max'],
      currentEffort: 'high',
      defaultEffort: 'high',
    })).toEqual({
      inputMode: 'toggle',
      effortOptions: [],
      currentEffort: '',
      defaultEffort: '',
    });
    expect(recommendedReasoningControlForProtocol('openai', {
      inputMode: 'custom',
      effortOptions: [],
      currentEffort: '',
      defaultEffort: '',
    })).toBeUndefined();
  });

  it('awaits model profile persistence and converts rejection into an explicit result', async () => {
    const input = buildModelProfileInput({
      name: 'New endpoint', baseUrl: 'http://localhost/v1', model: 'm', apiKey: '', isDefault: true,
      reasoningMode: 'disabled', reasoningProtocol: 'none', reasoningEffort: '', profileReasoningDisplay: 'auto',
      reasoningInputMode: 'unsupported', effortOptions: [], defaultEffort: '', rawOutput: false, summaryOutput: false,
      maxConcurrency: 1, maxOutputTokens: 2048,
    });
    const saved = modelProfileFixture(openAiCapabilities([]));
    let resolveSave: ((profile: ModelProfile) => void) | undefined;
    let settled = false;
    const operation = runModelProfileSave(input, () => new Promise<ModelProfile>((resolve) => {
      resolveSave = resolve;
    })).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveSave?.(saved);
    await expect(operation).resolves.toEqual({ ok: true, profile: saved });
    await expect(runModelProfileSave(input, async () => {
      throw new Error('save rejected');
    })).resolves.toMatchObject({ ok: false, error: new Error('save rejected') });
  });

  it('round-trips the output token bound and invalidates a tested fingerprint when it changes', () => {
    const existing = modelProfileFixture(openAiCapabilities([]));
    const form: ModelProfileFormValues = {
      id: existing.id,
      name: existing.name,
      baseUrl: existing.baseUrl,
      model: existing.model,
      apiKey: '',
      isDefault: existing.isDefault,
      reasoningMode: existing.reasoning.mode,
      reasoningProtocol: existing.reasoning.protocol,
      reasoningEffort: '',
      profileReasoningDisplay: existing.reasoning.display,
      reasoningInputMode: existing.capabilities.reasoning.inputMode,
      effortOptions: [],
      defaultEffort: '',
      rawOutput: false,
      summaryOutput: false,
      maxConcurrency: existing.maxConcurrency,
      maxOutputTokens: 2048,
    };
    const input = buildModelProfileInput(form, existing);

    expect(input.maxOutputTokens).toBe(2048);
    const first = { ...input, maxOutputTokens: 2048 };
    const tested = modelProfileFormFingerprint(first);
    expect(connectionTestStateForFingerprint('connected', tested, modelProfileFormFingerprint(first))).toBe('connected');
    expect(connectionTestStateForFingerprint(
      'connected',
      tested,
      modelProfileFormFingerprint({ ...first, maxOutputTokens: 4096 }),
    )).toBe('untested');
  });

  it('validates output tokens as a positive integer within the shared upper bound', () => {
    expect(maxOutputTokensIsValid(1)).toBe(true);
    expect(maxOutputTokensIsValid(2048)).toBe(true);
    expect(maxOutputTokensIsValid(32768)).toBe(true);
    expect(maxOutputTokensIsValid(0)).toBe(false);
    expect(maxOutputTokensIsValid(1.5)).toBe(false);
    expect(maxOutputTokensIsValid(32769)).toBe(false);
  });

  it('offers local runtime guidance for strict equivalent Qwen service profiles after ID collision repair', () => {
    const builtIn = {
      id: LOCAL_QWEN_PROFILE_ID,
      provider: 'openai-compatible' as const,
      baseUrl: LOCAL_QWEN_BASE_URL,
      model: LOCAL_QWEN_MODEL,
    };
    expect(isBuiltInLocalQwen(builtIn)).toBe(true);
    expect(isBuiltInLocalQwen({ ...builtIn, id: 'custom-qwen' })).toBe(false);
    expect(isLocalQwenServiceProfile({ ...builtIn, id: 'local-qwen35-2' })).toBe(true);
    expect(isLocalQwenServiceProfile({ ...builtIn, provider: 'another-provider' as never })).toBe(false);
    expect(isLocalQwenServiceProfile({ ...builtIn, baseUrl: 'http://127.0.0.1:9000/v1' })).toBe(false);
    expect(isLocalQwenServiceProfile({ ...builtIn, model: 'another-model' })).toBe(false);
  });

  it.each([
    [{ ok: true, status: 'connected', message: '', model: 'Qwen3.5-9B', clientConcurrency: 2, serviceSlots: 2 }, false,
      'connected Qwen3.5-9B slots=2 client=2'],
    [{ ok: true, status: 'concurrency-warning', message: '', model: 'Qwen3.5-9B', clientConcurrency: 1, serviceSlots: 3 }, false,
      'warning Qwen3.5-9B slots=3 client=1'],
    [{ ok: true, status: 'slots-unverified', message: '', model: 'Qwen3.5-9B', clientConcurrency: 1 }, false,
      'unverified Qwen3.5-9B'],
    [{ ok: false, status: 'model-mismatch', message: '', model: 'Qwen3.5-9B', clientConcurrency: 1 }, false,
      'mismatch Qwen3.5-9B'],
    [{ ok: false, status: 'offline', message: '', model: 'Qwen3.5-9B', clientConcurrency: 1 }, false,
      'offline Qwen3.5-9B'],
    [{ ok: false, status: 'offline', message: '', model: 'Qwen3.5-9B', clientConcurrency: 1 }, true,
      'offline Qwen3.5-9B command=model-runtime\\start-model.ps1'],
  ] satisfies Array<[ModelConnectionResult, boolean, string]>)('renders a typed diagnostic without lifecycle coupling', (result, builtIn, expected) => {
    const templates: Record<string, string> = {
      connectionConnectedDiagnostic: 'connected {model} slots={slots} client={concurrency}',
      connectionConcurrencyWarningDiagnostic: 'warning {model} slots={slots} client={concurrency}',
      connectionSlotsUnverifiedDiagnostic: 'unverified {model}',
      connectionModelMismatchDiagnostic: 'mismatch {model}',
      connectionOfflineDiagnostic: 'offline {model}',
      connectionOfflineLocalQwenCommand: 'command=model-runtime\\start-model.ps1',
    };

    expect(modelConnectionDiagnostic(result, (key) => templates[key] ?? key, builtIn)).toBe(expected);
  });

  it('caps an arbitrary configured model identifier in renderer diagnostics', () => {
    const configuredModel = `private-${'m'.repeat(4_096)}`;
    const displayedModel = `${configuredModel.slice(0, 95)}…`;
    const diagnostic = modelConnectionDiagnostic({
      ok: false,
      status: 'model-mismatch',
      message: 'Configured model is not advertised by the model endpoint.',
      model: configuredModel,
      clientConcurrency: 1,
    }, (key) => key === 'connectionModelMismatchDiagnostic' ? 'mismatch {model}' : key, false);

    expect([...displayedModel]).toHaveLength(96);
    expect(diagnostic).toBe(`mismatch ${displayedModel}`);
    expect(diagnostic).not.toContain(configuredModel);
  });

  it('rejects an unknown connection status instead of presenting it as offline', () => {
    const futureResult = {
      ok: false,
      status: 'future-status',
      message: 'future',
      model: 'model',
      clientConcurrency: 1,
    } as unknown as ModelConnectionResult;

    expect(() => modelConnectionDiagnostic(futureResult, (key) => key, false))
      .toThrow('Unsupported model connection status.');
  });

  it('does not apply a pending profile A save after the form switches to edited profile B', async () => {
    const profileA = { ...modelProfileFixture(openAiCapabilities(['medium'])), id: 'model-a', name: 'A' };
    const profileB = { ...modelProfileFixture(qwenCapabilities()), id: 'model-b', name: 'B' };
    const submitted = captureFormOperation(1, profileA, 3);
    let resolveSave: ((profile: ModelProfile) => void) | undefined;
    const pendingSave = runModelProfileSave(profileA, () => new Promise<ModelProfile>((resolve) => {
      resolveSave = resolve;
    }));
    const editedB = { ...profileB, name: 'B edited' };

    resolveSave?.(profileA);
    await expect(pendingSave).resolves.toEqual({ ok: true, profile: profileA });
    expect(formOperationCanApply(submitted, captureFormOperation(1, editedB, 4))).toBe(false);
  });

  it('does not let an older repeated save overwrite a newer response for the same form revision', async () => {
    const profile = { ...modelProfileFixture(openAiCapabilities(['medium'])), id: 'model-a' };
    const older = captureFormOperation(1, profile, 3);
    const newer = captureFormOperation(2, profile, 3);

    expect(formOperationCanApply(newer, newer)).toBe(true);
    expect(formOperationCanApply(older, newer)).toBe(false);
  });

  it('does not let an older connection response overwrite a newer request with the same fingerprint', () => {
    const profile = { ...modelProfileFixture(openAiCapabilities(['medium'])), id: 'model-a' };
    const older = captureFormOperation(7, profile, 5);
    const newer = captureFormOperation(8, profile, 5);

    expect(formOperationCanApply(older, newer)).toBe(false);
    expect(formOperationCanApply(newer, newer)).toBe(true);
  });

  it('derives reasoning controls only from the selected profile capabilities', () => {
    expect(reasoningControls(modelProfileFixture(qwenCapabilities()))).toEqual({ kind: 'toggle' });
    expect(reasoningControls(modelProfileFixture(openAiCapabilities(['minimal', 'high', 'max'])))).toEqual({
      kind: 'effort',
      options: ['minimal', 'high', 'max'],
    });
    expect(reasoningControls(modelProfileFixture(openAiCapabilities([])))).toEqual({ kind: 'hidden' });
  });

  it('marks custom reasoning controls as unverified instead of inventing effort options', () => {
    const profile = modelProfileFixture({
      ...qwenCapabilities(),
      reasoning: { inputMode: 'custom', effortOptions: ['vendor-value'], outputModes: ['raw'] },
    });

    expect(reasoningControls(profile)).toEqual({ kind: 'custom', warning: true });
  });

  it('selects native summary before raw reasoning in automatic mode', () => {
    expect(selectReasoningContent('auto', [rawReasoning, summaryReasoning])).toEqual({
      availability: 'available',
      mode: 'summary',
      text: '摘要',
    });
    expect(selectReasoningContent('auto', [rawReasoning])).toEqual({
      availability: 'available',
      mode: 'raw',
      text: '分析',
    });
    expect(selectReasoningContent('auto', [])).toEqual({ availability: 'empty', text: '' });
  });

  it('reports an explicitly selected unavailable reasoning mode as unsupported', () => {
    expect(selectReasoningContent('summary', [rawReasoning])).toEqual({
      availability: 'unsupported',
      mode: 'summary',
      text: '',
    });
    expect(selectReasoningContent('raw', [summaryReasoning])).toEqual({
      availability: 'unsupported',
      mode: 'raw',
      text: '',
    });
  });

  it('returns localized failure feedback instead of rejecting when clipboard access fails', async () => {
    await expect(copyTextWithFeedback(
      async () => { throw new Error('clipboard denied'); },
      'private reasoning',
    )).resolves.toBe('failed');

    const writeText = vi.fn(async () => undefined);
    await expect(copyTextWithFeedback(writeText, 'private reasoning')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('private reasoning');
    expect(createTranslator('en-US')('copyReasoningFailed')).toBe('Could not copy reasoning. Try again.');
    expect(createTranslator('zh-CN')('copyReasoningFailed')).toBe('复制思考内容失败，请重试。');
  });

  it('keeps an unavailable explicit reasoning choice visible and auto mode phase-only while running', () => {
    expect(shouldShowReasoningPanel('summary', [], false)).toBe(true);
    expect(shouldShowReasoningPanel('raw', [], false)).toBe(true);
    expect(shouldShowReasoningPanel('auto', [], true)).toBe(true);
    expect(shouldShowReasoningPanel('auto', [], false)).toBe(false);
  });

  it('keeps declared explicit reasoning pending until a running turn can emit its first delta', () => {
    expect(selectReasoningContent('summary', [], { running: true, outputModes: ['summary'] })).toEqual({
      availability: 'empty',
      mode: 'summary',
      text: '',
    });
    expect(selectReasoningContent('summary', [], { running: false, outputModes: ['summary'] })).toEqual({
      availability: 'unsupported',
      mode: 'summary',
      text: '',
    });
  });

  it('binds running reasoning capability to the runtime model when the selected model changes', () => {
    const runtimeProfile = { ...modelProfileFixture(openAiCapabilities(['medium'])), id: 'model-a' };
    const selectedProfile = { ...modelProfileFixture(openAiCapabilities([])), id: 'model-b' };
    const resolved = reasoningProfileForRuntime(
      [runtimeProfile, selectedProfile],
      selectedProfile,
      { threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-a', status: 'running' },
    );

    expect(resolved?.id).toBe('model-a');
    expect(selectReasoningContent('summary', [], {
      running: true,
      outputModes: resolved?.capabilities.reasoning.outputModes ?? [],
    })).toEqual({ availability: 'empty', mode: 'summary', text: '' });
  });

  it('closes the effort menu only for explicit close commands', () => {
    expect(reasoningMenuCommand('Escape')).toBe('close');
    expect(reasoningMenuCommand('ArrowDown')).toBe('keep');
  });

  it('maps only the active chat runtime to the composer action', () => {
    expect(composerAction({ threadId: 'thread-1', status: 'queued', queuePosition: 2 })).toBe('cancel');
    expect(composerAction({ threadId: 'thread-1', status: 'running' })).toBe('stop');
    expect(composerAction({ threadId: 'thread-1', status: 'cancelling' })).toBe('stop');
    expect(composerAction({ threadId: 'thread-1', status: 'completed' })).toBe('send');
    expect(composerAction(undefined)).toBe('send');
  });

  it('groups raw and summary reasoning for one collapsible panel per turn', () => {
    expect(groupReasoningItems([rawReasoning, summaryReasoning])).toEqual([
      { turnId: 'turn-1', anchorId: 'raw-1', raw: rawReasoning, summary: summaryReasoning },
    ]);
  });

  it('presents queue position and terminal runtime states without falling back to thread status', () => {
    expect(threadRuntimePresentation({ threadId: 'thread-1', status: 'queued', queuePosition: 3 }, 'ready')).toEqual({
      key: 'queuedPosition',
      queuePosition: 3,
      active: true,
    });
    expect(threadRuntimePresentation({ threadId: 'thread-1', status: 'interrupted' }, 'ready')).toEqual({
      key: 'interrupted',
      active: false,
    });
    expect(threadRuntimePresentation(undefined, 'failed')).toEqual({ key: 'failed', active: false });
    expect(threadRuntimePresentation({ threadId: 'thread-1', status: 'queued' }, 'ready')).toEqual({
      key: 'queued',
      active: true,
    });
  });

  it('deduplicates events by thread and sequence', () => {
    const state = reduceEvent(emptyState(), deltaEvent(1));

    expect(reduceEvent(state, deltaEvent(1))).toEqual(state);
  });

  it('does not deduplicate the same sequence number across different turns', () => {
    const first = reduceEvent(emptyState(), {
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      sequence: 1,
      title: 'first',
    });

    const second = reduceEvent(first, {
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-2',
      sequence: 1,
      title: 'second',
    });

    expect(second.events).toHaveLength(2);
  });

  it('tracks active runtime without changing the selected chat after completion', () => {
    const selected = { ...emptyState(), activeThreadId: 'thread-1' };
    const running = reduceEvent(selected, {
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelProfileId: 'model-1',
      sequence: 1,
      title: 'run',
    });
    expect(running.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });

    const completed = reduceEvent(running, {
      type: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelProfileId: 'model-1',
      sequence: 2,
    });
    expect(completed.activeThreadId).toBe('thread-1');
    expect(completed.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'completed' });
  });

  it('marks a required approval as pending', () => {
    const state = reduceEvent({ ...emptyState(), activeThreadId: 'thread-1' }, approvalEvent());

    expect(state.pendingApproval?.status).toBe('pending');
  });

  it('derives the Inspector approval from the selected chat', () => {
    const app = useApp();
    app.state.value = {
      ...app.state.value,
      activeThreadId: 'thread-1',
      snapshot: {
        ...app.state.value.snapshot,
        approvals: [
          {
            id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', title: 'First', description: 'First approval',
            status: 'pending', createdAt: '2026-08-17T00:00:00.000Z',
          },
          {
            id: 'approval-2', threadId: 'thread-2', turnId: 'turn-2', title: 'Second', description: 'Second approval',
            status: 'pending', createdAt: '2026-08-17T00:00:01.000Z',
          },
        ],
      },
    };

    expect(app.activePendingApproval.value?.id).toBe('approval-1');
    app.state.value.activeThreadId = 'thread-2';
    expect(app.activePendingApproval.value?.id).toBe('approval-2');
  });

  it('responds to the explicit approval ID instead of ambient pending state', async () => {
    const originalWindow = globalThis.window;
    let response: { approvalId: string; approved: boolean } | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          respondApproval: async (approvalId: string, approved: boolean) => {
            response = { approvalId, approved };
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-2',
        pendingApproval: {
          id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', title: 'First', description: 'First approval',
          status: 'pending', createdAt: '2026-08-17T00:00:00.000Z',
        },
        snapshot: {
          ...app.state.value.snapshot,
          approvals: [{
            id: 'approval-2', threadId: 'thread-2', turnId: 'turn-2', title: 'Second', description: 'Second approval',
            status: 'pending', createdAt: '2026-08-17T00:00:01.000Z',
          }],
        },
      };

      await app.respondApproval('approval-2', false);

      expect(response).toEqual({ approvalId: 'approval-2', approved: false });
      expect(app.state.value.snapshot.approvals).toContainEqual(expect.objectContaining({
        id: 'approval-2', status: 'rejected', respondedAt: expect.any(String),
      }));
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it.each([
    { name: 'false', respond: async () => false },
    { name: 'rejection', respond: async () => { throw new Error('agent unavailable'); } },
  ])('refreshes authoritative approvals after approval acknowledgement $name', async ({ respond }) => {
    const originalWindow = globalThis.window;
    let snapshotCalls = 0;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          respondApproval: respond,
          getSnapshot: async () => {
            snapshotCalls += 1;
            return emptyState().snapshot;
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        snapshot: {
          ...app.state.value.snapshot,
          approvals: [{
            id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', title: 'First', description: 'First approval',
            status: 'pending', createdAt: '2026-08-17T00:00:00.000Z',
          }],
        },
      };

      await expect(app.respondApproval('approval-1', true)).rejects.toThrow();
      expect(snapshotCalls).toBe(1);
      expect(app.state.value.snapshot.approvals).toEqual([]);
      expect(app.approvalResponseInFlightId.value).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('exposes the exact approval response while it is in flight', async () => {
    const originalWindow = globalThis.window;
    let resolveResponse!: () => void;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          respondApproval: () => new Promise<void>((resolve) => { resolveResponse = resolve; }),
        },
      },
      configurable: true,
    });
    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        snapshot: {
          ...app.state.value.snapshot,
          approvals: [{
            id: 'approval-1', threadId: 'thread-1', turnId: 'turn-1', title: 'First', description: 'First approval',
            status: 'pending', createdAt: '2026-08-17T00:00:00.000Z',
          }],
        },
      };
      const response = app.respondApproval('approval-1', true);
      expect(app.approvalResponseInFlightId.value).toBe('approval-1');
      resolveResponse();
      await response;
      expect(app.approvalResponseInFlightId.value).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('translates app chrome in English and Chinese', () => {
    expect(createTranslator('en-US')('settings')).toBe('Settings');
    expect(createTranslator('zh-CN')('settings')).toBe('设置');
    expect(createTranslator('en-US')('approvalResponseFailed')).toBe(
      'Could not respond to this approval. Its current state has been refreshed.',
    );
    expect(createTranslator('zh-CN')('approvalResponseFailed')).toBe('审批响应失败，已刷新其当前状态。');
  });

  it('recognizes only supported language preferences', () => {
    expect(isLanguagePreference('zh-CN')).toBe(true);
    expect(isLanguagePreference('en-US')).toBe(true);
    expect(isLanguagePreference('ja-JP')).toBe(false);
  });

  it('combines streamed assistant chunks from the same turn into one timeline message', () => {
    const items: Item[] = [
      {
        id: 'item-turn-1-user',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'user',
        text: '请只输出：客户端连接正常',
        createdAt: '2026-08-17T00:00:00.000Z',
      },
      {
        id: 'item-turn-1-assistant-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '客户端',
        createdAt: '2026-08-17T00:00:01.000Z',
      },
      {
        id: 'item-turn-1-assistant-2',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '连接',
        createdAt: '2026-08-17T00:00:02.000Z',
      },
      {
        id: 'item-turn-1-assistant-3',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '正常',
        createdAt: '2026-08-17T00:00:03.000Z',
      },
    ];

    expect(createTimelineEntries(items, []).filter((entry) => entry.kind === 'message')).toMatchObject([
      { role: 'user', text: '请只输出：客户端连接正常' },
      { role: 'assistant', text: '客户端连接正常' },
    ]);
  });

  it('renders assistant markdown into safe structured HTML', () => {
    const html = renderMarkdown('### 安装方式\n\n- Docker\n- 源码\n\n```bash\ndocker run redis:7\n```\n\n<script>alert(1)</script>');

    expect(html).toContain('<h3>安装方式</h3>');
    expect(html).toContain('<ul><li>Docker</li><li>源码</li></ul>');
    expect(html).toContain('<pre><code>docker run redis:7</code></pre>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('adds the submitted user message to the local snapshot immediately', () => {
    const state = appendOptimisticUserMessage(emptyState(), 'thread-1', 'turn-1', 'hello from user');

    expect(state.snapshot.items['thread-1']).toMatchObject([
      {
        id: 'item-turn-1-user',
        role: 'user',
        text: 'hello from user',
      },
    ]);
  });

  it('applies assistant deltas to a single local snapshot message', () => {
    const first = applyAssistantDeltaToSnapshot(emptyState(), 'thread-1', 'turn-1', '客户端');
    const second = applyAssistantDeltaToSnapshot(first, 'thread-1', 'turn-1', '连接正常');

    expect(second.snapshot.items['thread-1']).toMatchObject([
      {
        id: 'item-turn-1-assistant-live',
        role: 'assistant',
        text: '客户端连接正常',
      },
    ]);
  });

  it('does not duplicate a live assistant message when the same turn already has persisted assistant text', () => {
    const items: Item[] = [
      {
        id: 'item-turn-1-assistant-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '收到。',
        createdAt: '2026-08-17T00:00:01.000Z',
      },
      {
        id: 'item-turn-1-assistant-live',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '收到。',
        createdAt: '2026-08-17T00:00:02.000Z',
      },
    ];

    expect(createTimelineEntries(items, []).filter((entry) => entry.kind === 'message')).toMatchObject([
      { role: 'assistant', text: '收到。' },
    ]);
  });

  it('keeps reasoning modes separate from answer messages in the timeline', () => {
    const items: Item[] = [
      {
        id: 'item-turn-1-assistant-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '前半',
        createdAt: '2026-08-17T00:00:01.000Z',
      },
      {
        id: 'item-turn-1-reasoning-raw',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'reasoning',
        mode: 'raw',
        text: '分析',
        incomplete: true,
        createdAt: '2026-08-17T00:00:02.000Z',
      },
      {
        id: 'item-turn-1-reasoning-summary',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'reasoning',
        mode: 'summary',
        text: '摘要',
        incomplete: false,
        createdAt: '2026-08-17T00:00:03.000Z',
      },
      {
        id: 'item-turn-1-assistant-2',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: '后半',
        createdAt: '2026-08-17T00:00:04.000Z',
      },
    ];

    expect(createTimelineEntries(items)).toMatchObject([
      { kind: 'message', role: 'assistant', text: '前半' },
      { kind: 'reasoning', mode: 'raw', text: '分析', incomplete: true },
      { kind: 'reasoning', mode: 'summary', text: '摘要', incomplete: false },
      { kind: 'message', role: 'assistant', text: '后半' },
    ]);
  });

  it('renders turn failures in the conversation timeline', () => {
    expect(
      createTimelineEntries([], [
        {
          type: 'turn.failed',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 3,
          error: 'Model endpoint returned HTTP 503.',
        },
      ]),
    ).toContainEqual({
      id: 'turn.failed-turn-1-3',
      kind: 'tool',
      status: 'failed',
      text: 'Model endpoint returned HTTP 503.',
    });
  });

  it('exposes runtime settings updates that refresh the local snapshot', async () => {
    const originalWindow = globalThis.window;
    const snapshot = {
      groups: [],
      threads: [],
      items: {},
      approvals: [],
      modelProfiles: [],
      settings: {
        theme: 'system' as const,
        language: 'zh-CN' as const,
        showModelMetrics: true,
        contextMessageLimit: 20,
      },
    };
    let currentSnapshot = snapshot;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          getSnapshot: async () => currentSnapshot,
          updateSettings: async (settings: { showModelMetrics?: boolean; contextMessageLimit?: number }) => {
            currentSnapshot = { ...currentSnapshot, settings: { ...currentSnapshot.settings, ...settings } };
            return currentSnapshot.settings;
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = reduceEvent(app.state.value, { type: 'snapshot', snapshot });

      await app.updateSettings({ showModelMetrics: false });

      expect(app.state.value.snapshot.settings.showModelMetrics).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('cancels only the active chat turn and waits in cancelling for a terminal event', async () => {
    const originalWindow = globalThis.window;
    let cancelled: { threadId: string; turnId: string } | undefined;
    let resolveCancel: (() => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          cancelTurn: (threadId: string, turnId: string) => {
            cancelled = { threadId, turnId };
            return new Promise<void>((resolve) => {
              resolveCancel = resolve;
            });
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        runtimeByThread: {
          'thread-1': { threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', status: 'running' },
          'thread-2': { threadId: 'thread-2', turnId: 'turn-2', modelProfileId: 'model-1', status: 'running' },
        },
      };

      const cancelling = app.cancelTurn();

      expect(cancelled).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
      expect(app.activeTurnId.value).toBe('turn-1');
      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('cancelling');
      expect(app.state.value.runtimeByThread['thread-2'].status).toBe('running');
      resolveCancel?.();
      await cancelling;
      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('cancelling');

      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.cancelled',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        sequence: 4,
      });
      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('cancelled');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('does not send cancellation for a terminal active runtime', async () => {
    const originalWindow = globalThis.window;
    let cancelCalls = 0;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          cancelTurn: async () => {
            cancelCalls += 1;
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        runtimeByThread: {
          'thread-1': { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
        },
      };

      await app.cancelTurn();

      expect(cancelCalls).toBe(0);
      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('completed');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('restores the active runtime when the cancellation request is rejected before a terminal event', async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          cancelTurn: async () => {
            throw new Error('Agent runtime is not ready.');
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        runtimeByThread: {
          'thread-1': { threadId: 'thread-1', turnId: 'turn-1', status: 'running' },
        },
      };

      await expect(app.cancelTurn()).rejects.toThrow('Agent runtime is not ready.');

      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('running');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('reloads authoritative runtime state when cancellation is not accepted', async () => {
    const originalWindow = globalThis.window;
    let snapshotCalls = 0;
    const authoritativeSnapshot: AppSnapshot = {
      ...emptyState().snapshot,
      groups: [{
        id: 'group-1', name: 'Group', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      }],
      threads: [{
        id: 'thread-1', groupId: 'group-1', title: 'Chat', status: 'running', modelProfileId: 'model-1',
        createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:01.000Z',
      }],
      turns: [{
        id: 'turn-1', threadId: 'thread-1', modelProfileId: 'model-1', status: 'running',
        createdAt: '2026-08-17T00:00:00.000Z', startedAt: '2026-08-17T00:00:01.000Z', incomplete: true,
      }],
    };
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          cancelTurn: async () => false,
          getSnapshot: async () => {
            snapshotCalls += 1;
            return authoritativeSnapshot;
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = reduceEvent(app.state.value, { type: 'snapshot', snapshot: authoritativeSnapshot });

      await app.cancelTurn();

      expect(snapshotCalls).toBe(1);
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('cancels the current turn after superseded turn events arrive late', async () => {
    const originalWindow = globalThis.window;
    let cancelled: { threadId: string; turnId: string } | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          cancelTurn: async (threadId: string, turnId: string) => {
            cancelled = { threadId, turnId };
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started', threadId: 'thread-1', turnId: 'turn-old', modelProfileId: 'model-1', sequence: 1, title: 'old',
      });
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.completed', threadId: 'thread-1', turnId: 'turn-old', modelProfileId: 'model-1', sequence: 2,
      });
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started', threadId: 'thread-1', turnId: 'turn-new', modelProfileId: 'model-1', sequence: 1, title: 'new',
      });
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started', threadId: 'thread-1', turnId: 'turn-old', modelProfileId: 'model-1', sequence: 3, title: 'late old',
      });

      await app.cancelTurn();

      expect(cancelled).toEqual({ threadId: 'thread-1', turnId: 'turn-new' });
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-new', status: 'cancelling' });
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('optimistically queues only the target chat until the start acknowledgement arrives', async () => {
    const originalWindow = globalThis.window;
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((resolve) => {
            resolveStart = resolve;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        runtimeByThread: {
          'thread-2': { threadId: 'thread-2', turnId: 'turn-2', modelProfileId: 'model-1', status: 'running' },
        },
      };

      const turn = app.startTurn('hello');

      expect(app.activeRuntime.value).toMatchObject({ threadId: 'thread-1', status: 'queued' });
      expect(app.activeBusy.value).toBe(true);
      expect(app.state.value.runtimeByThread['thread-2'].status).toBe('running');
      app.state.value = reduceEvent(app.state.value, {
        type: 'snapshot',
        snapshot: {
          ...emptyState().snapshot,
          threads: [{
            id: 'thread-1',
            groupId: 'default-group',
            title: 'New task',
            status: 'ready',
            createdAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z',
          }],
        },
      });
      expect(app.activeRuntime.value).toMatchObject({ threadId: 'thread-1', status: 'queued' });
      resolveStart?.({ turnId: 'turn-1' });
      await turn;
      expect(app.activeTurnId.value).toBe('turn-1');
      expect(app.state.value.snapshot.items['thread-1']).toMatchObject([{ turnId: 'turn-1', role: 'user', text: 'hello' }]);
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('preserves a queued worker event through acknowledgement and cancels its real turn', async () => {
    const originalWindow = globalThis.window;
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    let cancelled: { threadId: string; turnId: string } | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((resolve) => {
            resolveStart = resolve;
          }),
          cancelTurn: async (threadId: string, turnId: string) => {
            cancelled = { threadId, turnId };
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      const turn = app.startTurn('hello');
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.queued',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        sequence: 1,
        queuePosition: 1,
      });

      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        status: 'queued',
        queuePosition: 1,
      });
      resolveStart?.({ turnId: 'turn-1' });
      await turn;
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({
        turnId: 'turn-1',
        status: 'queued',
        queuePosition: 1,
      });

      await app.cancelTurn();
      expect(cancelled).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'cancelling' });
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('lets an event arriving before the start acknowledgement claim the optimistic turn', async () => {
    const originalWindow = globalThis.window;
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((resolve) => {
            resolveStart = resolve;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      const turn = app.startTurn('hello');
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        sequence: 1,
        title: 'run',
      });
      resolveStart?.({ turnId: 'turn-1' });
      await turn;

      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('keeps a snapshot-claimed optimistic turn running across a later acknowledgement', async () => {
    const originalWindow = globalThis.window;
    let resolveStart: ((value: { turnId: string }) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((resolve) => {
            resolveStart = resolve;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      const turn = app.startTurn('hello');
      app.state.value = reduceEvent(app.state.value, {
        type: 'snapshot',
        snapshot: {
          ...app.state.value.snapshot,
          turns: [{
            id: 'turn-1',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'queued',
            createdAt: '2026-08-17T00:00:00.000Z',
            incomplete: true,
          }],
        },
      });
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        sequence: 1,
        title: 'run',
      });
      resolveStart?.({ turnId: 'turn-1' });
      await turn;

      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'running' });
      expect(app.state.value.supersededTurns['thread-1:turn-1']).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('keeps a snapshot-confirmed turn when the later acknowledgement fails', async () => {
    const originalWindow = globalThis.window;
    let rejectStart: ((error: Error) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((_resolve, reject) => {
            rejectStart = reject;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      const turn = app.startTurn('hello');
      app.state.value = reduceEvent(app.state.value, {
        type: 'snapshot',
        snapshot: {
          ...app.state.value.snapshot,
          turns: [{
            id: 'turn-1',
            threadId: 'thread-1',
            modelProfileId: 'model-1',
            status: 'queued',
            createdAt: '2026-08-17T00:00:00.000Z',
            incomplete: true,
          }],
        },
      });
      rejectStart?.(new Error('late bridge failure'));

      await expect(turn).rejects.toThrow('late bridge failure');
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ turnId: 'turn-1', status: 'queued' });
      expect(app.state.value.optimisticThreads['thread-1']).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('rolls back only the optimistic target runtime when starting a turn fails', async () => {
    const originalWindow = globalThis.window;
    let rejectStart: ((error: Error) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((_resolve, reject) => {
            rejectStart = reject;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        runtimeByThread: {
          'thread-1': { threadId: 'thread-1', turnId: 'turn-old', status: 'completed' },
          'thread-2': { threadId: 'thread-2', turnId: 'turn-2', status: 'running' },
        },
      };

      const turn = app.startTurn('hello');
      expect(app.state.value.runtimeByThread['thread-1'].status).toBe('queued');
      expect(app.state.value.runtimeByThread['thread-1'].turnId).toBeUndefined();
      rejectStart?.(new Error('Agent runtime is not ready.'));
      await expect(turn).rejects.toThrow('Agent runtime is not ready.');

      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ status: 'completed', turnId: 'turn-old' });
      expect(app.state.value.runtimeByThread['thread-2'].status).toBe('running');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('rolls back the optimistic runtime when the turn start acknowledgement hangs', async () => {
    vi.useFakeTimers();
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: async () => new Promise(() => undefined),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
      };

      const turn = app.startTurn('hello');
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ status: 'queued' });
      const turnExpectation = expect(turn).rejects.toThrow('Agent runtime did not acknowledge');
      await vi.advanceTimersByTimeAsync(10_000);

      await turnExpectation;
      expect(app.state.value.runtimeByThread['thread-1']).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('keeps an event-confirmed runtime when the start acknowledgement fails late', async () => {
    const originalWindow = globalThis.window;
    let rejectStart: ((error: Error) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          startTurn: () => new Promise<{ turnId: string }>((_resolve, reject) => {
            rejectStart = reject;
          }),
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = { ...app.state.value, activeThreadId: 'thread-1' };
      const turn = app.startTurn('hello');
      app.state.value = reduceEvent(app.state.value, {
        type: 'turn.started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProfileId: 'model-1',
        sequence: 1,
        title: 'run',
      });
      rejectStart?.(new Error('late bridge failure'));

      await expect(turn).rejects.toThrow('late bridge failure');
      expect(app.state.value.runtimeByThread['thread-1']).toMatchObject({ status: 'running', turnId: 'turn-1' });
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('persists an arbitrary capability-declared effort from the current chat profile', async () => {
    const originalWindow = globalThis.window;
    const profile: ModelProfile = {
      ...modelProfileFixture(openAiCapabilities(['minimal', 'max'])),
      name: 'Private model endpoint',
      model: 'private-model',
      apiKeyConfigured: true,
      reasoning: { mode: 'enabled', protocol: 'openai', effort: 'minimal', display: 'auto' },
    };
    const snapshot: AppSnapshot = {
      groups: [],
      threads: [
        {
          id: 'thread-1',
          groupId: 'default-group',
          title: 'New task',
          status: 'ready' as const,
          modelProfileId: 'model-1',
          createdAt: '2026-08-17T00:00:00.000Z',
          updatedAt: '2026-08-17T00:00:00.000Z',
        },
      ],
      turns: [],
      items: {},
      approvals: [],
      modelProfiles: [profile],
      settings: {
        theme: 'system' as const,
        language: 'zh-CN' as const,
        activeModelProfileId: 'model-1',
        showModelMetrics: true,
        contextMessageLimit: 20,
        reasoningDisplayMode: 'auto',
      },
    };
    let savedProfile: unknown;
    let currentSnapshot = snapshot;
    let resolveSave: ((value: typeof profile) => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          getSnapshot: async () => currentSnapshot,
          saveModelProfile: (input: unknown) => {
            savedProfile = structuredClone(input);
            return new Promise<typeof profile>((resolve) => {
              resolveSave = resolve;
            });
          },
        },
      },
      configurable: true,
    });

    try {
      const app = useApp();
      app.state.value = {
        ...reduceEvent(app.state.value, { type: 'snapshot', snapshot }),
        activeThreadId: 'thread-1',
        activeGroupId: 'default-group',
      };

      const update = app.updateActiveModelRuntime({
        reasoning: { mode: 'enabled', effort: 'max' },
      });

      expect(app.activeModelProfile.value).toMatchObject({
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max' },
      });
      const saved = {
        ...profile,
        reasoning: { mode: 'enabled' as const, protocol: 'openai' as const, effort: 'max', display: 'auto' as const },
      };
      currentSnapshot = { ...currentSnapshot, modelProfiles: [saved] };
      resolveSave?.(saved);
      await update;

      expect(savedProfile).toMatchObject({
        id: 'model-1',
        name: 'Private model endpoint',
        capabilities: { reasoning: { effortOptions: ['minimal', 'max'] } },
        reasoning: { mode: 'enabled', protocol: 'openai', effort: 'max' },
      });
      expect(app.activeModelProfile.value?.reasoning.effort).toBe('max');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('renders the latest active model progress for a non-terminal turn', () => {
    const active = createTimelineEntries([], [
      { type: 'model.progress', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 1, phase: 'reasoning' },
      { type: 'model.progress', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 2, phase: 'answering' },
    ] as never);
    expect(active).toContainEqual({ id: 'model.progress-turn-1', kind: 'progress', phase: 'answering' });
  });

  it.each([
    { type: 'turn.completed' as const },
    { type: 'turn.failed' as const, error: 'HTTP 503' },
    { type: 'turn.cancelled' as const },
  ])('clears model progress after $type', (terminal) => {
    const finished = createTimelineEntries([], [
      { type: 'model.progress', threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 1, phase: 'reasoning' },
      { ...terminal, threadId: 'thread-1', turnId: 'turn-1', modelProfileId: 'model-1', sequence: 2 },
    ] as never);
    expect(finished.some((entry) => entry.kind === 'progress')).toBe(false);
  });

  it('renders model run metrics as a compact timeline row', () => {
    const runMetrics = {
      reasoningRequested: 'enabled' as const,
      reasoningProtocol: 'qwen' as const,
      reasoningObserved: true,
      responseSpeed: 'fast' as const,
      durationMs: 2_000,
      completionTokens: 40,
      tokensPerSecond: 20,
      speedSource: 'client' as const,
      usageSource: 'server' as const,
      finishReason: 'stop',
    };
    expect(
      createTimelineEntries([], [
        {
          type: 'model.metrics',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 3,
          metrics: runMetrics,
        },
      ], [], createTranslator('en-US')),
    ).toContainEqual({
      id: 'model.metrics-turn-1-3',
      kind: 'metrics',
      metrics: runMetrics,
      text: 'Reasoning: enabled/qwen · 2.0s · 20.0 tok/s (client) · 40 tokens (server) · stop',
    });
    expect(createTimelineEntries([], [{
      type: 'model.metrics',
      threadId: 'thread-1',
      turnId: 'turn-1',
      sequence: 3,
      metrics: runMetrics,
    }], [], createTranslator('zh-CN'))[0]?.text).toBe(
      '思考：enabled/qwen · 2.0s · 20.0 tok/s (client) · 40 tokens (server) · stop',
    );
  });

  it('places persisted metrics after the message from the same turn instead of stacking all metrics at the end', () => {
    const firstMetrics = {
      modelProfileId: 'model-1',
      modelName: 'Model 1',
      reasoningRequested: 'disabled' as const,
      reasoningProtocol: 'qwen' as const,
      reasoningObserved: false,
      durationMs: 1_000,
      completionTokens: 10,
      finishReason: 'stop',
    };
    const secondMetrics = {
      ...firstMetrics,
      durationMs: 2_000,
      completionTokens: 20,
    };
    const items: Item[] = [
      {
        id: 'item-turn-1-assistant',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: 'first answer',
        createdAt: '2026-08-17T00:00:01.000Z',
      },
      {
        id: 'item-turn-2-assistant',
        threadId: 'thread-1',
        turnId: 'turn-2',
        kind: 'message',
        role: 'assistant',
        text: 'second answer',
        createdAt: '2026-08-17T00:00:03.000Z',
      },
    ];
    const entries = createTimelineEntries(items, [], [
      {
        id: 'turn-1',
        threadId: 'thread-1',
        modelProfileId: 'model-1',
        status: 'completed',
        createdAt: '2026-08-17T00:00:00.000Z',
        completedAt: '2026-08-17T00:00:02.000Z',
        incomplete: false,
        metrics: firstMetrics,
      },
      {
        id: 'turn-2',
        threadId: 'thread-1',
        modelProfileId: 'model-1',
        status: 'completed',
        createdAt: '2026-08-17T00:00:02.000Z',
        completedAt: '2026-08-17T00:00:04.000Z',
        incomplete: false,
        metrics: secondMetrics,
      },
    ], createTranslator('en-US'));

    expect(entries.map((entry) => entry.id)).toEqual([
      'item-turn-1-assistant',
      'model.metrics-turn-1-persisted',
      'item-turn-2-assistant',
      'model.metrics-turn-2-persisted',
    ]);
  });

  it('rebuilds active Inspector and timeline metrics from a reloaded snapshot', () => {
    const app = useApp();
    const persistedMetrics = {
      modelProfileId: 'model-1',
      modelName: 'Model 1',
      reasoningRequested: 'enabled' as const,
      reasoningProtocol: 'qwen' as const,
      reasoningObserved: true,
      durationMs: 2_000,
      completionTokens: 40,
      tokensPerSecond: 20,
      speedSource: 'client' as const,
      usageSource: 'server' as const,
      finishReason: 'stop',
    };
    app.state.value = reduceEvent(app.state.value, {
      type: 'snapshot',
      snapshot: {
        ...emptyState().snapshot,
        groups: [{
          id: 'group-1', name: 'Group', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
        }],
        threads: [{
          id: 'thread-1', groupId: 'group-1', title: 'Chat', status: 'ready', modelProfileId: 'model-1',
          createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:03.000Z',
        }],
        turns: [{
          id: 'turn-1', threadId: 'thread-1', modelProfileId: 'model-1', status: 'completed',
          createdAt: '2026-08-17T00:00:00.000Z', completedAt: '2026-08-17T00:00:03.000Z',
          incomplete: false, metrics: persistedMetrics,
        }],
      },
    });

    expect(app.activeTurns.value).toHaveLength(1);
    expect(app.activeTurns.value[0]?.metrics).toEqual(persistedMetrics);
    expect(createTimelineEntries([], [], app.activeTurns.value, createTranslator('en-US'))).toContainEqual({
      id: 'model.metrics-turn-1-persisted',
      kind: 'metrics',
      metrics: persistedMetrics,
      text: 'Reasoning: enabled/qwen · 2.0s · 20.0 tok/s (client) · 40 tokens (server) · stop',
    });
  });

  it('treats scroll positions within 80px of the bottom as pinned', () => {
    expect(isNearBottom({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 819, clientHeight: 500, scrollHeight: 1500 })).toBe(false);
  });
});
