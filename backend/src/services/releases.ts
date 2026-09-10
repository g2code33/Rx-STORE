/**
 * RX Store — canonical release / package service.
 *
 * This module is the single source of truth for:
 *   - SemVer parsing + comparison (prereleases sort BELOW the final release)
 *   - release channel semantics (stable / beta / alpha)
 *   - package integrity validation (required metadata)
 *   - deterministic package SELECTION (platform + architecture + channel)
 *   - the client-facing release manifest
 *   - pagination metadata
 *
 * It is intentionally PURE (no D1 / R2 / fetch) so it can be unit-tested and
 * reused by the admin publish flow, the download route, and the update route.
 *
 * CANONICAL MODEL:
 *   Application -> Release -> Package -> (Platform + Architecture)
 * The legacy `versions` / `app_versions` tables remain for compatibility only.
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
export type Channel = 'stable' | 'beta' | 'alpha';

export const CHANNELS: Channel[] = ['stable', 'beta', 'alpha'];

/** Normalize an arbitrary channel string; unknown -> null (never guessed). */
export function normalizeChannel(raw: unknown): Channel | null {
  const c = String(raw ?? '').trim().toLowerCase();
  if (c === 'stable' || c === 'beta' || c === 'alpha') return c;
  // Accept a couple of common synonyms for robustness, but never invent a channel.
  if (c === 'prod' || c === 'production' || c === 'release') return 'stable';
  if (c === 'dev' || c === 'development' || c === 'canary') return 'alpha';
  return null;
}

/**
 * The default channel for anonymous / normal users is ALWAYS stable, so an
 * unpublished or experimental channel is never served by accident.
 */
export function defaultChannel(userRole?: string | null): Channel {
  // Only admins may implicitly see a non-stable default; everyone else is stable.
  return userRole === 'admin' ? 'stable' : 'stable';
}

/** Which channels a caller may explicitly request. */
export function channelAllowed(channel: Channel): boolean {
  return CHANNELS.includes(channel);
}

// ---------------------------------------------------------------------------
// SemVer
// ---------------------------------------------------------------------------
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers ([] for a final release). */
  prerelease: Array<string | number>;
  build: string[];
  /** True when the input could not be parsed as SemVer. */
  invalid?: boolean;
}

/**
 * Parse a version string. Accepts an optional leading `v`, 1-3 numeric segments
 * (`1`, `1.2`, `1.2.3`) plus prerelease/build metadata. Returns null when the
 * string is not version-like at all.
 */
export function parseSemver(raw: unknown): Semver | null {
  const s = String(raw ?? '').trim().replace(/^v/i, '');
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const prerelease = m[4]
    ? m[4].split('.').filter(Boolean).map((id) => (/^\d+$/.test(id) ? parseInt(id, 10) : id))
    : [];
  return {
    major: parseInt(m[1], 10) || 0,
    minor: m[2] !== undefined ? parseInt(m[2], 10) || 0 : 0,
    patch: m[3] !== undefined ? parseInt(m[3], 10) || 0 : 0,
    prerelease,
    build: m[5] ? m[5].split('.').filter(Boolean) : [],
  };
}

function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  // No prerelease > any prerelease (final release wins).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // shorter set of identifiers = lower
    if (y === undefined) return 1;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) { if (x !== y) return (x as number) < (y as number) ? -1 : 1; continue; }
    if (xn) return -1; // numeric identifiers sort lower than alphanumeric
    if (yn) return 1;
    if (x !== y) return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two versions (SemVer-aware). Returns -1 / 0 / +1.
 *  1.10.0 > 1.9.0      2.0.0 > 1.99.0      1.3.0 > 1.3.0-beta
 * Unparseable input sorts BELOW parseable input (so a real version always wins).
 */
export function compareSemver(a: unknown, b: unknown): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: unknown, current: unknown): boolean {
  return compareSemver(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Platform / architecture
// ---------------------------------------------------------------------------
export const PLATFORM_IDS = ['android', 'windows', 'linux', 'linux_deb', 'linux_appimage', 'flatpak', 'macos', 'web', 'pwa', 'ios'] as const;

/** Canonical architectures. `universal` matches any architecture request. */
export const ARCHITECTURES = ['x64', 'arm64', 'x86', 'arm', 'universal'] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

/** Normalize a platform id (aliases used by older clients / upload UIs). */
export function normalizePlatform(raw: unknown): string | null {
  const p = String(raw ?? '').trim().toLowerCase();
  if (!p) return null;
  if (p === 'deb') return 'linux_deb';
  if (p === 'appimage') return 'linux_appimage';
  if (p === 'linux') return 'linux'; // legacy generic alias — expanded during selection
  return (PLATFORM_IDS as readonly string[]).includes(p) ? p : null;
}

/** Normalize an architecture id to a canonical value (arch aliases included). */
export function normalizeArchitecture(raw: unknown): Architecture | null {
  const a = String(raw ?? '').trim().toLowerCase();
  if (!a || a === 'any' || a === 'all' || a === 'universal') return 'universal';
  if (a === 'x64' || a === 'x86_64' || a === 'amd64' || a === 'x86-64') return 'x64';
  if (a === 'arm64' || a === 'aarch64' || a === 'arm64-v8a') return 'arm64';
  if (a === 'x86' || a === 'i386' || a === 'i686' || a === 'ia32') return 'x86';
  if (a === 'arm' || a === 'armv7' || a === 'armeabi-v7a') return 'arm';
  return null;
}

/**
 * Platforms whose packages are not architecture-specific (a website / PWA build
 * is the same artifact everywhere). For these, only `universal` is expected.
 */
export function isArchAgnostic(platform: string): boolean {
  return ['web', 'pwa', 'ios'].includes(platform);
}

/**
 * The platform ids to search for a requested platform. `linux` is a legacy
 * generic alias that may be satisfied by linux_deb / linux_appimage packages.
 */
export function platformSearchIds(platform: string): string[] {
  if (platform === 'linux') return ['linux', 'linux_deb', 'linux_appimage', 'flatpak'];
  if (platform === 'linux_deb') return ['linux_deb', 'linux'];
  if (platform === 'linux_appimage') return ['linux_appimage', 'linux'];
  return [platform];
}

/**
 * Architecture preference order for a request. An exact match is always
 * preferred; `universal` is an acceptable substitute only when no
 * architecture-specific build exists, and vice versa.
 */
export function architectureSearchOrder(requested: Architecture, platform: string): Architecture[] {
  if (isArchAgnostic(platform)) return ['universal', requested, 'x64', 'arm64'];
  // A `universal` request (an unknown/unspecified device architecture) accepts
  // ANY build, so every canonical architecture is a candidate after universal.
  if (requested === 'universal') return ['universal', 'x64', 'arm64', 'x86', 'arm'];
  const order: Architecture[] = [requested];
  order.push('universal');
  if (requested === 'x64') order.push('x86');
  if (requested === 'arm64') order.push('arm');
  return order;
}

// ---------------------------------------------------------------------------
// Package integrity
// ---------------------------------------------------------------------------
export interface PackageRecord {
  id?: string;
  application_id?: string;
  release_id?: string;
  platform?: string;
  architecture?: string;
  filename?: string;
  storage_key?: string;
  file_size?: number;
  mime_type?: string;
  sha256?: string;
  version?: string;
  deployment_url?: string;
  package_type?: string;
  status?: string;
  min_os_version?: string;
  min_android_sdk?: number;
  [k: string]: any;
}

/** Fields a published package MUST have. Publish is refused when any is missing. */
export const REQUIRED_PACKAGE_FIELDS = ['platform', 'architecture', 'filename', 'storage_key', 'sha256', 'version'] as const;

/**
 * Validate a package's integrity. Returns the missing/invalid fields.
 * PWA/deployment-url packages are exempt from storage_key (they are a URL, not a
 * uploaded artifact), but they still need a version + platform.
 */
export function validatePackageIntegrity(pkg: PackageRecord): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const isPwa = pkg?.package_type === 'pwa' || !!pkg?.deployment_url;
  if (!pkg) return { ok: false, problems: ['package is missing'] };

  if (!pkg.platform) problems.push('platform');
  if (!pkg.architecture) problems.push('architecture');
  if (!pkg.version) problems.push('version');
  if (!pkg.filename) problems.push('filename');
  if (!pkg.sha256 || !/^[a-f0-9]{64}$/i.test(String(pkg.sha256))) problems.push('sha256');
  else {
    // size must be a positive integer (auto-derived from the upload, never hand-entered)
    if (!pkg.file_size || Number(pkg.file_size) <= 0) problems.push('file_size');
  }
  if (!isPwa && !pkg.storage_key) problems.push('storage_key');
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Package selection
// ---------------------------------------------------------------------------
export interface SelectOptions {
  /** Requested platform (already normalized or an alias). */
  platform: string;
  /** Requested architecture (canonical or alias). Defaults to x64. */
  architecture?: Architecture | string;
}

export interface SelectedPackage {
  pkg: PackageRecord;
  /** The platform id actually matched (may be an alias target). */
  matchedPlatform: string;
  /** The architecture actually matched (may be universal fallback). */
  matchedArchitecture: Architecture;
}

/**
 * Deterministically select the best package for a platform + architecture.
 *
 * Rules (never silently returns an incompatible package):
 *   1. Only packages for the requested platform family are considered.
 *   2. Architecture must match exactly, or fall back to `universal`.
 *   3. A `universal` request prefers `universal`, then x64, then any.
 *   4. When nothing compatible exists, returns null + a reason.
 *   5. Package integrity must pass.
 */
export function selectPackage(
  packages: PackageRecord[],
  opts: SelectOptions,
): { selected: SelectedPackage | null; reason?: string } {
  const requestedPlatform = normalizePlatform(opts.platform) || String(opts.platform || '').toLowerCase();
  const requestedArch = normalizeArchitecture(opts.architecture ?? 'x64') || 'x64';

  if (isArchAgnostic(requestedPlatform)) {
    const platformIds = [requestedPlatform];
    const candidates = (packages || []).filter((p) => platformIds.includes(String(p.platform)));
    if (!candidates.length) return { selected: null, reason: `No ${requestedPlatform} package is available.` };
    const valid = candidates.filter((p) => validatePackageIntegrity(p).ok);
    if (!valid.length) return { selected: null, reason: `The ${requestedPlatform} package is incomplete (missing metadata).` };
    // Prefer universal, then the requested arch, then any.
    const order: Architecture[] = ['universal', requestedArch, 'x64', 'arm64', 'x86', 'arm'];
    for (const arch of order) {
      const hit = valid.find((p) => normalizeArchitecture(p.architecture) === arch);
      if (hit) return { selected: { pkg: hit, matchedPlatform: hit.platform!, matchedArchitecture: arch } };
    }
    const any = valid[0];
    return { selected: { pkg: any, matchedPlatform: any.platform!, matchedArchitecture: normalizeArchitecture(any.architecture) || 'universal' } };
  }

  const platformIds = platformSearchIds(requestedPlatform);
  const archOrder = architectureSearchOrder(requestedArch, requestedPlatform);

  // Consider platforms in preference order, then architectures in preference order.
  for (const plat of platformIds) {
    const candidates = (packages || []).filter((p) => String(p.platform) === plat);
    if (!candidates.length) continue;
    const valid = candidates.filter((p) => validatePackageIntegrity(p).ok);
    if (!valid.length) continue;
    for (const arch of archOrder) {
      const hit = valid.find((p) => normalizeArchitecture(p.architecture) === arch);
      if (hit) return { selected: { pkg: hit, matchedPlatform: plat, matchedArchitecture: arch } };
    }
    // A `universal` request with no canonical match still accepts any build.
    if (requestedArch === 'universal') {
      const any = valid.find((p) => !!normalizeArchitecture(p.architecture));
      if (any) return { selected: { pkg: any, matchedPlatform: plat, matchedArchitecture: normalizeArchitecture(any.architecture)! } };
    }
    // No architecture match within this platform — try the next platform alias.
  }

  const anyPlat = (packages || []).some((p) => platformIds.includes(String(p.platform)));
  if (!anyPlat) return { selected: null, reason: `No ${requestedPlatform} package is available for this release.` };
  return { selected: null, reason: `No ${requestedPlatform} package matches architecture '${requestedArch}'.` };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
export interface ReleaseManifest {
  app: { id?: string; slug?: string; name?: string };
  version: string;
  channel: Channel;
  platform: string;
  architecture: Architecture;
  filename: string;
  size: number;
  sha256: string;
  /** Public URL (see docs: /r2/* storage is public by key). */
  url: string;
  packageType: string;
  releaseId?: string;
  releaseNotes: string[];
  mandatory: boolean;
  publishedAt?: string;
  /** Minimum OS requirement when recorded (informational; never blocking). */
  minOsVersion?: string;
  minAndroidSdk?: number;
}

/** Build the client-facing manifest for a selected package. */
export function buildManifest(input: {
  pkg: PackageRecord;
  matchedPlatform: string;
  matchedArchitecture: Architecture;
  app?: { id?: string; slug?: string; name?: string };
  channel?: Channel;
  releaseNotes?: string[];
  mandatory?: boolean;
  publishedAt?: string;
  origin: string;
}): ReleaseManifest {
  const { pkg, matchedPlatform, matchedArchitecture, app, origin } = input;
  const url = pkg.deployment_url
    ? pkg.deployment_url
    : `${String(origin).replace(/\/$/, '')}/r2/${pkg.storage_key}`;
  return {
    app: app || {},
    version: String(pkg.version || ''),
    channel: input.channel || 'stable',
    platform: matchedPlatform,
    architecture: matchedArchitecture,
    filename: String(pkg.filename || ''),
    size: Number(pkg.file_size || 0),
    sha256: String(pkg.sha256 || ''),
    url,
    packageType: String(pkg.package_type || 'installer'),
    releaseId: pkg.release_id,
    releaseNotes: input.releaseNotes || [],
    mandatory: !!input.mandatory,
    publishedAt: input.publishedAt,
    minOsVersion: pkg.min_os_version || undefined,
    minAndroidSdk: pkg.min_android_sdk != null ? Number(pkg.min_android_sdk) : undefined,
  };
}

/**
 * Whether a package satisfies a device's OS requirements. Compatibility
 * metadata is INFORMATIONAL: an app without it is never blocked, and a missing
 * device signal is treated as compatible.
 */
export function isOsCompatible(pkg: PackageRecord, device?: { osVersion?: string; androidSdk?: number }): boolean {
  if (!device) return true;
  if (pkg.min_android_sdk != null) {
    if (device.androidSdk != null && Number(device.androidSdk) < Number(pkg.min_android_sdk)) return false;
  }
  if (pkg.min_os_version && device.osVersion) {
    // Version-ish comparison; unparseable values never block.
    const cmp = compareSemver(device.osVersion, pkg.min_os_version);
    if (cmp < 0 && parseSemver(device.osVersion) && parseSemver(pkg.min_os_version)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * Build pagination metadata from the TRUE total row count (not the page length).
 * `page` and `limit` are sanitized (>=1, bounded).
 */
export function paginationMeta(input: { page?: number; limit?: number; total: number }): PaginationMeta {
  const pageSize = Math.min(Math.max(1, Math.floor(Number(input.limit) || 20)), 100);
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const total = Math.max(0, Math.floor(Number(input.total) || 0));
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalPages > 0,
  };
}
