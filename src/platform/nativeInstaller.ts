import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AndroidDownloadProgress {
  status: 'downloading' | 'complete' | 'error';
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  fileUri?: string;
  error?: string;
}

interface AndroidInstallerPlugin {
  getNetworkStatus(): Promise<{ connected: boolean; metered: boolean }>;
  getHostVersion(): Promise<{ version: string }>;
  isInstalled(input: { packageId: string }): Promise<{ installed: boolean; version?: string }>;
  openInstalled(input: { packageId: string }): Promise<void>;
  uninstallInstalled(input: { packageId: string }): Promise<void>;
  downloadAndInstall(input: { url: string; fileName: string }): Promise<{ started?: boolean; permissionRequired?: boolean }>;
  openAppSettings(): Promise<void>;
  addListener(eventName: 'downloadProgress', listener: (data: AndroidDownloadProgress) => void): Promise<{ remove: () => void }>;
}
const AndroidInstaller = registerPlugin<AndroidInstallerPlugin>('AppInstaller');

export type NativePackageState = {
  slug: string;
  phase: 'downloaded' | 'installed';
  filePath: string;
  fileName: string;
  version: string;
  launchTarget?: string;
};

const KEY = 'rx-native-packages';

function read(): Record<string, NativePackageState> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export const isDesktopShell = () => typeof window !== 'undefined' && !!window.rxDesktop?.isDesktop;
export const isAndroidShell = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export async function androidDownloadAndInstall(url: string, fileName: string) {
  return AndroidInstaller.downloadAndInstall({ url, fileName });
}
export const androidNetworkStatus = () => AndroidInstaller.getNetworkStatus();
export const androidHostVersion = () => AndroidInstaller.getHostVersion();
export const androidIsInstalled = (packageId: string) => AndroidInstaller.isInstalled({ packageId });
export const androidOpen = (packageId: string) => AndroidInstaller.openInstalled({ packageId });
export const androidUninstall = (packageId: string) => AndroidInstaller.uninstallInstalled({ packageId });
/** Live download progress from the Android DownloadManager (in-page progress bar). */
export const androidOnDownloadProgress = (cb: (d: AndroidDownloadProgress) => void) =>
  AndroidInstaller.addListener('downloadProgress', cb);
export const androidStopDownloadProgress = (handle: { remove: () => void } | null) => {
  try { handle?.remove?.(); } catch { /* ignore */ }
};

export interface DesktopDetectionResult {
  installed: boolean;
  version?: string;
  launchTarget?: string;
  executable?: string;
  source?: string;
  platform?: 'windows' | 'linux';
}

export async function desktopDetect(identity: any) {
  if (!window.rxDesktop) return { installed: false };
  // Include appId so the main process can cache per-app detection results.
  return window.rxDesktop.detectApp({ ...identity, appId: identity?.appId || identity?.slug });
}
export async function desktopInvalidateDetect(appId?: string) {
  if (window.rxDesktop?.invalidateDetect) await window.rxDesktop.invalidateDetect(appId);
}
export const getNativePackage = (slug: string) => read()[slug] || null;

export function saveNativePackage(state: NativePackageState) {
  const all = read(); all[state.slug] = state;
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent('rx-native-package-change', { detail: state }));
}

export function removeNativePackage(slug: string) {
  const all = read(); delete all[slug]; localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent('rx-native-package-change', { detail: { slug } }));
}

export async function desktopDownload(input: { slug: string; url: string; fileName: string; version: string; launchTarget?: string }) {
  if (!window.rxDesktop) throw new Error('Desktop installer is unavailable');
  const result = await window.rxDesktop.downloadApp({ url: input.url, fileName: input.fileName, id: input.slug });
  const state: NativePackageState = { ...input, phase: 'downloaded', filePath: result.path, fileName: result.fileName };
  saveNativePackage(state);
  return state;
}

export async function desktopInstall(state: NativePackageState) {
  if (!window.rxDesktop) throw new Error('Desktop installer is unavailable');
  await window.rxDesktop.installApp(state.filePath);
  return state;
}

export function confirmDesktopInstalled(state: NativePackageState) {
  const installed = { ...state, phase: 'installed' as const };
  saveNativePackage(installed);
  return installed;
}

export async function desktopOpen(state: NativePackageState) {
  if (!window.rxDesktop) throw new Error('Desktop launcher is unavailable');
  if (!state.launchTarget) throw new Error('The publisher has not configured an Open target for this app yet');
  await window.rxDesktop.openApp(state.launchTarget);
}

export async function desktopUninstall() {
  if (!window.rxDesktop) throw new Error('Desktop uninstaller is unavailable');
  await window.rxDesktop.uninstallApp();
}
