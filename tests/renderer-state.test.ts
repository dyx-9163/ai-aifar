import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import type { AppSnapshot, Item, ModelCapabilities, ModelProfile, ReasoningItem } from '../src/shared/domain';
import { openAiCapabilities, qwenCapabilities } from '../src/agent/modelCapabilities';
import { appendOptimisticUserMessage, applyAssistantDeltaToSnapshot, emptyState, reduceEvent, useApp } from '../src/renderer/composables/useApp';
import { createTranslator, isLanguagePreference } from '../src/renderer/i18n';
import { renderMarkdown } from '../src/renderer/markdown';
import {
  composerAction,
  groupReasoningItems,
  reasoningControls,
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

  it('keeps an unavailable explicit reasoning choice visible and auto mode phase-only while running', () => {
    expect(shouldShowReasoningPanel('summary', [], false)).toBe(true);
    expect(shouldShowReasoningPanel('raw', [], false)).toBe(true);
    expect(shouldShowReasoningPanel('auto', [], true)).toBe(true);
    expect(shouldShowReasoningPanel('auto', [], false)).toBe(false);
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
    const state = reduceEvent(emptyState(), approvalEvent());

    expect(state.pendingApproval?.status).toBe('pending');
  });

  it('translates app chrome in English and Chinese', () => {
    expect(createTranslator('en-US')('settings')).toBe('Settings');
    expect(createTranslator('zh-CN')('settings')).toBe('设置');
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
    expect(
      createTimelineEntries([], [
        {
          type: 'model.metrics',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 3,
          metrics: {
            reasoningRequested: 'enabled',
            reasoningProtocol: 'qwen',
            reasoningObserved: true,
            responseSpeed: 'fast',
            durationMs: 2_000,
            completionTokens: 40,
            tokensPerSecond: 20,
            speedSource: 'client',
            usageSource: 'server',
            finishReason: 'stop',
          },
        },
      ]),
    ).toContainEqual({
      id: 'model.metrics-turn-1-3',
      kind: 'metrics',
      text: '思考：enabled/qwen · 2.0s · 20.0 tok/s (client) · 40 tokens (server) · stop',
    });
  });

  it('treats scroll positions within 80px of the bottom as pinned', () => {
    expect(isNearBottom({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 819, clientHeight: 500, scrollHeight: 1500 })).toBe(false);
  });
});
