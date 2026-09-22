/**
 * RX Store — real installation queue (Phase 16).
 *
 * Drives multi-app installs through the EXISTING InstallCoordinator pipeline
 * (resolve authoritative package → download → verify SHA-256 → install →
 * native detection → backend sync). The queue itself NEVER writes an
 * installation record — the coordinator's detection-confirmed sync is the only
 * writer, so records can never be corrupted by queue state.
 *
 * Semantics:
 *   - Sequential processing (one install pipeline at a time).
 *   - Item states: queued → downloading → verifying → installing →
 *     installed | failed | cancelled.
 *   - Failure is IDENTIFIED (stage + message: download / verify / install /
 *     detection / resolve / offline / interrupted) and retryable.
 *   - Cancel while `queued` fully removes the item from processing. Cancel
 *     while running marks it cancelled and discards the pipeline outcome —
 *     if the OS installer already opened, native detection remains the source
 *     of truth and the app will show its REAL state after a refresh (the
 *     coordinator's own sync also reflects reality; nothing is faked).
 *   - Queue state persists to localStorage. On rehydrate, non-terminal items
 *     become `failed(interrupted)` — never silently "installed" — and the
 *     underlying attempt is reconciled by the existing transactionRecovery.
 *   - OFFLINE: processing pauses while the connection is down (items stay
 *     queued with an honest indicator); it resumes automatically when the
 *     connection returns. No false server state is displayed.
 */

import type { App } from '../types/index.ts';
import { InstallCoordinator, resolvePlatformForDevice, type PackageResolution } from './installCoordinator.ts';
import { getRuntimePlatform } from './deviceIdentity.ts';
import { isOnline, subscribeConnectivity } from './connectivity.ts';
import { log, recordMetric } from './logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueItemState = 'queued' | 'downloading' | 'verifying' | 'installing' | 'installed' | 'failed' | 'cancelled';

export type FailureStage = 'download' | 'verify' | 'install' | 'detect' | 'resolve' | 'offline' | 'interrupted' | 'unknown';

export interface QueueItem {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  gradient?: string;
  version?: string;
  state: QueueItemState;
  /** Download progress 0-100 (downloading only). */
  progress?: number;
  /** Failure identification (failed items). */
  error?: string;
  errorStage?: FailureStage;
  isUpdate?: boolean;
  addedAt: number;
  updatedAt: number;
}

/** A minimal app descriptor the queue accepts (App or a trimmed shape). */
export interface QueueAppInput {
  slug: string;
  name: string;
  icon?: string;
  gradient?: string;
  version?: string;
}

/** Injected pipeline for tests. Maps the queue item through one install. */
export interface QueueRunner {
  run(input: {
    slug: string;
    name: string;
    onState: (state: QueueItemState, patch?: Partial<QueueItem>) => void;
    onProgress: (percent: number) => void;
    cancelRequested: () => boolean;
  }): Promise<{ ok: boolean; state: QueueItemState; error?: string; errorStage?: FailureStage; version?: string }>;
}

const STORAGE_KEY = 'rx-install-queue-v1';
const TERMINAL: QueueItemState[] = ['installed', 'failed', 'cancelled'];
const ACTIVE: QueueItemState[] = ['queued', 'downloading', 'verifying', 'installing'];

// ---------------------------------------------------------------------------
// Persistence (localStorage, best-effort)
// ---------------------------------------------------------------------------

function persistItems(items: QueueItem[]) {
  try {
    // Persist only items a reload can meaningfully restore: queued + failed
    // (running states can't survive a reload — they become failed:interrupted
    // on rehydrate; installed items are proven by native detection).
    const persistable = items
      .filter((i) => i.state === 'queued' || i.state === 'failed')
      .slice(0, 50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: persistable }));
  } catch { /* storage unavailable */ }
}

function loadItems(): QueueItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) return [];
    return parsed.items
      .filter((i: any) => i && typeof i.slug === 'string' && typeof i.state === 'string' && i.state !== 'installed')
      .map((i: any) => {
        // A persisted mid-run state (downloading/verifying/installing) cannot
        // survive a reload — it becomes a retryable failed(interrupted) item,
        // NEVER "installed". The underlying attempt is reconciled by
        // transactionRecovery on next detection.
        const state = String(i.state);
        const wasMidRun = !['queued', 'failed', 'cancelled'].includes(state);
        return {
          id: String(i.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          slug: String(i.slug), name: String(i.name || i.slug), icon: i.icon, gradient: i.gradient,
          version: i.version,
          state: state === 'queued' || state === 'cancelled' ? state : 'failed',
          progress: undefined,
          error: wasMidRun ? 'Interrupted — RX Store closed during this step. Retry to continue.' : i.error,
          errorStage: wasMidRun ? 'interrupted' : i.errorStage,
          isUpdate: !!i.isUpdate, addedAt: Number(i.addedAt) || Date.now(), updatedAt: Number(i.updatedAt) || Date.now(),
        };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Default runner — the REAL pipeline (authoritative package resolution +
// InstallCoordinator: download → verify → install → detect → sync)
// ---------------------------------------------------------------------------

function mapTxStateToQueue(txState: string): { state: QueueItemState; progress?: number } | null {
  switch (txState) {
    case 'DOWNLOAD_STARTED':
    case 'DOWNLOADING': return { state: 'downloading' };
    case 'DOWNLOAD_COMPLETED':
    case 'VERIFYING':
    case 'VERIFIED': return { state: 'verifying' };
    case 'INSTALLER_STARTED':
    case 'INSTALLATION_PENDING':
    case 'VERIFYING_INSTALLATION': return { state: 'installing' };
    case 'INSTALLED': return { state: 'installed' };
    case 'DOWNLOAD_FAILED': return { state: 'failed', } as any;
    case 'VERIFICATION_FAILED': return { state: 'failed' } as any;
    case 'INSTALL_FAILED': return { state: 'failed' } as any;
    case 'INSTALLATION_NOT_DETECTED': return { state: 'failed' } as any;
    default: return null;
  }
}

function stageForFailure(txState: string): FailureStage {
  switch (txState) {
    case 'DOWNLOAD_FAILED': return 'download';
    case 'VERIFICATION_FAILED': return 'verify';
    case 'INSTALL_FAILED': return 'install';
    case 'INSTALLATION_NOT_DETECTED': return 'detect';
    default: return 'unknown';
  }
}

async function defaultRun(input: Parameters<QueueRunner['run']>[0]): ReturnType<QueueRunner['run']> {
  const API_URL = (import.meta as any).env?.VITE_API_URL?.replace(/\/$/, '') || '';
  if (!API_URL) {
    return { ok: false, state: 'failed', error: 'RX Store is not connected to its application service.', errorStage: 'resolve' };
  }
  if (!isOnline()) {
    return { ok: false, state: 'failed', error: 'You are offline — reconnect and retry.', errorStage: 'offline' };
  }

  // Authoritative package metadata from the backend.
  let data: any;
  try {
    const token = (() => { try { return localStorage.getItem('rx-store-token') || ''; } catch { return ''; } })();
    const res = await fetch(`${API_URL}/apps/${encodeURIComponent(input.slug)}/download?platform=${encodeURIComponent(resolvePlatformForDevice(getRuntimePlatform()))}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.success) {
      return { ok: false, state: 'failed', error: j?.error?.message || `Could not resolve a package for this app (${res.status}).`, errorStage: 'resolve' };
    }
    data = j?.data || {};
  } catch (e: any) {
    return { ok: false, state: 'failed', error: isOnline() ? (e?.message || 'Package lookup failed.') : 'You are offline — reconnect and retry.', errorStage: isOnline() ? 'resolve' : 'offline' };
  }

  if (data.isPWA && data.url) {
    // PWA: open the deployment URL — nothing to download or verify.
    try { window.open(data.url, '_blank'); } catch { /* popup blocked */ }
    return { ok: true, state: 'installed', version: data.version };
  }

  const pkg: PackageResolution = {
    platform: resolvePlatformForDevice(getRuntimePlatform(), data.platform),
    url: data.url,
    fileName: data.fileName || `${input.slug}-${data.version || 'latest'}`,
    version: data.version,
    size: data.size,
    sha256: data.checksum || data.sha256,
    isPwa: !!data.isPWA,
  };

  const coordinator = new InstallCoordinator();
  const appLike = { slug: input.slug, name: input.name } as unknown as App;
  const tx = await coordinator.run({
    app: appLike,
    packageMeta: pkg,
    onState: (t) => {
      if (input.cancelRequested()) return;
      const mapped = mapTxStateToQueue(t.state);
      if (mapped && mapped.state !== 'failed') input.onState(mapped.state, { version: t.targetVersion || pkg.version });
    },
    onProgress: (p) => {
      if (input.cancelRequested()) return;
      input.onProgress(Math.max(0, Math.min(100, Math.round(p.percent ?? 0))));
    },
  });

  if (input.cancelRequested()) {
    return { ok: false, state: 'cancelled' };
  }
  if (tx.state === 'INSTALLED') {
    return { ok: true, state: 'installed', version: tx.targetVersion || pkg.version };
  }
  return {
    ok: false,
    state: 'failed',
    error: tx.message || describeFailure(tx.state),
    errorStage: stageForFailure(tx.state),
  };
}

function describeFailure(txState: string): string {
  switch (txState) {
    case 'DOWNLOAD_FAILED': return 'The download failed — check your connection and retry.';
    case 'VERIFICATION_FAILED': return 'Checksum verification failed — the download was discarded.';
    case 'INSTALL_FAILED': return 'The installer could not be launched.';
    case 'INSTALLATION_NOT_DETECTED': return 'Installation was not detected. If it succeeded, retry to re-check.';
    default: return 'The installation did not complete.';
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

class InstallQueue {
  private items: QueueItem[] = [];
  private listeners = new Set<() => void>();
  private runner: QueueRunner;
  private processing = false;
  private started = false;
  private currentId: string | null = null;
  private cancelledIds = new Set<string>();

  constructor(runner?: QueueRunner) {
    this.runner = runner || { run: defaultRun };
    this.items = loadItems();
    // Any persisted item that was mid-run can't be resumed in place — mark it
    // interrupted (retryable). The underlying attempt is reconciled by the
    // existing transactionRecovery on next detection.
    const now = Date.now();
    let changed = false;
    for (const item of this.items) {
      if (ACTIVE.includes(item.state) && item.state !== 'queued') {
        item.state = 'failed';
        item.errorStage = 'interrupted';
        item.error = 'Interrupted — RX Store closed during this step. Retry to continue.';
        item.updatedAt = now;
        changed = true;
      }
    }
    if (changed) persistItems(this.items);
  }

  // ---- external store API ----
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): QueueItem[] => this.items;

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Begin processing + connectivity-driven resume (idempotent). */
  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    subscribeConnectivity(() => {
      // Connection returned: resume processing queued items.
      if (isOnline()) void this.processNext();
    });
    void this.processNext();
  }

  // ---- public operations ----

  enqueue(app: QueueAppInput, opts?: { isUpdate?: boolean }): string | null {
    const existing = this.items.find((i) => i.slug === app.slug && [...ACTIVE, 'installed'].includes(i.state));
    if (existing && ACTIVE.includes(existing.state)) return null; // already queued/running
    if (existing && existing.state === 'installed') return null; // just completed
    const item: QueueItem = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      slug: app.slug, name: app.name, icon: app.icon, gradient: app.gradient,
      version: app.version, state: 'queued', isUpdate: opts?.isUpdate,
      addedAt: Date.now(), updatedAt: Date.now(),
    };
    this.items = [...this.items, item];
    persistItems(this.items);
    log.info('queue_enqueued', `Queued install for ${app.slug}`, { appSlug: app.slug });
    this.emit();
    this.ensureStarted();
    void this.processNext(); // enqueue always kicks processing (subscribe may already be bound)
    return item.id;
  }

  cancel(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    if (item.state === 'queued') {
      this.update(id, { state: 'cancelled' });
      return true;
    }
    if (['downloading', 'verifying', 'installing'].includes(item.state)) {
      // Mark cancelled; the running pipeline's outcome is discarded. Native
      // detection stays the source of truth for the app's real state.
      this.cancelledIds.add(id);
      this.update(id, { state: 'cancelled', error: undefined, errorStage: undefined, progress: undefined });
      recordMetric('queue_cancelled');
      return true;
    }
    return false;
  }

  retry(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || !['failed', 'cancelled'].includes(item.state)) return false;
    this.cancelledIds.delete(id);
    this.update(id, { state: 'queued', error: undefined, errorStage: undefined, progress: undefined });
    void this.processNext();
    return true;
  }

  /** Remove terminal items (installed / failed / cancelled). */
  clearFinished(): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => !TERMINAL.includes(i.state));
    persistItems(this.items);
    this.emit();
    return before - this.items.length;
  }

  isBusy(): boolean {
    return this.items.some((i) => ['downloading', 'verifying', 'installing'].includes(i.state));
  }

  // ---- internals ----

  private update(id: string, patch: Partial<QueueItem>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i));
    persistItems(this.items);
    this.emit();
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (!isOnline()) return; // offline: items stay queued (honest state)
    const next = this.items.find((i) => i.state === 'queued');
    if (!next) return;

    this.processing = true;
    this.currentId = next.id;
    this.update(next.id, { state: 'downloading', progress: 0 });

    try {
      const result = await this.runner.run({
        slug: next.slug,
        name: next.name,
        onState: (state, patch) => {
          if (this.cancelledIds.has(next.id)) return;
          if (state === 'installed') return; // handled by the final result
          // Preserve download progress when moving within downloading; clear on stage change.
          const prev = this.items.find((i) => i.id === next.id);
          const progress = state === 'downloading' ? (prev?.progress ?? 0) : undefined;
          this.update(next.id, { state, progress, ...patch });
        },
        onProgress: (percent) => {
          if (this.cancelledIds.has(next.id)) return;
          this.update(next.id, { state: 'downloading', progress: percent });
        },
        cancelRequested: () => this.cancelledIds.has(next.id),
      });

      if (this.cancelledIds.has(next.id)) {
        // The pipeline result is discarded; the item stays cancelled.
        this.cancelledIds.delete(next.id);
      } else if (result.ok && result.state === 'installed') {
        this.update(next.id, { state: 'installed', version: result.version || next.version, progress: 100, error: undefined, errorStage: undefined });
        log.info('queue_installed', `Install completed for ${next.slug}`, { appSlug: next.slug });
      } else if (result.state === 'cancelled') {
        this.update(next.id, { state: 'cancelled' });
      } else {
        this.update(next.id, { state: 'failed', error: result.error || 'The installation did not complete.', errorStage: result.errorStage || 'unknown', progress: undefined });
        recordMetric('queue_failure');
        log.warn('queue_failure', `Install failed for ${next.slug}`, { appSlug: next.slug, stage: result.errorStage });
      }
    } catch (e: any) {
      if (!this.cancelledIds.has(next.id)) {
        this.update(next.id, { state: 'failed', error: e?.message || 'Unexpected installation error.', errorStage: 'unknown' });
      }
    } finally {
      this.currentId = null;
      this.processing = false;
      // Continue with the next queued item (also handles a resumed connection).
      void this.processNext();
    }
  }
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

let singleton: InstallQueue | null = null;
/** Test seam: replace the queue instance. */
export function __setInstallQueueForTests(q: InstallQueue | null) { singleton = q; }
export function getInstallQueue(): InstallQueue {
  if (!singleton) singleton = new InstallQueue();
  return singleton;
}
export function createInstallQueueForTests(runner: QueueRunner): InstallQueue {
  return new InstallQueue(runner);
}

import { useSyncExternalStore } from 'react';

export function useInstallQueue(): { items: QueueItem[]; busy: boolean } {
  const queue = getInstallQueue();
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { items, busy: queue.isBusy() };
}
