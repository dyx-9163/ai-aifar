import { describe, expect, it } from 'vitest';
import { isAgentEvent, isDesktopRequest } from '../src/shared/protocol';

describe('desktop protocol guards', () => {
  it('rejects a turn request without text', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1' })).toBe(false);
  });

  it('accepts a turn request with an optional model profile selection', () => {
    expect(isDesktopRequest({ type: 'turn.start', threadId: 't1', text: 'hi', modelProfileId: 'model-1' })).toBe(true);
  });

  it('accepts a thread model selection request', () => {
    expect(isDesktopRequest({ type: 'thread.setModel', threadId: 't1', modelProfileId: 'model-1' })).toBe(true);
  });

  it('accepts chat group and soft delete requests', () => {
    expect(isDesktopRequest({ type: 'group.create', name: '运维问答' })).toBe(true);
    expect(isDesktopRequest({ type: 'group.delete', groupId: 'g1' })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.delete', threadId: 't1' })).toBe(true);
    expect(isDesktopRequest({ type: 'thread.create', title: 'Redis', groupId: 'g1' })).toBe(true);
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

  it('accepts model profile reasoning settings', () => {
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'DeepSeek local',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'deepseek-r1',
          reasoning: { mode: 'enabled', protocol: 'openai', effort: 'high' },
        },
      }),
    ).toBe(true);
    expect(
      isDesktopRequest({
        type: 'modelProfile.save',
        profile: {
          name: 'Qwen local',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'qwen',
          reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'medium' },
        },
      }),
    ).toBe(true);
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

  it('accepts a streamed message event', () => {
    expect(
      isAgentEvent({
        type: 'message.delta',
        threadId: 't1',
        turnId: 'u1',
        sequence: 1,
        text: 'Hi',
      }),
    ).toBe(true);
  });

  it('accepts normalized model metrics events', () => {
    expect(
      isAgentEvent({
        type: 'model.metrics',
        threadId: 't1',
        turnId: 'u1',
        sequence: 2,
        metrics: {
          reasoningRequested: 'enabled',
          reasoningProtocol: 'qwen',
          reasoningObserved: true,
          durationMs: 1000,
          tokensPerSecond: 8,
          speedSource: 'client',
          usageSource: 'server',
        },
      }),
    ).toBe(true);
  });
});
