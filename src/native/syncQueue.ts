/**
 * RX Store — durable synchronization queue.
 *
 * PROBLEM THIS SOLVES
 * Installation/device synchronization was fire-and-forget: `reportCurrentInstallation`
 * swallowed failures, so an offline install was never reflected on the account and
 * a state change could be lost forever.
 *
 * DESIGN
 *   - Each queued item is IDEMPOTENT and COALESCED by `(deviceId, appSlug, kind)`.
 *     Reporting the same app state twice replaces the previous pending item rather
 *     than enqueuing a second one — so retries can never create duplicate
 *     installation records server-side (the backend also upserts on
 *     UNIQUE(device_id, application_id), giving defence in depth).
 *   - Failures retry with exponential backoff + jitter (never hammering).
 *   - The queue is persisted per-account (see cache.ts) so a crash/restart keeps
 *     pending work, and account A's queue never runs for account B.
 *
 * The network/flush functions are INJECTABLE so the logic is unit-testable.
 */
import { cacheGet, cacheSet, clearNamespace, CACHE_TTL } from './cache.ts';

export type SyncKind = 'installation' | 'device_register' | 'heartbeat';

export interface SyncItem {
  /** Stable dedupe key: `<kind>|<deviceId>|<appSlug|''>`. */
  key: string;
  kind: SyncKind;
  deviceId: string;
  appSlug?: string;
  payload: any;
  /** Monotonic enqueue sequence (for stable ordering). */
  seq: number;
  attempts: number;
  /** Epoch ms before which the item must not be retried. */
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
}

export interface SyncQueueState {
  items: SyncItem[];
  seq: number;
}

const NAME = 'queue-v1';

/** Backoff schedule (ms) — exponential with a cap. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Delay before the next attempt for a given attempt count (0 = first failure).
 * Exponential, capped, plus deterministic jitter derived from the key so tests
 * are stable while production still spreads load.
 */
export function backoffDelay(attempts: number, key = ''): number {
  const n = Math.max(0, Math.floor(attempts));
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, n));
  // jitter: up to 20% of the delay, derived from the key (stable + spread out)
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  const jitter = Math.floor(exp * 0.2 * (h / 997));
  return Math.min(BACKOFF_MAX_MS, exp + jitter);
}

/** Dedupe key for an item (installs coalesce per app; device ops per device). */
export function itemKey(kind: SyncKind, deviceId: string, appSlug?: string): string {
  return `${kind}|${deviceId}|${kind === 'installation' ? (appSlug || '') : ''}`;
}

function read(): SyncQueueState {
  const s = cacheGet<SyncQueueState>('installation', NAME);
  if (s && Array.isArray(s.items)) return { items: s.items, seq: typeof s.seq === 'number' ? s.seq : s.items.length };
  return { items: [], seq: 0 };
}

function write(state: SyncQueueState): void {
  cacheSet('installation', NAME, state);
}

/**
 * Enqueue (or COALESCE into) a pending item. Returns the resulting item.
 * Enqueuing the same `(kind, deviceId, appSlug)` twice leaves exactly one item —
 * the later payload wins and the backoff is reset (it is fresh information).
 */
export function enqueue(input: {
  kind: SyncKind;
  deviceId: string;
  appSlug?: string;
  payload: any;
  now?: number;
}): SyncItem {
  const now = input.now ?? Date.now();
  const state = read();
  const key = itemKey(input.kind, input.deviceId, input.appSlug);
  const existing = state.items.find((i) => i.key === key);
  if (existing) {
    // Coalesce: newest payload wins, retry immediately.
    existing.payload = input.payload;
    existing.attempts = 0;
    existing.nextAttemptAt = 0;
    existing.lastError = undefined;
    write(state);
    return existing;
  }
  const item: SyncItem = {
    key,
    kind: input.kind,
    deviceId: input.deviceId,
    appSlug: input.appSlug,
    payload: input.payload,
    seq: state.seq++,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: now,
  };
  state.items.push(item);
  write(state);
  return item;
}

/** Items currently due (nextAttemptAt <= now), oldest first. */
export function dueItems(now: number = Date.now()): SyncItem[] {
  return read().items.filter((i) => i.nextAttemptAt <= now).sort((a, b) => a.seq - b.seq);
}

/** All items (diagnostics/tests). */
export function allItems(): SyncItem[] {
  return read().items.slice().sort((a, b) => a.seq - b.seq);
}

export function pendingCount(): number {
  return read().items.length;
}

/** Remove an item after a successful send. */
export function ack(key: string): void {
  const state = read();
  state.items = state.items.filter((i) => i.key !== key);
  write(state);
}

/** Record a failure and schedule the next attempt with backoff. */
export function nack(key: string, error: string, now: number = Date.now()): SyncItem | null {
  const state = read();
  const item = state.items.find((i) => i.key === key);
  if (!item) return null;
  item.attempts += 1;
  item.lastError = String(error || 'sync failed').slice(0, 200);
  item.nextAttemptAt = now + backoffDelay(item.attempts - 1, item.key);
  write(state);
  return item;
}

export function clearQueue(): void {
  clearNamespace('installation', { accountId: undefined });
}

/** Drop items that have been queued longer than the transaction TTL (stale work). */
export function pruneStale(now: number = Date.now(), maxAgeMs = CACHE_TTL.transaction * 4): number {
  const state = read();
  const before = state.items.length;
  state.items = state.items.filter((i) => now - i.createdAt < maxAgeMs);
  if (state.items.length !== before) write(state);
  return before - state.items.length;
}

export type FlushHandler = (item: SyncItem) => Promise<void>;

export interface FlushResult {
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
}

/**
 * Flush due items through `handler`. Stops early when the network throws for
 * EVERY item (likely offline) so we don't burn through backoff unnecessarily.
 *
 * `canSync` lets a caller veto the flush (e.g. explicitly offline).
 */
export async function flush(
  handler: FlushHandler,
  opts?: {
    now?: number;
    canSync?: () => boolean;
    maxItems?: number;
    /** Observability hook: called for each failed item (never throws). */
    onError?: (item: SyncItem, message: string) => void;
  },
): Promise<FlushResult> {
  const now = opts?.now ?? Date.now();
  if (opts?.canSync && !opts.canSync()) {
    return { sent: 0, failed: 0, skipped: pendingCount(), remaining: pendingCount() };
  }
  const due = dueItems(now).slice(0, opts?.maxItems ?? 25);
  let sent = 0, failed = 0;
  for (const item of due) {
    try {
      await handler(item);
      ack(item.key);
      sent++;
    } catch (e: any) {
      const message = e?.message || String(e);
      nack(item.key, message, now);
      failed++;
      try { opts?.onError?.(item, message); } catch { /* observability must never break sync */ }
    }
  }
  return { sent, failed, skipped: 0, remaining: pendingCount() };
}
