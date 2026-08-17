import { contextBridge, ipcRenderer } from 'electron';
import type { LanguagePreference, ModelProfileInput, RuntimeSettingsInput } from './shared/domain.js';
import type { AgentEvent } from './shared/protocol.js';

contextBridge.exposeInMainWorld('desktop', {
  health: () => ipcRenderer.invoke('app:health'),
  getSnapshot: () => ipcRenderer.invoke('desktop:request', { type: 'snapshot.get' }),
  createGroup: (name: string) => ipcRenderer.invoke('desktop:request', { type: 'group.create', name }),
  deleteGroup: (groupId: string) => ipcRenderer.invoke('desktop:request', { type: 'group.delete', groupId }),
  createThread: (title: string, groupId?: string) => ipcRenderer.invoke('desktop:request', { type: 'thread.create', title, groupId }),
  deleteThread: (threadId: string) => ipcRenderer.invoke('desktop:request', { type: 'thread.delete', threadId }),
  setThreadModel: (threadId: string, modelProfileId?: string) =>
    ipcRenderer.invoke('desktop:request', { type: 'thread.setModel', threadId, modelProfileId }),
  startTurn: (threadId: string, text: string, modelProfileId?: string) =>
    ipcRenderer.invoke('desktop:request', { type: 'turn.start', threadId, text, modelProfileId }),
  cancelTurn: (threadId: string, turnId: string) => ipcRenderer.invoke('desktop:request', { type: 'turn.cancel', threadId, turnId }),
  respondApproval: (approvalId: string, approved: boolean) =>
    ipcRenderer.invoke('desktop:request', { type: 'approval.respond', approvalId, approved }),
  setLanguage: (language: LanguagePreference) => ipcRenderer.invoke('desktop:request', { type: 'language.set', language }),
  updateSettings: (settings: RuntimeSettingsInput) => ipcRenderer.invoke('desktop:request', { type: 'settings.update', settings }),
  saveModelProfile: (profile: ModelProfileInput) => ipcRenderer.invoke('desktop:request', { type: 'modelProfile.save', profile }),
  deleteModelProfile: (id: string) => ipcRenderer.invoke('desktop:request', { type: 'modelProfile.delete', id }),
  testModelProfile: (profile: ModelProfileInput) => ipcRenderer.invoke('desktop:request', { type: 'modelProfile.test', profile }),
  subscribe: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value);
    ipcRenderer.on('agent:event', wrapped);
    return () => ipcRenderer.off('agent:event', wrapped);
  },
});
