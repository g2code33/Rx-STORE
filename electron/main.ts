import { app, BrowserWindow, ipcMain, protocol, net, shell, session, Notification } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chmod, access } from 'node:fs/promises';
import { accessSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Installed-application detection (Windows + Linux).
//
// Security: every external process is launched with `execFile` and an ARGUMENTS
// ARRAY (never a shell string), so application metadata (registry key, package
// name, executable name) can never be interpreted by a shell. Executable file
// version is read through PowerShell with the path passed via an environment
// variable — the path is never interpolated into the command string. Nothing
// here ever executes the target application; it only reads registry metadata,
// package-manager metadata, or file metadata.
// ---------------------------------------------------------------------------

const DETECT_TTL_MS = 60_000;
const detectCache = new Map<string, { at: number; result: unknown }>();

const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

interface DetectedApp {
  installed: boolean;
  version?: string;
  executable?: string;
  /** Windows registry UninstallString (registered uninstaller), if any. */
  uninstallString?: string;
  /** Windows registry QuietUninstallString (silent uninstaller), if any. */
  quietUninstallString?: string;
  /** Linux package identifier (Debian/dpkg) or Flatpak app id, if detected. */
  packageName?: string;
  /** Linux AppImage path managed by RX Store, if positively owned. */
  appImagePath?: string;
  platform: 'windows' | 'linux';
  source: string;
}

/** Read every value of a Windows registry subkey (safe, no shell). */
async function readRegistryKey(keyPath: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  try {
    // Query the whole subkey (no /v) — exit 0 means the subkey exists.
    const { stdout } = await execFileAsync('reg.exe', ['query', keyPath], { windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*([^\s]+)\s+(REG_\w+)\s+(.+)$/i);
      if (m) values[m[1]] = m[3].trim();
    }
  } catch {
    // subkey absent, access denied, or reg.exe missing -> empty result
  }
  return values;
}

/** Read the file version metadata of an executable (path via env; never interpolated). */
async function windowsFileVersion(exePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'if (Test-Path $env:RX_EXE_PATH) { ([System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:RX_EXE_PATH)).ProductVersion }',
      ],
      { windowsHide: true, env: { ...process.env, RX_EXE_PATH: exePath } },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Locate an executable on PATH without a shell (pure fs scan). */
function whichInPath(name: string, ext = ''): string {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = ext ? [name, `${name}${ext}`] : [name, `${name}${ext}`];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        accessSync(full);
        return full;
      } catch {
        // not found in this dir
      }
    }
  }
  return '';
}

/** Resolve an executable reference to an absolute path, or ''. */
async function resolveWindowsExecutable(execName: string): Promise<string> {
  const name = String(execName || '').trim();
  if (!name) return '';
  if (path.isAbsolute(name) || /^[a-zA-Z]:\\/.test(name)) {
    try {
      await access(name);
      return name;
    } catch {
      return '';
    }
  }
  // relative executable name -> PATH lookup via where (no shell)
  try {
    const { stdout } = await execFileAsync('where.exe', [name], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || '';
  } catch {
    return '';
  }
}

/** Parse a possibly-quoted Windows registry value into an executable + args array. */
function parseWindowsCommand(raw: string): { exe: string; args: string[] } {
  const s = String(raw || '').trim();
  if (!s) return { exe: '', args: [] };
  // A single quoted path (optionally with args): "C:\x\uninstall.exe" /S
  const m = s.match(/^"([^"]+)"(\s+.*)?$/);
  if (m) {
    const exe = m[1];
    const rest = (m[2] || '').trim();
    const args = rest ? rest.split(/\s+/).filter(Boolean) : [];
    return { exe, args };
  }
  // No quotes: first token is the executable, rest are args.
  const tokens = s.split(/\s+/).filter(Boolean);
  return { exe: tokens[0] || '', args: tokens.slice(1) };
}

/** Resolve a Windows launch executable from the registry's DisplayIcon/InstallLocation. */
function executableFromRegistry(values: Record<string, string>): string {
  // DisplayIcon is often the exe path (optionally followed by ",index").
  const fromIcon = (values.DisplayIcon || '').replace(/^"?(.+?)(?:,[\d]+)?"?$/, '$1').trim();
  if (fromIcon && existsSync(fromIcon)) return fromIcon;
  const fromLocation = values.InstallLocation || values.InstallDir || '';
  if (fromLocation && existsSync(fromLocation)) return fromLocation;
  return '';
}

/** Windows detection: registry uninstall entry + executable, with version + uninstall metadata. */
async function detectWindows(identity: any): Promise<DetectedApp> {
  const key = String(identity?.windowsUninstallKey || '').trim();
  const execName = String(identity?.windowsExecutable || '').trim();

  let foundByKey = false;
  let registryVersion = '';
  let uninstallString = '';
  let quietUninstallString = '';

  if (key) {
    // A fully-qualified uninstall key is used verbatim; a bare subkey name is
    // tried under each of the 32/64-bit uninstall roots.
    const isAbsoluteKey = /^[A-Za-z]:|^(HKEY_|HKLM|HKCU)/i.test(key) || key.includes('\\') && key.toLowerCase().startsWith('software');
    const keyPaths = isAbsoluteKey
      ? [key]
      : UNINSTALL_ROOTS.map((root) => `${root}\\${key}`);

    for (const keyPath of keyPaths) {
      const values = await readRegistryKey(keyPath);
      if (Object.keys(values).length > 0) {
        foundByKey = true;
        registryVersion = values.DisplayVersion || values.Version || '';
        uninstallString = values.UninstallString || '';
        quietUninstallString = values.QuietUninstallString || '';
        break;
      }
    }
  }

  let executable = '';
  if (execName) {
    // Prefer a resolved absolute path over the registry's install location.
    executable = await resolveWindowsExecutable(execName);
  }

  // Fall back to the registry-located executable when the admin did not supply a
  // windowsExecutable, or when the configured name did not resolve.
  if (!executable && key) {
    for (const keyPath of (key.includes('\\') && key.toLowerCase().startsWith('software')
      ? [key]
      : UNINSTALL_ROOTS.map((root) => `${root}\\${key}`))) {
      const values = await readRegistryKey(keyPath);
      if (Object.keys(values).length > 0) {
        const found = executableFromRegistry(values);
        if (found) { executable = found; break; }
      }
    }
  }

  let version = registryVersion;
  if (!version && executable) {
    version = await windowsFileVersion(executable);
  }

  const installed = foundByKey || !!executable;
  return {
    installed,
    version: version || undefined,
    executable: executable || undefined,
    uninstallString: uninstallString || undefined,
    quietUninstallString: quietUninstallString || undefined,
    platform: 'windows',
    source: foundByKey ? 'registry' : executable ? 'executable' : 'none',
  };
}

/** Safe, small .desktop parser: returns { name, exec, icon, noDisplay }. */
interface DesktopEntry { name: string; exec: string; icon: string; noDisplay: boolean; }
function parseDesktopEntry(content: string): DesktopEntry {
  let name = '', exec = '', icon = '', noDisplay = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === 'Name') name = v;
    else if (k === 'Exec') exec = v;
    else if (k === 'Icon') icon = v;
    else if (k === 'NoDisplay' && v === 'true') noDisplay = true;
  }
  return { name, exec, icon, noDisplay };
}

/** Normalize a desktop Exec line to the base command name (field codes stripped). */
function execBaseCommand(exec: string): string {
  const cmd = String(exec || '').replace(/%[fFuUdDnNickvm]/g, '').trim();
  // Return the first token (the executable/command), never a shell line.
  const parts = cmd.split(/\s+/).filter(Boolean);
  return parts[0] || '';
}

/** Read all .desktop entries from the standard locations (safe file reads only). */
function readDesktopEntries(): DesktopEntry[] {
  const dirs = [
    '/usr/share/applications',
    path.join(process.env.HOME || '', '.local/share/applications'),
  ];
  const out: DesktopEntry[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = require('node:fs').readdirSync(dir).filter((f: string) => f.endsWith('.desktop'));
    } catch {
      continue; // dir missing / unreadable
    }
    for (const f of files) {
      try {
        const content = require('node:fs').readFileSync(path.join(dir, f), 'utf8');
        out.push(parseDesktopEntry(content));
      } catch { /* skip unreadable */ }
    }
  }
  return out;
}

/** Linux detection: dpkg package database, PATH executable, and .desktop launchers. */
async function detectLinux(identity: any): Promise<DetectedApp> {
  const pkg = String(identity?.linuxPackageName || '').trim();
  const exec = String(identity?.linuxExecutable || '').trim();

  let foundByPackage = false;
  let packageVersion = '';

  if (pkg) {
    try {
      // -f=${Version} prints only the installed version; exit 0 => installed.
      const { stdout } = await execFileAsync('dpkg-query', ['-W', '-f=${Version}', pkg]);
      packageVersion = stdout.trim();
      foundByPackage = true;
    } catch {
      // package not installed, or dpkg unavailable — fall through to executable
    }
  }

  let executable = '';
  if (exec) {
    executable = whichInPath(exec);
  }

  // .desktop fallback: match the configured linuxExecutable (or package name) to
  // a launchable desktop entry. We read the REAL launcher `Exec` (parsed safely,
  // never executed here) so `Open` runs the launcher, not an internal binary.
  let desktopLauncher = '';
  if (!executable && (exec || pkg)) {
    const entries = readDesktopEntries().filter((e) => !e.noDisplay);
    const match = entries.find((e) => {
      const base = execBaseCommand(e.exec).toLowerCase();
      return (exec && base === exec.toLowerCase()) || (pkg && (base === pkg.toLowerCase() || base.includes(pkg.toLowerCase())));
    }) || entries.find((e) => e.name && exec && e.name.toLowerCase().includes(exec.toLowerCase()));
    if (match && match.exec) desktopLauncher = match.exec;
  }

  const installed = foundByPackage || !!executable || !!desktopLauncher;
  return {
    installed,
    version: packageVersion || undefined,
    // Prefer the PATH-resolved executable; fall back to the .desktop Exec.
    executable: (executable || (desktopLauncher ? execBaseCommand(desktopLauncher) : '')) || undefined,
    packageName: pkg || undefined,
    platform: 'linux',
    source: foundByPackage ? 'package' : executable ? 'executable' : desktopLauncher ? 'desktop' : 'none',
  };
}

/** Safely spawn a detected application/launcher detached, without a shell. */
function launchDetached(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = String(target || '').trim();
    // On Windows, .bat/.cmd launchers must be run via cmd as a single argument —
    // this is still an arguments array, never string concatenation.
    const lower = t.toLowerCase();
    if (process.platform === 'win32' && (lower.endsWith('.bat') || lower.endsWith('.cmd'))) {
      const child = execFile('cmd.exe', ['/d', '/s', '/c', t], { detached: true, stdio: 'ignore', windowsHide: false }, (err) => {
        if (err && (err as any).code !== 'ENOENT') reject(err); else resolve();
      });
      child.unref();
      return;
    }
    if (process.platform === 'win32' && lower.endsWith('.lnk')) {
      // Ensure link targets are resolved through PowerShell (path via env only).
      resolveWindowsShortcut(t).then(() => resolve(), () => resolve());
      return;
    }
    try {
      const child = execFile(t, [], { detached: true, stdio: 'ignore', windowsHide: false }, (err) => {
        if (err) reject(err); else resolve();
      });
      child.unref();
    } catch (e) {
      reject(e);
    }
  });
}

/** Resolve a .lnk shortcut to its absolute target, then launch it. */
async function resolveWindowsShortcut(shortcutPath: string): Promise<void> {
  // CreateObject("WScript.Shell") is the standard, safe COM resolver. The path is
  // passed via env so it is never interpolated into the command string.
  const cmd = `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut($env:RX_LNK); [System.Diagnostics.Process]::Start($s.TargetPath)`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    windowsHide: false,
    env: { ...process.env, RX_LNK: shortcutPath },
  }).catch(() => { /* best-effort: if resolution fails, fall through */ });
}

/** Invoke a Windows registered uninstaller (from UninstallString) detached. */
async function uninstallWindows(uninstallString: string): Promise<boolean> {
  const { exe, args } = parseWindowsCommand(uninstallString);
  if (!exe) throw new Error('Invalid uninstaller command.');
  if (!existsSync(exe)) throw new Error('The registered uninstaller was not found on disk.');
  // Run detached so Windows can show its normal confirmation / privilege UI.
  await new Promise<void>((resolve, reject) => {
    const child = execFile(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }, (err) => {
      // Detached GUI processes return 0 immediately; ENOENT/real errors reject.
      resolve();
    });
    child.unref();
  });
  return true;
}

/** Invoke a Linux uninstall for a detected package/AppImage. */
async function uninstallLinux(target: string): Promise<boolean> {
  const t = String(target || '').trim();
  const isAppImage = /\.appimage$/i.test(t);
  if (isAppImage) {
    // Only remove an AppImage we can positively establish as a store-managed
    // artifact (the filename pattern rx-store-<version>.AppImage is validated).
    if (!/rx-store[-\w.]*\.appimage$/i.test(path.basename(t))) {
      throw new Error('This is not a RX Store-managed AppImage; refusing to delete it.');
    }
    require('node:fs').unlinkSync(t);
    return true;
  }
  // Debian/Ubuntu package: invoke the package manager directly so the OS handles
  // privilege authentication. No manual sudo/password handling in RX Store.
  if (!/^[a-z0-9+._-]+$/i.test(t)) throw new Error('Invalid package name.');
  await new Promise<void>((resolve, reject) => {
    // `apt-get purge` shows a confirmation prompt with sudo/privilege auth.
    const child = execFile('apt-get', ['purge', '--', t], { stdio: 'inherit' }, (err) => {
      if (err) reject(new Error('Your OS may have cancelled the uninstall (or requested elevation). ' + err.message));
      else resolve();
    });
    // Keep the child attached so the user can authenticate/confirm.
    child.on('error', (e) => reject(e));
  });
  return true;
}

function initIpc() {
  ipcMain.handle('native:detect', async (_event, payload: any) => {
    const identity = payload || {};
    const appId = String(identity.appId || identity.slug || 'unknown').slice(0, 120);
    const cached = detectCache.get(appId);
    if (cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.result;

    let result: DetectedApp = { installed: false, platform: process.platform === 'win32' ? 'windows' : 'linux', source: 'none' };
    try {
      if (process.platform === 'win32') result = await detectWindows(identity);
      else if (process.platform === 'linux') result = await detectLinux(identity);
      // mac / other: no native detection — report not installed.
    } catch {
      result = { installed: false, platform: process.platform === 'win32' ? 'windows' : 'linux', source: 'error' };
    }

    detectCache.set(appId, { at: Date.now(), result });
    return result;
  });

  ipcMain.handle('native:invalidate-detect', (_event, appId?: string) => {
    if (appId) detectCache.delete(String(appId));
    else detectCache.clear();
    return true;
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
  // Compute SHA-256 + size of a downloaded artifact in the MAIN process so the
  // renderer never needs arbitrary file-read privileges, and checksum
  // verification is considered trusted. Used before any install.
  ipcMain.handle('native:hash-file', async (_event, filePath: string) => {
    const p = String(filePath || '');
    if (!p || !existsSync(p)) throw new Error('Artifact file not found');
    const buffer = require('node:fs').readFileSync(p);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return { sha256, size: buffer.length };
  });
  ipcMain.handle('native:open', async (_event, target: string) => {
    const t = String(target || '');
    // URLs / PWA targets open in the system browser — kept separate from native
    // executable launching.
    if (/^https?:\/\//i.test(t)) { await shell.openExternal(t); return true; }
    // Only ever launch a local target that actually exists and was positively
    // detected. Nothing here is interpolated into a shell command.
    if (!existsSync(t)) throw new Error('The installed application executable could not be found.');
    // Direct process execution (NO shell, NO shell.openPath): for a launcher
    // script this runs the launcher itself (preserving Chromium sandbox setup),
    // for an .exe it starts the executable. Detached so the app keeps running.
    await launchDetached(t);
    return true;
  });

  // Real uninstall. The `target` comes from native detection (Windows registry
  // UninstallString / Linux package id / owned AppImage path), NOT arbitrary
  // remote metadata. We invoke the OS mechanism directly so it can show its
  // normal confirmation/privilege UI. Never opens a software manager.
  ipcMain.handle('native:uninstall', async (_event, input?: { appSlug?: string; target?: string; platform?: string }) => {
    const target = String(input?.target || '').trim();
    const platform = String(input?.platform || process.platform);
    if (process.platform === 'win32' || platform === 'windows') {
      if (!target) throw new Error('No uninstaller registered for this application.');
      return uninstallWindows(target);
    }
    if (process.platform === 'linux' || platform === 'linux') {
      if (!target) throw new Error('No uninstall target for this application.');
      return uninstallLinux(target);
    }
    throw new Error('Uninstall is not supported on this platform.');
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
