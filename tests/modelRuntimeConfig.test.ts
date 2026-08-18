import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(new URL('../model-runtime/compose.yaml', import.meta.url), 'utf8');
const env = readFileSync(new URL('../model-runtime/.env.example', import.meta.url), 'utf8');

describe('direct llama.cpp runtime', () => {
  it('has three profiles and no proxy', () => {
    expect(compose).toContain('profiles: ["cpu"]');
    expect(compose).toContain('profiles: ["hybrid"]');
    expect(compose).toContain('profiles: ["gpu"]');
    expect(compose).not.toMatch(/context[-_]proxy|UPSTREAM_URL/i);
  });

  it('binds only loopback and mounts both artifacts read-only', () => {
    expect(compose.match(/127\.0\.0\.1:8080:8080/g)).toHaveLength(3);
    expect(compose.match(/Qwen_Qwen3\.5-9B-Q4_K_M\.gguf:[^\n]+:ro/g)).toHaveLength(3);
    expect(compose.match(/mmproj-Qwen_Qwen3\.5-9B-bf16\.gguf:[^\n]+:ro/g)).toHaveLength(3);
  });

  it('publishes bounded defaults', () => {
    expect(env).toContain('LLAMA_PARALLEL=1');
    expect(env).toContain('LLAMA_CTX_SIZE=16384');
    expect(env).toContain('LLAMA_N_PREDICT=2048');
    expect(env).not.toContain('LLAMA_HTTP_TIMEOUT=');
  });
});
