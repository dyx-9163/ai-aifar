export {};

import type {
  AppSettings,
  AppSnapshot,
  LanguagePreference,
  ModelConnectionResult,
  ModelProfile,
  ModelProfileInput,
  ModelProvider,
  ModelProviderInput,
  ModelCatalogResult,
  ProviderConnectionResult,
  ProviderModelInput,
  RuntimeSettingsInput,
  ThreadSummary,
  TurnAttachment,
  TurnRollbackReport,
  WorkspaceRecord,
  WorkspaceTrustLevel,
} from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';
import type { DesktopHealth } from '../main/appHealth';

declare global {
  interface Window {
    desktop: {
      supportsTurnAttachments?: boolean;
      health(): Promise<DesktopHealth>;
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
      saveModelProvider(provider: ModelProviderInput): Promise<ModelProvider>;
      deleteModelProvider(id: string): Promise<void>;
      discoverProviderModels(provider: ModelProviderInput): Promise<ModelCatalogResult>;
      testModelProvider(provider: ModelProviderInput, modelId: string): Promise<ProviderConnectionResult>;
      addProviderModels(providerId: string, models: ProviderModelInput[]): Promise<ModelProfile[]>;
      updateProviderModel(providerId: string, model: ProviderModelInput & { id: string }): Promise<ModelProfile>;
      deleteProviderModel(id: string): Promise<void>;
      registerWorkspace(path: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord>;
      deleteWorkspace(workspaceId: string): Promise<void>;
      setWorkspaceTrust(workspaceId: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord>;
      subscribe(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
