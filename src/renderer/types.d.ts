export {};

import type {
  AppSettings,
  AppSnapshot,
  LanguagePreference,
  ModelConnectionResult,
  ModelProfile,
  ModelProfileInput,
  RuntimeSettingsInput,
  ThreadSummary,
  TurnAttachment,
  TurnRollbackReport,
  WorkspaceRecord,
  WorkspaceTrustLevel,
} from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

declare global {
  interface Window {
    desktop: {
      supportsTurnAttachments?: boolean;
      health(): Promise<{ ok: true; version: string }>;
      getSnapshot(): Promise<AppSnapshot>;
      createThread(title: string, workspaceId?: string): Promise<ThreadSummary>;
      deleteThread(threadId: string): Promise<void>;
      setThreadPinned(threadId: string, pinned: boolean): Promise<void>;
      setThreadModel(threadId: string, modelProfileId?: string): Promise<void>;
      startTurn(threadId: string, text: string, modelProfileId?: string, workspaceId?: string, attachments?: TurnAttachment[]): Promise<{ turnId: string }>;
      cancelTurn(threadId: string, turnId: string): Promise<boolean>;
      undoTurn(turnId: string): Promise<TurnRollbackReport>;
      respondApproval(approvalId: string, approved: boolean): Promise<boolean | void>;
      setLanguage(language: LanguagePreference): Promise<void>;
      updateSettings(settings: RuntimeSettingsInput): Promise<AppSettings>;
      saveModelProfile(profile: ModelProfileInput): Promise<ModelProfile>;
      deleteModelProfile(id: string): Promise<void>;
      testModelProfile(profile: ModelProfileInput): Promise<ModelConnectionResult>;
      registerWorkspace(path: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord>;
      deleteWorkspace(workspaceId: string): Promise<void>;
      setWorkspaceTrust(workspaceId: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord>;
      subscribe(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
