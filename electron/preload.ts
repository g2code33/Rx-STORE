import { contextBridge, ipcRenderer } from 'electron';

// Minimal safe surface for the RX Store desktop shell
contextBridge.exposeInMainWorld('rxDesktop', {
  isDesktop: true,
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setUpdatePolicy: (policy: any) => ipcRenderer.invoke('update:policy', policy),
  pauseUpdate: () => ipcRenderer.invoke('update:pause'),
  resumeUpdate: () => ipcRenderer.invoke('update:resume'),
  onUpdateStatus: (cb: (s: any) => void) => {
    const listener = (_e: any, s: any) => cb(s);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  detectApp: (identity: any) => ipcRenderer.invoke('native:detect', identity),
  downloadApp: (input: { url: string; fileName?: string; id?: string }) => ipcRenderer.invoke('native:download', input),
  installApp: (filePath: string) => ipcRenderer.invoke('native:install', filePath),
  openApp: (target: string) => ipcRenderer.invoke('native:open', target),
  uninstallApp: () => ipcRenderer.invoke('native:uninstall'),
  showNotification: (input: { title: string; body?: string }) => ipcRenderer.invoke('native:notify', input),
  onDownloadProgress: (cb: (s: any) => void) => {
    const listener = (_e: any, s: any) => cb(s);
    ipcRenderer.on('native-download:progress', listener);
    return () => ipcRenderer.removeListener('native-download:progress', listener);
  },
});
