import type { ModelProfileInput } from '../shared/domain.js';
import {
  LOCAL_QWEN_BASE_URL,
  LOCAL_QWEN_MODEL,
  LOCAL_QWEN_PROFILE_ID,
} from '../shared/localQwenIdentity.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, qwenCapabilities } from './modelCapabilities.js';

export { LOCAL_QWEN_BASE_URL, LOCAL_QWEN_MODEL, LOCAL_QWEN_PROFILE_ID } from '../shared/localQwenIdentity.js';

type ModelIdentity = Pick<ModelProfileInput, 'provider' | 'baseUrl' | 'model'>;

export function localQwenProfileInput() {
  return {
    id: LOCAL_QWEN_PROFILE_ID,
    name: 'Local Qwen3.5-9B',
    provider: 'openai-compatible',
    deploymentType: 'private',
    runtimeType: 'llama.cpp',
    baseUrl: LOCAL_QWEN_BASE_URL,
    model: LOCAL_QWEN_MODEL,
    capabilities: qwenCapabilities(),
    reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
    maxConcurrency: 1,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  } satisfies ModelProfileInput;
}

export function isLegacyLocalQwenPlaceholder(profile: ModelIdentity): boolean {
  return profile.provider === 'openai-compatible' &&
    profile.baseUrl === LOCAL_QWEN_BASE_URL &&
    profile.model === 'your-model-name';
}
