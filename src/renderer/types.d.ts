export {};

import type {
  AppSettings,
  AppSnapshot,
  ChatGroup,
  LanguagePreference,
  ModelProfile,
  ModelProfileInput,
  RuntimeSettingsInput,
  ThreadSummary,
} from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

declare global {
  interface Window {
    desktop: {
      health(): Promise<{ ok: true; version: string }>;
      getSnapshot(): Promise<AppSnapshot>;
      createGroup(name: string): Promise<ChatGroup>;
      deleteGroup(groupId: string): Promise<void>;
      createThread(title: string, groupId?: string): Promise<ThreadSummary>;
      deleteThread(threadId: string): Promise<void>;
      setThreadModel(threadId: string, modelProfileId?: string): Promise<void>;
      startTurn(threadId: string, text: string, modelProfileId?: string): Promise<{ turnId: string }>;
      respondApproval(approvalId: string, approved: boolean): Promise<void>;
      setLanguage(language: LanguagePreference): Promise<void>;
      updateSettings(settings: RuntimeSettingsInput): Promise<AppSettings>;
      saveModelProfile(profile: ModelProfileInput): Promise<ModelProfile>;
      deleteModelProfile(id: string): Promise<void>;
      testModelProfile(profile: ModelProfileInput): Promise<{ ok: true; message: string }>;
      subscribe(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
