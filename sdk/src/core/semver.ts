/**
 * Standalone SemVer (semantic.org) comparison for the SDK.
 *
 * The AUTHORITATIVE comparison for update decisions happens on the RX Store
 * server (backend/src/services/releases.ts compareSemver — prerelease-aware).
 * The SDK keeps this dependency-free mirror only so it can validate version
 * STRINGS locally (config sanity, response validation) without any network
 * call or package dependency. The two implementations follow the same rules:
 *   1.0.0 < 1.0.1 < 1.1.0 < 2.0.0
 *   1.0.0-alpha < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0
 * Naive string comparison is never used.
 */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Strict SemVer parse; returns null for anything else (no loose mode). */
export function parseSemver(input: unknown): ParsedSemver | null {
  if (typeof input !== 'string') return null;
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

/** True for strictly-valid SemVer strings ("1.0", "v1.0.0" are NOT valid). */
export function isValidSemver(input: unknown): boolean {
  return parseSemver(input) !== null;
}

function comparePrereleaseTags(a: string[], b: string[]): number {
  // A version WITHOUT a prerelease tag is GREATER than one with it.
  if (!a.length && b.length) return 1;
  if (a.length && !b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn) return -1;      // numeric < alphanumeric
    else if (yn) return 1;
    else {
      const c = x < y ? -1 : x > y ? 1 : 0;
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Compare two versions: -1 (a<b), 0 (equal), 1 (a>b). Invalid → treated as lowest. */
export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrereleaseTags(pa.prerelease || [], pb.prerelease || []);
}
