import { describe, expect, it } from 'vitest';
import {
  isLegacyLocalQwenPlaceholder,
  localQwenProfileInput,
} from '../src/agent/localQwenProfile';

describe('local Qwen profile preset', () => {
  it('declares the direct local Qwen endpoint and bounded defaults', () => {
    expect(localQwenProfileInput()).toMatchObject({
      name: 'Local Qwen3.5-9B',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
      maxConcurrency: 1,
      maxOutputTokens: 8192,
      reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
      capabilities: { reasoning: { inputMode: 'toggle', outputModes: ['raw'] } },
    });
  });

  it('returns fresh nested capability objects for every caller', () => {
    const first = localQwenProfileInput();
    const second = localQwenProfileInput();

    expect(first).not.toBe(second);
    expect(first.capabilities).not.toBe(second.capabilities);
    expect(first.capabilities?.reasoning).not.toBe(second.capabilities?.reasoning);
    expect(first.capabilities?.reasoning?.outputModes).not.toBe(second.capabilities?.reasoning?.outputModes);
  });

  it('recognizes only the exact local legacy placeholder identity', () => {
    expect(isLegacyLocalQwenPlaceholder({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'your-model-name',
    })).toBe(true);
    expect(isLegacyLocalQwenPlaceholder({
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'your-model-name',
    })).toBe(false);
    expect(isLegacyLocalQwenPlaceholder({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'my-custom-model',
    })).toBe(false);
  });
});
