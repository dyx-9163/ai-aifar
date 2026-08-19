import { describe, expect, it } from 'vitest';
import { isAgentEvent, isDesktopRequest } from '../src/shared/protocol';

describe('desktop protocol guards', () => {
  it('rejects a turn request without text', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1' })).toBe(false);
  });

  it('accepts a turn request with an optional model profile selection', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1', text: 'hi', modelProfileId: 'model-1' })).toBe(true);
  });

  it('accepts a turn request bound to a workspace', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1', text: 'hi', workspaceId: 'ws-1' })).toBe(true);
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1', text: 'hi', workspaceId: 42 })).toBe(false);
  });

  it('accepts a thread model selection request', () => {
    expect(isDesktopRequest({ type: 'thread.setModel', threadId: 't1', modelProfileId: 'model-1' })).toBe(true);
  });

  it('accepts thread create, pin, and soft delete requests', () => {
    expect(isDesktopRequest({ type: 'thread.delete', threadId: 't1' })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.create', title: 'Redis' })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.create', title: 'Redis', workspaceId: 'ws-1' })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.create', title: 'Redis', workspaceId: 42 })).toBe(false);
    expect(isDesktopRequest({ type: 'thread.pin', threadId: 't1', pinned: true })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.pin', threadId: 't1' })).toBe(false);
  });

  it('accepts an OpenAI-compatible model profile save request', () => {
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'AIFAR Qwen',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'Qwen3.5-9B',
          apiKey: 'local-not-used',
          isDefault: true,
        },
      }),
    ).toBe(true);
  });

  it('accepts a positive integer model output limit', () => {
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        name: 'Bounded model',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        maxOutputTokens: 2048,
      },
    })).toBe(true);
  });

  it('reuses the existing read-only model profile test request', () => {
    expect(isDesktopRequest({
      type: 'modelProfile.test',
      profile: {
        name: 'Local Qwen',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        maxConcurrency: 1,
        maxOutputTokens: 2048,
      },
    })).toBe(true);
  });

  it.each([0, -1, 1.5, '2048'])('rejects invalid model output limit %s', (maxOutputTokens) => {
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        name: 'Unbounded model',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        maxOutputTokens,
      },
    })).toBe(false);
  });

  it.each([
    'modelRuntime.start',
    'modelRuntime.stop',
    'modelRuntime.restart',
    'modelRuntime.status',
    'modelRuntime.inspect',
    'modelRuntime.poll',
  ])('rejects lifecycle or polling request %s', (type) => {
    expect(isDesktopRequest({ type })).toBe(false);
  });

  it('rejects reasoning settings without matching declared input capabilities', () => {
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'DeepSeek local',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'deepseek-r1',
          reasoning: { mode: 'enabled', protocol: 'openai', effort: 'xhigh' },
          responseSpeed: 'fast',
        },
      }),
    ).toBe(false);
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'Qwen local',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'qwen',
          reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium' },
          responseSpeed: 'standard',
        },
      }),
    ).toBe(false);
  });

  it('accepts provider-declared capability options', () => {
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        name: 'Local Qwen',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        capabilities: {
          reasoning: {
            inputMode: 'toggle',
            effortOptions: [],
            outputModes: ['raw'],
          },
          concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
          streaming: true,
          usage: { tokens: true, reasoningTokens: true },
        },
        reasoning: { mode: 'enabled', protocol: 'qwen', display: 'auto' },
      },
    })).toBe(true);
  });

  it('rejects invalid provider-declared capability options', () => {
    const profile = {
      name: 'Local Qwen',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
    };

    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        ...profile,
        capabilities: { reasoning: { effortOptions: ['high', 'high'] } },
      },
    })).toBe(false);
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        ...profile,
        capabilities: { reasoning: { effortOptions: [' '] } },
      },
    })).toBe(false);
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        ...profile,
        capabilities: { reasoning: { outputModes: ['details'] } },
      },
    })).toBe(false);
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        ...profile,
        capabilities: { concurrency: { defaultLimit: 0 } },
      },
    })).toBe(false);
  });

  it.each([
    ['toggle', 'openai'],
    ['effort', 'qwen'],
    ['toggle', 'none'],
    ['custom', 'custom'],
  ] as const)('accepts reasoning request format %s with provider label %s', (inputMode, protocol) => {
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        name: 'Generic reasoning mapping',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'fixture',
        capabilities: {
          reasoning: {
            inputMode,
            effortOptions: inputMode === 'effort' ? ['low'] : [],
            outputModes: [],
            customRequestBody: inputMode === 'custom' ? { extra_body: { thinking: true } } : undefined,
          },
        },
        reasoning: { mode: 'enabled', protocol, effort: 'low', display: 'auto' },
      },
    })).toBe(true);
  });

  it('rejects enabled reasoning when no request control format is declared', () => {
    expect(isDesktopRequest({
      type: 'modelProfile.save',
      profile: {
        name: 'Invalid reasoning mapping',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'fixture',
        capabilities: {
          reasoning: {
            inputMode: 'unsupported',
            effortOptions: [],
            outputModes: [],
          },
        },
        reasoning: { mode: 'enabled', protocol: 'none', effort: 'low', display: 'auto' },
      },
    })).toBe(false);
  });

  it('rejects invalid model runtime preferences', () => {
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'Bad speed',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'x',
          responseSpeed: 'turbo',
        },
      }),
    ).toBe(false);
  });

  it('rejects an incomplete model profile save request', () => {
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'Broken model',
          provider: 'openai-compatible',
          model: 'Qwen3.5-9B',
        },
      }),
    ).toBe(false);
  });

  it('accepts supported language settings', () => {
    expect(isDesktopRequest({ type: 'language.set', language: 'zh-CN' })).toBe(true);
    expect(isDesktopRequest({ type: 'language.set', language: 'en-US' })).toBe(true);
  });

  it('rejects unsupported language settings', () => {
    expect(isDesktopRequest({ type: 'language.set', language: 'fr-FR' })).toBe(false);
  });

  it('accepts bounded runtime settings updates', () => {
    expect(isDesktopRequest({ type: 'settings.update', settings: { showModelMetrics: false, contextMessageLimit: 50 } })).toBe(true);
    expect(isDesktopRequest({ type: 'settings.update', settings: { showModelMetrics: true } })).toBe(true);
  });

  it('rejects invalid runtime settings updates', () => {
    expect(isDesktopRequest({ type: 'settings.update', settings: { contextMessageLimit: 0 } })).toBe(false);
    expect(isDesktopRequest({ type: 'settings.update', settings: { contextMessageLimit: 201 } })).toBe(false);
    expect(isDesktopRequest({ type: 'settings.update', settings: { showModelMetrics: 'yes' } })).toBe(false);
  });

  it('accepts workspace registration and deletion requests', () => {
    expect(isDesktopRequest({ type: 'workspace.register', path: 'd:\\projects\\demo', trustLevel: 'read-only' })).toBe(true);
    expect(isDesktopRequest({ type: 'workspace.register', path: 'd:\\projects\\demo', trustLevel: 'read-write' })).toBe(true);
    expect(isDesktopRequest({ type: 'workspace.delete', workspaceId: 'workspace-1' })).toBe(true);
  });

  it('rejects malformed workspace requests', () => {
    expect(isDesktopRequest({ type: 'workspace.register', path: '', trustLevel: 'read-only' })).toBe(false);
    expect(isDesktopRequest({ type: 'workspace.register', path: 'd:\\projects\\demo', trustLevel: 'full-access' })).toBe(false);
    expect(isDesktopRequest({ type: 'workspace.delete', workspaceId: '' })).toBe(false);
  });

  it('accepts a streamed message event', () => {
    expect(
      isAgentEvent({
        type: 'message.delta',
        threadId: 't1',
        turnId: 'u1',
        modelProfileId: 'model-1',
        sequence: 1,
        text: 'Hi',
      }),
    ).toBe(true);
  });

  it('accepts model progress events for visible turn feedback', () => {
    expect(
      isAgentEvent({
        type: 'model.progress',
        threadId: 't1',
        turnId: 'u1',
        modelProfileId: 'model-1',
        sequence: 2,
        phase: 'reasoning',
      }),
    ).toBe(true);
    expect(
      isAgentEvent({
        type: 'model.progress',
        threadId: 't1',
        turnId: 'u1',
        modelProfileId: 'model-1',
        sequence: 3,
        phase: 'unknown',
      }),
    ).toBe(false);
  });

  it('accepts normalized model metrics events', () => {
    expect(
      isAgentEvent({
        type: 'model.metrics',
        threadId: 't1',
        turnId: 'u1',
        modelProfileId: 'model-1',
        sequence: 2,
        metrics: {
          reasoningRequested: 'enabled',
          reasoningProtocol: 'qwen',
          reasoningObserved: true,
          responseSpeed: 'fast',
          durationMs: 1000,
          tokensPerSecond: 8,
          speedSource: 'client',
          usageSource: 'server',
        },
      }),
    ).toBe(true);
  });

  it.each([
    { type: 'turn.queued', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 1, queuePosition: 2 },
    { type: 'answer.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 2, text: '答案' },
    { type: 'reasoning.raw.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 3, text: '分析' },
    { type: 'reasoning.summary.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 4, text: '摘要' },
    { type: 'turn.cancelling', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 5 },
    { type: 'turn.cancelled', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 6 },
  ])('accepts $type', (event) => {
    expect(isAgentEvent(event)).toBe(true);
  });

  it('rejects sequenced turn events without a model profile id', () => {
    expect(isAgentEvent({
      type: 'answer.delta',
      threadId: 't1',
      turnId: 'r1',
      sequence: 1,
      text: '答案',
    })).toBe(false);
  });
});
