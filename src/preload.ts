import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  health: () => ipcRenderer.invoke('app:health'),
});
