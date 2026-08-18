import type { ModelProfileInput } from './domain.js';

export const LOCAL_QWEN_BASE_URL = 'http://127.0.0.1:8080/v1';
export const LOCAL_QWEN_MODEL = 'Qwen3.5-9B';
export const LOCAL_QWEN_PROFILE_ID = 'local-qwen35';

type LocalQwenIdentity = Pick<ModelProfileInput, 'id' | 'provider' | 'baseUrl' | 'model'>;

export function isBuiltInLocalQwen(profile: LocalQwenIdentity): boolean {
  return profile.id === LOCAL_QWEN_PROFILE_ID
    && isLocalQwenServiceProfile(profile);
}

export function isLocalQwenServiceProfile(
  profile: Pick<ModelProfileInput, 'provider' | 'baseUrl' | 'model'>,
): boolean {
  return profile.provider === 'openai-compatible'
    && profile.baseUrl === LOCAL_QWEN_BASE_URL
    && profile.model === LOCAL_QWEN_MODEL;
}
