/**
 * Download progress maths (pure, unit-tested — no React, no DOM).
 *
 * Kept separate from the card component because the test runner strips types
 * but cannot load .tsx.
 */

/**
 * Transfer rate in bytes per second from two samples.
 * Returns 0 when it cannot be known honestly (first sample, no progress, or
 * time not moving forward) — the UI then shows no rate rather than a guess.
 */
export function transferRate(
  prev: { at: number; received: number } | null,
  now: { at: number; received: number },
): number {
  if (!prev) return 0;
  const dt = (now.at - prev.at) / 1000;
  const db = now.received - prev.received;
  if (dt <= 0 || db <= 0) return 0;
  return db / dt;
}

/** Seconds remaining, or null when an estimate would be a guess. */
export function etaSeconds(received: number, total: number, bytesPerSecond: number): number | null {
  if (!total || total <= 0 || received >= total || bytesPerSecond <= 0) return null;
  return Math.max(1, Math.round((total - received) / bytesPerSecond));
}

/** Human file size (the card's "12.4 MB of 130 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "45s" / "3m 20s" / "1m". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
