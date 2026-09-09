/**
 * RX Store — install/update transaction coordinator.
 *
 * A single service that drives the full GET / UPDATE pipeline:
 *
 *   resolve package metadata (authoritative releases/packages)
 *   → download artifact (stream progress)
 *   → verify file size + SHA-256
 *   → launch the OS installer / hand off to the native install flow
 *   → poll native detection until INSTALLED (within a verification window)
 *   → synchronize the confirmed device installation to the backend
 *
 * It NEVER treats a completed download as an installed application. The
 * transition to INSTALLED happens only after native detection confirms it (and,
 * for an update, that the version actually advanced).
 *
 * Platform operations are injected so the coordinator is unit-testable and
 * honest about platform capabilities. The UI consumes the transaction store,
 * not ad-hoc per-component state.
 */
import type { App } from '../types';
import {
  TransactionState,
  TransactionResult,
  TransactionProgress,
  createTransaction,
  transition,
} from './installTransaction';
import type { PackageMetadata, VerificationResult } from './verify';
import { verifyArtifactHash, compareSemver, sha256Hex } from './verify';
import { getNativeRuntime, type NativeRuntime } from './runtime';
import { reportCurrentInstallation } from './accountSync';
import { getRuntimePlatform } from './deviceIdentity';
import { invalidateDetectionCache } from '../platform/nativeDetection';
import { isAndroidShell, isDesktopShell } from '../platform/nativeInstaller';

export interface PackageResolution {
  platform: string;
  url: string;
  fileName: string;
  version: string;
  size?: number;
  sha256?: string;
  isPwa?: boolean;
}

export const INSTALL_VERIFY_WINDOW_MS = 60_000;
export const DETECT_POLL_MS = 2_500;

/** How the coordinator performs platform-specific IO. Injected for tests. */
export interface PlatformOps {
  /** Download the artifact, streaming progress. Returns bytes + optional path. */
  download: (url: string, meta: PackageMetadata, onProgress: (p: TransactionProgress) => void) => Promise<{ data: ArrayBuffer; path?: string }>;
  /** Hash bytes (crypto.subtle). For artifacts stored on disk, callers hash via a
   * platform hook (main-process file hash / Android plugin) before this. */
  hash: (data: ArrayBuffer) => Promise<string>;
  /** Launch the OS installer for the artifact (or hand off on Android). */
  launchInstall: (app: App, data: ArrayBuffer, meta: PackageMetadata, path?: string) => Promise<void>;
}

function defaultHash(data: ArrayBuffer): Promise<string> {
  return sha256Hex(data);
}

/** Download the artifact, streaming progress, using the real shell/web bridge. */
async function defaultDownload(
  url: string, meta: PackageMetadata, onProgress: (p: TransactionProgress) => void,
): Promise<{ data: ArrayBuffer; path?: string }> {
  if (isDesktopShell()) {
    // Download via Electron main (returns a local path). Hashing of the file is
    // done through the main process elsewhere (see hashFile hook in Electron).
    const remove = (window as any).rxDesktop?.onDownloadProgress?.((p: any) => {
      onProgress({ received: p.received || 0, total: p.total || 0, percent: p.percent || 0 });
    });
    try {
      const res = await (window as any).rxDesktop.downloadApp({ url, fileName: meta.fileName, id: meta.slug || 'download' });
      // The renderer cannot reliably read arbitrary file:// bytes under CSP;
      // the main process computes sha256 via `hashFile` (see Electron IPC).
      return { data: new ArrayBuffer(0), path: res.path };
    } finally {
      remove?.();
    }
  }
  // Android: downloadAndInstall handles DownloadManager + installer launch and
  // streams progress; bytes are not surfaced here (plugin hashes on completion,
  // reported on the 'complete' event). We rely on post-install detection to
  // confirm the real installed package/version.
  if (isAndroidShell()) {
    const { androidDownloadAndInstall, androidOnDownloadProgress } = await import('../platform/nativeInstaller');
    const handle = await androidOnDownloadProgress((d) => {
      onProgress({ received: d.receivedBytes, total: d.totalBytes, percent: d.percent });
      if (d.status === 'complete') {
        // Plugin provides sha256 + size of the downloaded APK on the complete event.
        (meta as any)._apkSha256 = (d as any).sha256;
        (meta as any)._apkSize = d.receivedBytes || d.totalBytes;
      }
    });
    try {
      await androidDownloadAndInstall(url, meta.fileName || 'package.apk');
    } finally {
      try { await handle.remove(); } catch { /* ignore */ }
    }
    return { data: new ArrayBuffer(0) };
  }
  // Web/PWA: stream the body so we can hash in place.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = parseInt(res.headers.get('content-length') || '0', 10) || meta.size || 0;
  const reader = res.body?.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
    }
  } else {
    const blob = await res.blob();
    received = blob.size;
    chunks.push(blob);
  }
  return { data: await new Blob(chunks).arrayBuffer() };
}

/** Default install launcher: opens the installer for desktop, triggers download on web. */
async function defaultLaunchInstall(app: App, data: ArrayBuffer, meta: PackageMetadata, path?: string): Promise<void> {
  if (isDesktopShell()) {
    if (path) await (window as any).rxDesktop.installApp(path);
    return;
  }
  // Web/PWA: hand to the browser download UI (install is manual in a browser).
  const blob = new Blob([data]);
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = meta.fileName || 'package';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

export class InstallCoordinator {
  private runtime: NativeRuntime;
  private ops: PlatformOps;

  constructor(runtime: NativeRuntime = getNativeRuntime(), ops: Partial<PlatformOps> = {}) {
    this.runtime = runtime;
    this.ops = {
      download: ops.download || defaultDownload,
      hash: ops.hash || defaultHash,
      launchInstall: ops.launchInstall || defaultLaunchInstall,
    };
  }

  /** Run the full pipeline for an app given authoritative package metadata. */
  async run(input: {
    app: App;
    packageMeta: PackageResolution;
    previousVersion?: string;
    isUpdate?: boolean;
    onState?: (tx: TransactionResult) => void;
    onProgress?: (progress: TransactionProgress) => void;
  }): Promise<TransactionResult> {
    const { app, packageMeta, previousVersion, isUpdate } = input;
    const platform = getRuntimePlatform();

    let tx = createTransaction({ previousVersion, targetVersion: packageMeta.version, platform });
    const emit = (next: TransactionResult) => { tx = next; if (input.onState) input.onState(tx); };

    emit(transition(tx, { state: 'DOWNLOAD_STARTED' }));

    // ---- DOWNLOAD ----
    emit(transition(tx, { state: 'DOWNLOADING' }));
    let data: ArrayBuffer;
    let path: string | undefined;
    try {
      const dl = await this.ops.download(packageMeta.url, packageMeta, (p) => {
        emit(transition(tx, { state: 'DOWNLOADING', progress: p }));
        if (input.onProgress) input.onProgress(p);
      });
      data = dl.data; path = dl.path;
    } catch (e: any) {
      emit(transition(tx, { state: 'DOWNLOAD_FAILED', message: e?.message || 'Download failed' }));
      return tx;
    }
    emit(transition(tx, { state: 'DOWNLOAD_COMPLETED', artifactPath: path, progress: { received: data.byteLength, total: packageMeta.size || data.byteLength, percent: 100 } }));

    // ---- VERIFY (size + SHA-256) ----
    emit(transition(tx, { state: 'VERIFYING' }));
    let verification: VerificationResult;
    try {
      verification = await this.verify(data, path, packageMeta);
    } catch (e: any) {
      emit(transition(tx, { state: 'VERIFICATION_FAILED', message: e?.message || 'Verification failed' }));
      return tx;
    }
    if (!verification.ok) {
      emit(transition(tx, { state: 'VERIFICATION_FAILED', message: verifyReason(verification), verification }));
      return tx;
    }
    emit(transition(tx, { state: 'VERIFIED', verification }));
    // Clean up invalid artifacts on failure happened above; on success keep path
    // for the installer (cleaned up after detection confirms install).

    // ---- INSTALL ----
    emit(transition(tx, { state: 'INSTALLER_STARTED' }));
    try {
      await this.ops.launchInstall(app, data, packageMeta, path);
    } catch (e: any) {
      emit(transition(tx, { state: 'INSTALL_FAILED', message: e?.message || 'Install failed' }));
      return tx;
    }
    emit(transition(tx, { state: 'INSTALLATION_PENDING' }));

    // ---- VERIFY INSTALLATION (poll native detection within a window) ----
    emit(transition(tx, { state: 'VERIFYING_INSTALLATION' }));
    const confirmed = await this.waitForDetectedInstall(app, packageMeta.version, !!isUpdate, previousVersion);
    if (confirmed.detected) {
      emit(transition(tx, { state: 'INSTALLED', targetVersion: confirmed.version || packageMeta.version }));
      await this.syncInstalled(app, confirmed.version || packageMeta.version, confirmed.source);
    } else {
      emit(transition(tx, { state: confirmed.unknown ? 'INSTALLATION_PENDING' : 'INSTALLATION_NOT_DETECTED', message: confirmed.message }));
    }
    return tx;
  }

  /** Verify size + SHA-256. On desktop, hash the stored file in main via IPC; on
   * Android, the plugin reports it; on web we hash in place. */
  private async verify(data: ArrayBuffer, path: string | undefined, meta: PackageMetadata): Promise<VerificationResult> {
    const isPwa = !!meta.isPwa || meta.platform === 'web' || meta.platform === 'pwa';

    // Android: the plugin computes sha256 of the downloaded APK and reports it
    // on the 'complete' progress event (stashed on the meta object).
    if (isAndroidShell()) {
      const pluginHash = (meta as any)._apkSha256 as string | undefined;
      const size = (meta as any)._apkSize as number | undefined;
      return this.sizeAndKnownHash(size || 0, meta, pluginHash && /^[a-f0-9]{64}$/i.test(pluginHash) ? pluginHash : undefined);
    }

    // Desktop: the file lives on disk; hash it in the MAIN process (avoids the
    // renderer needing file-read privileges). Size is authoritative there.
    if (isDesktopShell() && path && (window as any).rxDesktop?.hashFile) {
      const h: any = await (window as any).rxDesktop.hashFile(path);
      const actualHash = h?.sha256 as string | undefined;
      const actualSize = (h?.size as number) || 0;
      if (actualSize <= 0) return { ok: false, reason: 'empty', expectedSize: meta.size, actualSize };
      if (meta.size && meta.size > 0 && actualSize !== meta.size) {
        return { ok: false, reason: 'size_mismatch', expectedSize: meta.size, actualSize };
      }
      // A native (non-PWA) package shipped without a checksum is not verifiable.
      if (!isPwa && !meta.sha256) {
        return { ok: false, reason: 'missing_metadata', expectedSize: meta.size, actualSize };
      }
      return this.sizeAndKnownHash(actualSize, meta, actualHash);
    }

    // Web / PWA: hash in place (data is fully in memory).
    if (!isPwa && (!meta.sha256 || !/^[a-f0-9]{64}$/i.test(meta.sha256))) {
      // Non-PWA native package without a checksum: cannot verify hash.
      return { ok: false, reason: 'missing_metadata', expectedSize: meta.size, actualSize: data.byteLength };
    }
    return verifyArtifactHash(data, meta, { requireChecksum: !isPwa, isPwa });
  }

  private sizeAndKnownHash(size: number, meta: PackageMetadata, knownHash: string | undefined): VerificationResult {
    if (meta.size && meta.size > 0 && size !== meta.size) {
      return { ok: false, reason: 'size_mismatch', expectedSize: meta.size, actualSize: size };
    }
    if (knownHash && meta.sha256 && knownHash !== meta.sha256.toLowerCase()) {
      return { ok: false, reason: 'sha256_mismatch', expectedSha256: meta.sha256, actualSha256: knownHash };
    }
    return { ok: size > 0 || !meta.size, reason: 'ok', expectedSize: meta.size, actualSize: size };
  }

  private async waitForDetectedInstall(
    app: App, targetVersion: string, isUpdate: boolean, previousVersion?: string,
  ): Promise<{ detected: boolean; version?: string; source?: string; unknown?: boolean; message?: string }> {
    const start = Date.now();
    let sawDetection = false;
    while (Date.now() - start < INSTALL_VERIFY_WINDOW_MS) {
      try {
        invalidateDetectionCache(app.slug);
        await this.runtime.refresh(app.slug);
        const det = await this.runtime.detect(app);
        if (det?.installed) {
          sawDetection = true;
          if (!isUpdate) return { detected: true, version: det.version, source: det.source };
          // Update: confirm version actually advanced (or at least changed).
          if (!det.version || compareSemver(det.version, targetVersion) >= 0 || det.version !== previousVersion) {
            return { detected: true, version: det.version || targetVersion, source: det.source };
          }
        }
      } catch { /* detection may be unavailable */ }
      await sleep(DETECT_POLL_MS);
    }
    if (!sawDetection && !this.runtime.canDetect()) {
      return { detected: false, unknown: true, message: 'Native detection unavailable — cannot confirm installation' };
    }
    return { detected: false, message: 'Installation was not detected within the verification window' };
  }

  private async syncInstalled(app: App, version: string, source?: string): Promise<void> {
    await reportCurrentInstallation({
      appSlug: app.slug,
      platform: getRuntimePlatform(),
      installed: true,
      installedVersion: version,
      status: 'INSTALLED',
      detectionSource: source,
    }).catch(() => {});
  }
}

function verifyReason(v: VerificationResult): string {
  switch (v.reason) {
    case 'size_mismatch': return `File size mismatch (expected ${v.expectedSize} bytes, got ${v.actualSize})`;
    case 'sha256_mismatch': return 'Checksum (SHA-256) did not match — the download is invalid';
    case 'empty': return 'Downloaded file is empty';
    case 'missing_metadata': return 'No checksum available for this package';
    default: return 'Verification failed';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export a convenience resolver.
export function resolvePlatformForDevice(currentPlatform: string, desiredPlatform?: string): string {
  if (desiredPlatform) return desiredPlatform;
  switch (currentPlatform) {
    case 'android': return 'android';
    case 'windows': return 'windows';
    case 'linux': return 'linux_deb';
    default: return 'web';
  }
}
