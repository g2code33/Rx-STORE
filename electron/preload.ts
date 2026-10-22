import { contextBridge, ipcRenderer } from 'electron';

// Minimal safe surface for the RX Store desktop shell
contextBridge.exposeInMainWorld('rxDesktop', {
  isDesktop: true,
  appVersion: () => ipcRenderer.invoke('app:version'),
  /**
   * Open an IN-APP path ('/app/slug') in a new RX Store window. A full http(s)
   * URL is handed to the user's default browser instead — web pages never
   * render inside an RX Store window.
   */
  openWindow: (target: { path?: string; url?: string } | string) =>
    ipcRenderer.invoke('window:open', typeof target === 'string' ? { path: target } : target),
  /** Hand a URL to the operating system's default browser. */
  openInBrowser: (url: string) => ipcRenderer.invoke('window:openExternal', url),
  /**
   * Appearance: 'light' | 'dark' | 'system'. The renderer has already painted
   * <html data-theme>; this keeps the native window background, menus and
   * native dialogs in step with the user's choice.
   */
  setTheme: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('theme:set', theme),
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
  invalidateDetect: (appId?: string) => ipcRenderer.invoke('native:invalidate-detect', appId),
  downloadApp: (input: { url: string; fileName?: string; id?: string }) => ipcRenderer.invoke('native:download', input),
  /** Live controls for an in-flight download (pause/resume/cancel). */
  pauseDownload: (id: string) => ipcRenderer.invoke('download:pause', id),
  resumeDownload: (id: string) => ipcRenderer.invoke('download:resume', id),
  cancelDownload: (id: string) => ipcRenderer.invoke('download:cancel', id),
  hashFile: (filePath: string) => ipcRenderer.invoke('native:hash-file', filePath),
  installApp: (filePath: string, opts?: { replacePath?: string }) => ipcRenderer.invoke('native:install', filePath, opts),
  openApp: (target: string) => ipcRenderer.invoke('native:open', target),
  uninstallApp: (input?: { appSlug?: string; target?: string; quietTarget?: string; appImagePath?: string; platform?: 'windows' | 'linux' | 'android' | 'web' }) => ipcRenderer.invoke('native:uninstall', input),
  showNotification: (input: { title: string; body?: string }) => ipcRenderer.invoke('native:notify', input),
  onDownloadProgress: (cb: (s: any) => void) => {
    const listener = (_e: any, s: any) => cb(s);
    ipcRenderer.on('native-download:progress', listener);
    return () => ipcRenderer.removeListener('native-download:progress', listener);
  },
  // Deep links (rxstore://app/{slug}) — validated in the MAIN process before
  // anything reaches the renderer. pending: the cold-start link (once).
  getPendingDeepLink: (): Promise<string | null> => ipcRenderer.invoke('deep-link:pending'),
  onDeepLink: (cb: (payload: { url: string }) => void) => {
    const listener = (_e: any, p: any) => cb(p);
    ipcRenderer.on('deep-link', listener);
    return () => ipcRenderer.removeListener('deep-link', listener);
  },
});
