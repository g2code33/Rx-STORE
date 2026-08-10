import { app, BrowserWindow, ipcMain, protocol, net, shell, session, Notification } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chmod, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { autoUpdater, CancellationToken } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;

// AppImages cannot reliably provide a root-owned mode-4755 chrome-sandbox from
// their read-only FUSE mount. The installed .deb keeps Chromium's sandbox (its
// post-install hook fixes the required permissions); only AppImage uses this
// compatibility fallback so it starts on distributions without user namespaces.
if (process.platform === 'linux' && process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox');
}

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

let updateToken: CancellationToken | null = null;
let updateIsAvailable = false;
let updateIsPaused = false;
let updatePolicy = { autoUpdate: true, allowMetered: true };

function beginUpdateDownload() {
  if (!app.isPackaged || !updateIsAvailable || updateIsPaused || updateToken) return;
  updateToken = new CancellationToken();
  autoUpdater.downloadUpdate(updateToken).catch((err: any) => {
    if (!updateIsPaused) sendToRenderer('update:status', { state: 'error', message: err?.message || 'Update download failed' });
  }).finally(() => { updateToken = null; });
}

function initUpdater() {
  if (!app.isPackaged) return; // only real updates when packaged

  autoUpdater.autoDownload = false;         // policy + pause/resume control the transfer
  autoUpdater.autoInstallOnAppQuit = true;  // installed on next quit
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });

  autoUpdater.on('checking-for-update', () => sendToRenderer('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    updateIsAvailable = true;
    sendToRenderer('update:status', { state: 'available', version: info.version });
    // Give the renderer a moment to restore the user's Wi-Fi/mobile-data policy.
    if (updatePolicy.autoUpdate) setTimeout(() => beginUpdateDownload(), 2000);
  });
  autoUpdater.on('update-not-available', (info) => sendToRenderer('update:status', { state: 'up-to-date', version: info.version }));
  autoUpdater.on('error', (err) => sendToRenderer('update:status', { state: 'error', message: err?.message || 'Update error' }));
  autoUpdater.on('download-progress', (p) =>
    sendToRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
  );
  autoUpdater.on('update-downloaded', (info) => { updateIsAvailable = false; updateIsPaused = false; sendToRenderer('update:status', { state: 'downloaded', version: info.version }); });

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
    // Keep the visible pathname at `/` so React Router matches the Home route.
    // `/index.html` loaded the shell but matched no route, producing the exact
    // header + empty body + footer screen seen in packaged desktop builds.
    // The version query also bypasses any stale service-worker navigation cache
    // left by older releases; the renderer removes that cache after startup.
    win.loadURL(`app://rxstore/?appVersion=${encodeURIComponent(app.getVersion())}`).catch((err) => {
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

function safeFileName(value: string) {
  return path.basename(String(value || 'download')).replace(/[^a-z0-9._ -]/gi, '_').slice(0, 180) || 'download';
}

/** Download through Electron so the renderer stays responsive and can offer a real Install step. */
function downloadNative(url: string, fileName: string, id: string) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('RX Store window is unavailable');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only secure HTTPS downloads are allowed');
  return new Promise<{ path: string; fileName: string; size: number }>((resolve, reject) => {
    const ses = session.defaultSession;
    const listener = (_event: Electron.Event, item: Electron.DownloadItem) => {
      const destination = path.join(app.getPath('downloads'), safeFileName(fileName || item.getFilename()));
      item.setSavePath(destination);
      item.on('updated', (_e, state) => {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        sendToRenderer('native-download:progress', { id, state, received, total, percent: total > 0 ? Math.round(received * 100 / total) : 0 });
      });
      item.once('done', (_e, state) => {
        ses.removeListener('will-download', listener);
        if (state === 'completed') resolve({ path: destination, fileName: path.basename(destination), size: item.getReceivedBytes() });
        else reject(new Error(`Download ${state}`));
      });
    };
    ses.once('will-download', listener);
    mainWindow.webContents.downloadURL(parsed.toString());
  });
}

function initIpc() {
  ipcMain.handle('native:detect', async (_event, identity: any) => {
    try {
      if (process.platform === 'win32') {
        const executable = String(identity?.windowsExecutable || '');
        if (executable) { try { await access(executable); return { installed: true, launchTarget: executable, source: 'executable' }; } catch {} }
        const key = String(identity?.windowsUninstallKey || '').replace(/[^a-zA-Z0-9 _{}().-]/g, '');
        if (key) {
          const roots = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'];
          for (const root of roots) {
            try {
              const { stdout } = await execFileAsync('reg.exe', ['query', `${root}\\${key}`, '/v', 'DisplayVersion'], { windowsHide: true });
              const version = stdout.match(/DisplayVersion\s+REG_\w+\s+(.+)/i)?.[1]?.trim() || '';
              return { installed: true, version, launchTarget: executable || '', source: 'registry' };
            } catch {}
          }
        }
      } else if (process.platform === 'linux') {
        const packageName = String(identity?.linuxPackageName || '').replace(/[^a-zA-Z0-9+._-]/g, '');
        const executable = String(identity?.linuxExecutable || '').replace(/[^a-zA-Z0-9+._/-]/g, '');
        if (packageName) {
          try { const { stdout } = await execFileAsync('dpkg-query', ['-W', '-f=${Version}', packageName]); return { installed: true, version: stdout.trim(), launchTarget: executable, source: 'package' }; } catch {}
        }
        if (executable) {
          try { const { stdout } = await execFileAsync('sh', ['-lc', `command -v -- "${executable}"`]); if (stdout.trim()) return { installed: true, launchTarget: stdout.trim(), source: 'executable' }; } catch {}
        }
      }
    } catch {}
    return { installed: false };
  });
  ipcMain.handle('native:download', async (_event, input: { url: string; fileName?: string; id?: string }) =>
    downloadNative(input.url, input.fileName || 'download', input.id || 'download')
  );
  ipcMain.handle('native:install', async (_event, filePath: string) => {
    await access(filePath);
    if (/\.appimage$/i.test(filePath)) await chmod(filePath, 0o755);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return { launched: true };
  });
  ipcMain.handle('native:open', async (_event, target: string) => {
    if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return true; }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('native:uninstall', async () => {
    if (process.platform === 'win32') await shell.openExternal('ms-settings:appsfeatures');
    else {
      const candidates = ['/usr/bin/gnome-software', '/usr/bin/plasma-discover'];
      const manager = candidates.find((candidate) => { try { require('node:fs').accessSync(candidate); return true; } catch { return false; } });
      if (manager) await shell.openPath(manager);
      else await shell.openExternal('https://help.ubuntu.com/community/InstallingSoftware');
    }
    return true;
  });
  ipcMain.handle('native:notify', (_event, input: { title: string; body?: string }) => {
    if (Notification.isSupported()) new Notification({ title: input.title || 'RX Store', body: input.body || '', icon: path.join(app.getAppPath(), 'build/icon.png') }).show();
    return true;
  });
  ipcMain.handle('update:policy', (_event, policy: { autoUpdate?: boolean; allowMetered?: boolean; isMetered?: boolean }) => {
    updatePolicy = { autoUpdate: policy.autoUpdate !== false, allowMetered: policy.allowMetered !== false };
    const mayDownload = updatePolicy.autoUpdate && (updatePolicy.allowMetered || !policy.isMetered);
    if (mayDownload) { updateIsPaused = false; beginUpdateDownload(); }
    else if (updateToken) { updateIsPaused = true; updateToken.cancel(); sendToRenderer('update:status', { state: 'paused' }); }
    return { mayDownload };
  });
  ipcMain.handle('update:pause', () => {
    updateIsPaused = true;
    if (updateToken) updateToken.cancel();
    sendToRenderer('update:status', { state: 'paused' });
    return true;
  });
  ipcMain.handle('update:resume', () => {
    updateIsPaused = false; setTimeout(() => beginUpdateDownload(), 250);
    sendToRenderer('update:status', { state: 'downloading', percent: 0 });
    return true;
  });
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
    // Windows: stable AppUserModelID → the taskbar icon groups with shortcuts
    // and toasts/notifications carry the app's identity instead of Electron's.
    app.setAppUserModelId('com.calcitonin.rxstore');
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
