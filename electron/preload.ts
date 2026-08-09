import { contextBridge, ipcRenderer } from 'electron';

// Minimal safe surface for the RX Store desktop shell
contextBridge.exposeInMainWorld('rxDesktop', {
  isDesktop: true,
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (s: any) => void) => {
    const listener = (_e: any, s: any) => cb(s);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
