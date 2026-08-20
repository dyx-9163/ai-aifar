import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopHealth } from './main/appHealth.js';
import type { LanguagePreference, ModelConnectionResult, ModelProfileInput, RuntimeSettingsInput, TurnAttachment, TurnRollbackReport, WorkspaceRecord, WorkspaceTrustLevel } from './shared/domain.js';
import type { AgentEvent } from './shared/protocol.js';

contextBridge.exposeInMainWorld('desktop', {
  supportsTurnAttachments: true,
  health: (): Promise<DesktopHealth> => ipcRenderer.invoke('app:health'),
  getSnapshot: () => ipcRenderer.invoke('desktop:request', { type: 'snapshot.get' }),
  createThread: (title: string, workspaceId?: string) => ipcRenderer.invoke('desktop:request', { type: 'thread.create', title, workspaceId }),
  deleteThread: (threadId: string) => ipcRenderer.invoke('desktop:request', { type: 'thread.delete', threadId }),
  setThreadPinned: (threadId: string, pinned: boolean) => ipcRenderer.invoke('desktop:request', { type: 'thread.pin', threadId, pinned }),
  setThreadModel: (threadId: string, modelProfileId?: string) =>
    ipcRenderer.invoke('desktop:request', { type: 'thread.setModel', threadId, modelProfileId }),
  startTurn: (threadId: string, text: string, modelProfileId?: string, workspaceId?: string, attachments?: TurnAttachment[]) =>
    ipcRenderer.invoke('desktop:request', { type: 'turn.start', threadId, text, modelProfileId, workspaceId, attachments }),
  cancelTurn: (threadId: string, turnId: string) => ipcRenderer.invoke('desktop:request', { type: 'turn.cancel', threadId, turnId }),
  undoTurn: (turnId: string): Promise<TurnRollbackReport> =>
    ipcRenderer.invoke('desktop:request', { type: 'turn.undo', turnId }),
  respondApproval: (approvalId: string, approved: boolean) =>
    ipcRenderer.invoke('desktop:request', { type: 'approval.respond', approvalId, approved }),
  setLanguage: (language: LanguagePreference) => ipcRenderer.invoke('desktop:request', { type: 'language.set', language }),
  updateSettings: (settings: RuntimeSettingsInput) => ipcRenderer.invoke('desktop:request', { type: 'settings.update', settings }),
  saveModelProfile: (profile: ModelProfileInput) => ipcRenderer.invoke('desktop:request', { type: 'modelProfile.save', profile }),
  deleteModelProfile: (id: string) => ipcRenderer.invoke('desktop:request', { type: 'modelProfile.delete', id }),
  testModelProfile: (profile: ModelProfileInput): Promise<ModelConnectionResult> =>
    ipcRenderer.invoke('desktop:request', { type: 'modelProfile.test', profile }),
  registerWorkspace: (path: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord> =>
    ipcRenderer.invoke('desktop:request', { type: 'workspace.register', path, trustLevel }),
  deleteWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke('desktop:request', { type: 'workspace.delete', workspaceId }),
  setWorkspaceTrust: (workspaceId: string, trustLevel: WorkspaceTrustLevel): Promise<WorkspaceRecord> =>
    ipcRenderer.invoke('desktop:request', { type: 'workspace.setTrust', workspaceId, trustLevel }),
  subscribe: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value);
    ipcRenderer.on('agent:event', wrapped);
    return () => ipcRenderer.off('agent:event', wrapped);
  },
});
