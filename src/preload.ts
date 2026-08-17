import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from './shared/protocol.js';

contextBridge.exposeInMainWorld('desktop', {
  health: () => ipcRenderer.invoke('app:health'),
  getSnapshot: () => ipcRenderer.invoke('desktop:request', { type: 'snapshot.get' }),
  createThread: (title: string) => ipcRenderer.invoke('desktop:request', { type: 'thread.create', title }),
  startTurn: (threadId: string, text: string) => ipcRenderer.invoke('desktop:request', { type: 'turn.start', threadId, text }),
  respondApproval: (approvalId: string, approved: boolean) =>
    ipcRenderer.invoke('desktop:request', { type: 'approval.respond', approvalId, approved }),
  subscribe: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value);
    ipcRenderer.on('agent:event', wrapped);
    return () => ipcRenderer.off('agent:event', wrapped);
  },
});
