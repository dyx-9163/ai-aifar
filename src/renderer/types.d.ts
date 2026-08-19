export {};

import type {
  AppSettings,
  AppSnapshot,
  ChatGroup,
  LanguagePreference,
  ModelConnectionResult,
  ModelProfile,
  ModelProfileInput,
  RuntimeSettingsInput,
  ThreadSummary,
  TurnAttachment,
} from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

declare global {
  interface Window {
    desktop: {
      supportsTurnAttachments?: boolean;
      health(): Promise<{ ok: true; version: string }>;
      getSnapshot(): Promise<AppSnapshot>;
      createGroup(name: string): Promise<ChatGroup>;
      deleteGroup(groupId: string): Promise<void>;
      createThread(title: string, groupId?: string): Promise<ThreadSummary>;
      deleteThread(threadId: string): Promise<void>;
      setThreadModel(threadId: string, modelProfileId?: string): Promise<void>;
      startTurn(threadId: string, text: string, modelProfileId?: string, attachments?: TurnAttachment[]): Promise<{ turnId: string }>;
      cancelTurn(threadId: string, turnId: string): Promise<boolean>;
      respondApproval(approvalId: string, approved: boolean): Promise<boolean | void>;
      setLanguage(language: LanguagePreference): Promise<void>;
      updateSettings(settings: RuntimeSettingsInput): Promise<AppSettings>;
      saveModelProfile(profile: ModelProfileInput): Promise<ModelProfile>;
      deleteModelProfile(id: string): Promise<void>;
      testModelProfile(profile: ModelProfileInput): Promise<ModelConnectionResult>;
      subscribe(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
