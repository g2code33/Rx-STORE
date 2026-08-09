import { app, BrowserWindow, ipcMain, protocol, net, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;

const UPDATE_OWNER = 'g2code33';
const UPDATE_REPO = 'Rx-STORE';

// Must run before app-ready: give app:// a real origin (like https) so fetch,
// localStorage, and the History API work — an opaque origin breaks all three.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function isDev() {
  return !app.isPackaged;
}

function sendToRenderer(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function initUpdater() {
  if (!app.isPackaged) return; // only real updates when packaged

  autoUpdater.autoDownload = true;          // silent self-update…
  autoUpdater.autoInstallOnAppQuit = true;  // …installed on next quit
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });

  autoUpdater.on('checking-for-update', () => sendToRenderer('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => sendToRenderer('update:status', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendToRenderer('update:status', { state: 'up-to-date', version: info.version }));
  autoUpdater.on('error', (err) => sendToRenderer('update:status', { state: 'error', message: err?.message || 'Update error' }));
  autoUpdater.on('download-progress', (p) =>
    sendToRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
  );
  autoUpdater.on('update-downloaded', (info) => sendToRenderer('update:status', { state: 'downloaded', version: info.version }));

  autoUpdater.checkForUpdates().catch(() => {});
  // Re-check hourly while the app stays open
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000).unref();
}

// Serve the bundled SPA over a privileged https-like scheme (app://) so the
// web build's absolute asset URLs and client-side router work unchanged —
// file:// would break both (the classic "blank window" bug class).
function initAppScheme() {
  const distDir = path.join(app.getAppPath(), 'dist');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let p = decodeURIComponent(url.pathname);
    if (!path.extname(p)) p = '/index.html'; // SPA fallback for client routes
    const file = path.join(distDir, p);
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'RX Store',
    icon: path.join(app.getAppPath(), 'build/icon.png'),
    show: false,
    backgroundColor: '#0F1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  if (isDev() && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadURL('app://rxstore/index.html').catch((err) => {
      console.error('[rx-store] load failed:', err);
    });
  }

  // External links open in the system browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function initIpc() {
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'dev' };
    try {
      await autoUpdater.checkForUpdates();
      return { state: 'checking' };
    } catch (e: any) {
      return { state: 'error', message: e?.message || 'Update check failed' };
    }
  });
  ipcMain.handle('update:install', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall();
  });
  ipcMain.handle('app:version', () => app.getVersion());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initAppScheme();
    initIpc();
    initUpdater();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
