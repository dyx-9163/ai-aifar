import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/protocol';
import type { Item } from '../src/shared/domain';
import { appendOptimisticUserMessage, applyAssistantDeltaToSnapshot, emptyState, reduceEvent, useApp } from '../src/renderer/composables/useApp';
import { createTranslator, isLanguagePreference } from '../src/renderer/i18n';
import { renderMarkdown } from '../src/renderer/markdown';
import { isNearBottom } from '../src/renderer/scrolling';
import { createTimelineEntries } from '../src/renderer/timeline';

function deltaEvent(sequence: number): AgentEvent {
  return {
    type: 'message.delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence,
    text: 'Hello',
  };
}

function approvalEvent(): AgentEvent {
  return {
    type: 'approval.required',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence: 2,
    approvalId: 'approval-1',
    title: 'Approve change',
    description: 'Simulated write approval.',
  };
}

describe('renderer state reducer', () => {
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

  it('tracks the active running turn and clears it after completion', () => {
    const running = reduceEvent(emptyState(), {
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
      sequence: 1,
      title: 'run',
    });
    expect(running.activeTurnId).toBe('turn-1');

    const completed = reduceEvent(running, {
      type: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      sequence: 2,
    });
    expect(completed.activeTurnId).toBeUndefined();
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

  it('cancels the active running turn through the desktop bridge', async () => {
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
      app.state.value = {
        ...app.state.value,
        activeThreadId: 'thread-1',
        activeTurnId: 'turn-1',
        busy: true,
      };

      await app.cancelTurn();

      expect(cancelled).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
      expect(app.state.value.busy).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('updates the active model runtime preferences from the chat header', async () => {
    const originalWindow = globalThis.window;
    const profile = {
      id: 'model-1',
      name: 'Private model endpoint',
      provider: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'private-model',
      apiKeyConfigured: true,
      capabilities: { text: true, vision: false, longContext: false, reasoning: true, streamingUsage: true },
      reasoning: { mode: 'disabled' as const, protocol: 'qwen' as const, effort: 'medium' as const },
      responseSpeed: 'standard' as const,
      isDefault: true,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    };
    const snapshot = {
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
      items: {},
      approvals: [],
      modelProfiles: [profile],
      settings: {
        theme: 'system' as const,
        language: 'zh-CN' as const,
        activeModelProfileId: 'model-1',
        showModelMetrics: true,
        contextMessageLimit: 20,
      },
    };
    let savedProfile: unknown;
    let currentSnapshot = snapshot;
    Object.defineProperty(globalThis, 'window', {
      value: {
        desktop: {
          getSnapshot: async () => currentSnapshot,
          saveModelProfile: async (input: unknown) => {
            savedProfile = input;
            currentSnapshot = {
              ...currentSnapshot,
              modelProfiles: [
                {
                  ...profile,
                  reasoning: { mode: 'enabled' as const, protocol: 'qwen' as const, effort: 'high' as const },
                  responseSpeed: 'fast' as const,
                },
              ],
            };
            return currentSnapshot.modelProfiles[0];
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

      await app.updateActiveModelRuntime({
        reasoning: { mode: 'enabled', effort: 'high' },
        responseSpeed: 'fast',
      });

      expect(savedProfile).toMatchObject({
        id: 'model-1',
        name: 'Private model endpoint',
        reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'high' },
        responseSpeed: 'fast',
      });
      expect(app.activeModelProfile.value?.responseSpeed).toBe('fast');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
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
      text: '思考：enabled/qwen · 2.0s · 20.0 tok/s (client) · 速度：fast · 40 tokens (server) · stop',
    });
  });

  it('treats scroll positions within 80px of the bottom as pinned', () => {
    expect(isNearBottom({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 819, clientHeight: 500, scrollHeight: 1500 })).toBe(false);
  });
});
