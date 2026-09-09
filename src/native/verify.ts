/**
 * RX Store — artifact verification + SemVer comparison.
 *
 * PURE module (no Electron / Capacitor / browser access) so it is unit-testable
 * and reusable. It implements:
 *   - SHA-256 verification of a downloaded artifact against authoritative
 *     metadata (never bypassed, even for RX Store's own backend).
 *   - file-size validation against authoritative metadata.
 *   - SemVer-compatible comparison (1.10.0 > 1.9.0; prereleases sort below the
 *     same numbered release, never equal to a final release).
 */

/** Authoritative package metadata (from the releases/packages system). */
export interface PackageMetadata {
  slug?: string;
  version?: string;
  platform?: string;
  architecture?: string;
  fileName?: string;
  size?: number;
  sha256?: string;
  url?: string;
  /** Optional channel (stable/beta/alpha). */
  channel?: string;
  /** True when the package is a web/PWA (no artifact to verify). */
  isPwa?: boolean;
}

/** Result of verifying a downloaded artifact before installation. */
export interface VerificationResult {
  ok: boolean;
  /** 'ok' | 'size_mismatch' | 'sha256_mismatch' | 'missing_metadata' | 'empty' */
  reason: string;
  expectedSize?: number;
  actualSize?: number;
  expectedSha256?: string;
  actualSha256?: string;
}

/** SHA-256 of an ArrayBuffer (browser/worker). Returns lowercase hex. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a string (browser/worker). */
export async function sha256OfString(s: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer);
}

/**
 * Verify a downloaded artifact against authoritative metadata.
 *
 * Only fails on a CONCRETE mismatch. Missing metadata is treated as not-verified
 * only when the app is a native package that MUST have a checksum; web/PWA
 * returns ok (no artifact to verify).
 *
 * Rules:
 *   - Empty artifact => fail.
 *   - size provided and different => fail (size_mismatch).
 *   - sha256 provided and different => fail (sha256_mismatch).
 *   - No sha256 metadata (and not a web/PWA) => 'missing_metadata' (caller decides).
 */
/**
 * Synchronous size/emptiness pre-check. SHA-256 requires async hashing, so use
 * `verifyArtifactHash` for full verification. This is useful before hashing to
 * fail fast on an obviously truncated/empty artifact. Never installs on a
 * size mismatch.
 */
export function verifyArtifact(
  data: ArrayBuffer,
  meta: PackageMetadata,
  opts?: { requireChecksum?: boolean; isPwa?: boolean },
): VerificationResult {
  const actualSize = data.byteLength;
  const result: VerificationResult = {
    ok: false,
    reason: 'ok',
    expectedSize: meta.size || undefined,
    actualSize,
    expectedSha256: meta.sha256 || undefined,
  };
  if (actualSize <= 0) return { ...result, ok: false, reason: 'empty' };
  if (meta.size && meta.size > 0 && actualSize !== meta.size) {
    return { ...result, ok: false, reason: 'size_mismatch' };
  }
  // Size is sane; the full SHA-256 check is done by the async path.
  return { ...result, ok: true };
}

/**
 * Confirm the SHA-256 of `data` matches `meta.sha256`. Async because it hashes.
 * Returns a VerificationResult. Use this in the download pipeline.
 */
export async function verifyArtifactHash(
  data: ArrayBuffer,
  meta: PackageMetadata,
  opts?: { requireChecksum?: boolean; isPwa?: boolean },
): Promise<VerificationResult> {
  const actualSize = data.byteLength;
  const result: VerificationResult = {
    ok: false,
    reason: 'ok',
    expectedSize: meta.size || undefined,
    actualSize,
    expectedSha256: meta.sha256 || undefined,
  };
  if (actualSize <= 0) return { ...result, ok: false, reason: 'empty' };
  if (meta.size && meta.size > 0 && actualSize !== meta.size) {
    return { ...result, ok: false, reason: 'size_mismatch' };
  }
  const isPwa = !!(opts?.isPwa ?? (meta.platform === 'web' || meta.platform === 'pwa'));
  if (meta.sha256 && /^[a-f0-9]{64}$/i.test(meta.sha256)) {
    const actual = await sha256Hex(data);
    if (actual !== meta.sha256.toLowerCase()) {
      return { ...result, ok: false, reason: 'sha256_mismatch', actualSha256: actual };
    }
    return { ...result, ok: true, actualSha256: actual };
  }
  if (!isPwa && opts?.requireChecksum !== false) {
    return { ...result, ok: false, reason: 'missing_metadata' };
  }
  return { ...result, ok: true };
}

// ---------------------------------------------------------------------------
// SemVer comparison (numeric segments + prerelease awareness)
// ---------------------------------------------------------------------------

function parseSegment(v: string): { nums: number[]; pre: string[] } {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = s.match(/^(\d+(?:\.\d+)*)(?:[-+]((?:[0-9A-Za-z-]+\.?)*))?$/);
  if (!m) return { nums: [], pre: [] };
  const nums = (m[1] || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pre = m[2] ? m[2].split('.').filter(Boolean) : [];
  return { nums, pre };
}

function compareNums(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function comparePre(a: string[], b: string[]): number {
  // A version with a prerelease is LOWER than the same version without one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const sa = a[i] ?? '';
    const sb = b[i] ?? '';
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : NaN;
    const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : 1;
    if (!Number.isNaN(na)) return -1; // numeric identifiers sort lower
    if (!Number.isNaN(nb)) return 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer-compatible comparison. Returns -1 / 0 / +1.
 *  1.10.0 > 1.9.0
 *  1.3.0-beta < 1.3.0   (prerelease < final)
 *  1.3.0-beta < 1.3.0
 *  2.0.0 > 1.9.99
 *  missing/invalid sorts as 0 (never crashes).
 */
export function compareSemver(a?: string | null, b?: string | null): number {
  const pa = parseSegment(a || '');
  const pb = parseSegment(b || '');
  if (pa.nums.length === 0 && pb.nums.length === 0) return 0;
  const nums = compareNums(pa.nums, pb.nums);
  if (nums !== 0) return nums;
  return comparePre(pa.pre, pb.pre);
}

/** True when `a` is an older version than `b`. */
export function isOlder(a?: string | null, b?: string | null): boolean {
  return compareSemver(a, b) < 0;
}

/** True when `installed` is older than `store` (i.e. an update is available). */
export function isUpdateAvailable(installed?: string | null, store?: string | null): boolean {
  if (!installed || !store) return false;
  return compareSemver(installed, store) < 0;
}
