/**
 * RX Store — GitHub App primitives for the GitHub Releases integration.
 *
 * SEPARATE from the existing GitHub user SIGN-IN (routes/oauth.ts): signing in
 * with GitHub proves who the user is; a GitHub App INSTALLATION grants RX
 * Store read access to specific repositories. Different credentials, different
 * flows, different tables — never conflated.
 *
 * Secrets (Worker secrets, never in source control, never in responses):
 *   GITHUB_APP_ID          numeric id of the RX Store GitHub App
 *   GITHUB_APP_PRIVATE_KEY the App's PEM private key (PKCS#8)
 *   GITHUB_APP_SLUG        the App's URL slug (for the install URL)
 *   GITHUB_WEBHOOK_SECRET  shared secret for webhook signature verification
 *
 * When any of these is missing the integration reports 'not_configured' — it
 * never pretends to be connected and never falls back to insecure credentials.
 *
 * Minimum permissions (documented in docs/GITHUB_RELEASES.md):
 *   Contents: Read (releases + release assets), Metadata: Read (mandatory).
 *   No write access. Subscribed webhook event: 'release'.
 */

import { timingSafeEqualStr } from './password.ts';
import { parseSemver } from './releases.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  appSlug: string;
  webhookSecret: string;
}

export function githubAppConfig(env: any): GithubAppConfig | null {
  const appId = String(env?.GITHUB_APP_ID || '').trim();
  const privateKey = String(env?.GITHUB_APP_PRIVATE_KEY || '').trim();
  const appSlug = String(env?.GITHUB_APP_SLUG || '').trim();
  const webhookSecret = String(env?.GITHUB_WEBHOOK_SECRET || '').trim();
  if (!appId || !privateKey || !appSlug || !webhookSecret) return null;
  return { appId, privateKey, appSlug, webhookSecret };
}

export function githubConfigured(env: any): boolean {
  return githubAppConfig(env) !== null;
}

/** The Worker secrets the integration requires (names only — never values). */
export const GITHUB_REQUIRED_SECRETS = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'] as const;

/**
 * Which required secrets are missing or empty. Used for honest diagnostics
 * ('configured: false' + the exact names) — secret VALUES are never exposed.
 */
export function githubMissingSecrets(env: any): string[] {
  return GITHUB_REQUIRED_SECRETS.filter((k) => !String(env?.[k] || '').trim());
}

// ---------------------------------------------------------------------------
// GitHub App JWT (RS256) — used only to mint short-lived installation tokens
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function appSigningKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBytes(pem) as unknown as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  cachedKey = { pem, key };
  return key;
}

export async function githubAppJwt(env: any): Promise<string> {
  const cfg = githubAppConfig(env);
  if (!cfg) throw new Error('GitHub App is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
  const input = `${header}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await appSigningKey(cfg.privateKey), new TextEncoder().encode(input),
  ));
  return `${input}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// Installation access tokens (short-lived, cached per isolate)
// ---------------------------------------------------------------------------

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

export async function installationToken(env: any, installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const jwt = await githubAppJwt(env);
  const res = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-github' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`installation_token_${res.status}`);
  const json: any = await res.json().catch(() => null);
  if (!json?.token) throw new Error('installation_token_missing');
  const expiresAt = json.expires_at ? new Date(String(json.expires_at)).getTime() : Date.now() + 55 * 60_000;
  tokenCache.set(installationId, { token: String(json.token), expiresAt });
  return String(json.token);
}

/** List repositories the installation can read (server-side truth). */
export async function installationRepos(env: any, installationId: string): Promise<any[]> {
  const token = await installationToken(env, installationId);
  const res = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-github' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`installation_repos_${res.status}`);
  const json: any = await res.json().catch(() => null);
  return Array.isArray(json?.repositories) ? json.repositories : [];
}

// ---------------------------------------------------------------------------
// Webhook signature verification (timing-safe)
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !/^sha256=/.test(header)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  let hex = ''; for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return timingSafeEqualStr(hex, header.slice('sha256='.length).toLowerCase());
}

// ---------------------------------------------------------------------------
// SSRF guards — only GitHub release-asset hosts, https, no credentials,
// no IP literals, manual redirects re-validated per hop
// ---------------------------------------------------------------------------

export const GITHUB_ASSET_HOST_ALLOWLIST = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

export function isAllowedGithubHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  // Reject raw IPs (v4/v6) and localhost — allowlist entries are domains only.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h === 'localhost' || h.endsWith('.localhost')) return false;
  return GITHUB_ASSET_HOST_ALLOWLIST.has(h) || h.endsWith('.githubusercontent.com');
}

/** Validate an asset URL exactly as used for verification + user download. */
export function validateAssetUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { return { ok: false, reason: 'malformed URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https URLs are allowed' };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  if (!isAllowedGithubHost(u.hostname)) return { ok: false, reason: `host '${u.hostname}' is not an allowed GitHub asset host` };
  return { ok: true, url: u.toString() };
}

// ---------------------------------------------------------------------------
// Deterministic asset-filename → platform/architecture mapping
// ---------------------------------------------------------------------------

export interface AssetMapping {
  platform: string;
  architecture: string;
}

/**
 * Documented, deterministic mapping from a GitHub asset filename to an RX Store
 * platform + architecture. Rules (in order):
 *   1. An explicit rx-store release manifest (parsed from the release body)
 *      always wins — see parseRxManifest.
 *   2. Extension mapping:
 *        .apk     -> android / universal
 *        .exe/.msi-> windows / x64, unless the filename carries arm64/aarch64
 *        .deb     -> linux_deb / arch REQUIRED in filename (amd64|x64 -> x64,
 *                    arm64|aarch64 -> arm64, armhf|arm -> arm)
 *        .appimage-> linux_appimage / arch REQUIRED (x86_64|x64 -> x64,
 *                    aarch64|arm64 -> arm64)
 *        .dmg/.pkg-> macos / universal, unless arch marker present
 *   3. Anything else (source zips, checksums, standalone binaries without a
 *      known installer extension) is NOT mapped — ambiguous means unmapped,
 *      never guessed.
 */
export function mapAssetFilename(name: string): AssetMapping | null {
  const n = String(name || '').toLowerCase();
  const arm64 = /(arm64|aarch64)/.test(n);
  const x64 = !arm64 && /(amd64|x86_64|\bx64\b)/.test(n);
  const arm = !arm64 && !x64 && /(armhf|\barm\b)/.test(n);

  if (n.endsWith('.apk')) return { platform: 'android', architecture: 'universal' };
  if (n.endsWith('.exe') || n.endsWith('.msi')) return { platform: 'windows', architecture: arm64 ? 'arm64' : 'x64' };
  if (n.endsWith('.deb')) {
    if (arm64) return { platform: 'linux_deb', architecture: 'arm64' };
    if (x64) return { platform: 'linux_deb', architecture: 'x64' };
    if (arm) return { platform: 'linux_deb', architecture: 'arm' };
    return null; // ambiguous architecture — never guessed
  }
  if (n.endsWith('.appimage')) {
    if (arm64) return { platform: 'linux_appimage', architecture: 'arm64' };
    if (x64) return { platform: 'linux_appimage', architecture: 'x64' };
    return null;
  }
  if (n.endsWith('.dmg') || n.endsWith('.pkg')) return { platform: 'macos', architecture: arm64 ? 'arm64' : 'universal' };
  return null;
}

/**
 * Parse an explicit rx-store manifest from a GitHub release body. The manifest
 * is a fenced ```json block containing {"rx-store": {"assets": [...]}} and may
 * only disambiguate platform/architecture per FILENAME — it can NEVER assign a
 * URL, an asset from another release, or an unsupported platform.
 */
export function parseRxManifest(releaseBody: string): Record<string, AssetMapping> | null {
  const body = String(releaseBody || '');
  const blocks = body.match(/```json\s*([\s\S]*?)```/gi) || [];
  for (const block of blocks) {
    const inner = block.replace(/```json/i, '').replace(/```/, '');
    let parsed: any;
    try { parsed = JSON.parse(inner.trim()); } catch { continue; }
    const assets = parsed?.['rx-store']?.assets;
    if (!Array.isArray(assets)) continue;
    const out: Record<string, AssetMapping> = {};
    let any = false;
    for (const a of assets) {
      const file = String(a?.file || '').trim();
      const platform = String(a?.platform || '').trim();
      const architecture = String(a?.architecture || 'universal').trim();
      if (!file || !platform) continue;
      if (!/^[A-Za-z0-9._ -]+$/.test(file)) continue; // filenames only — no paths, no URLs
      if (!['android', 'windows', 'linux', 'linux_deb', 'linux_appimage', 'flatpak', 'macos'].includes(platform)) continue;
      if (!['x64', 'x86', 'arm64', 'arm', 'universal'].includes(architecture)) continue;
      out[file] = { platform, architecture };
      any = true;
    }
    if (any) return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version from a tag
// ---------------------------------------------------------------------------

/** Parse a release tag into a strict version string ('v1.2.3' -> '1.2.3'). */
export function versionFromTag(tag: unknown): string | null {
  const t = String(tag ?? '').trim();
  if (!t) return null;
  const sem = parseSemver(t.replace(/^v/i, ''));
  if (!sem || sem.invalid) return null;
  // Re-emit canonically (drops build metadata, keeps prerelease).
  const pre = sem.prerelease.length ? `-${sem.prerelease.join('.')}` : '';
  return `${sem.major}.${sem.minor}.${sem.patch}${pre}`;
}

// ---------------------------------------------------------------------------
// Bounded, streaming asset fetch (size + sha256 from ACTUAL bytes)
// ---------------------------------------------------------------------------

export interface StreamedAsset {
  size: number;
  sha256: string;
  finalUrl: string;
}

/**
 * Stream a remote asset WITHOUT buffering it: every chunk is fed to a
 * DigestStream and counted, then dropped. Redirects are followed MANUALLY (max
 * 3) and every hop must be an allowed GitHub host. Enforces a hard byte cap.
 */
export async function streamAssetHash(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<StreamedAsset> {
  let current = url;
  let resp: Response | null = null;
  for (let hop = 0; hop <= 3; hop++) {
    const check = validateAssetUrl(current);
    if (!check.ok) throw new Error(`asset URL rejected at redirect: ${check.reason}`);
    resp = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'rx-store-github', Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(opts.timeoutMs || 60_000),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('Location');
      if (!loc) throw new Error(`asset redirect without Location (${resp.status})`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!resp.ok || !resp.body) throw new Error(`asset fetch failed (${resp.status})`);
    break;
  }
  if (!resp || !resp.body) throw new Error('asset fetch failed (no body)');

  // Runtime-agnostic streaming hash (same dual-path as services/streaming.ts):
  //   Workers: crypto.DigestStream — `digest` is a PROMISE, must be awaited.
  //   Node (tests): node:crypto createHash, updated chunk by chunk.
  const DS = (globalThis as any).crypto?.DigestStream;
  const reader = resp.body.getReader();
  let size = 0;
  let hash = '';
  if (typeof DS === 'function') {
    const digest = new DS('SHA-256');
    const writer = digest.getWriter();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) throw new Error(`asset exceeds the ${Math.floor(opts.maxBytes / 1_000_000)}MB size limit`);
        await writer.write(value);
      }
    } finally {
      try { await reader.cancel(); } catch {}
      try { await writer.close(); } catch {}
    }
    const buf: ArrayBuffer = await digest.digest; // Workers contract: PROMISE
    hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) throw new Error(`asset exceeds the ${Math.floor(opts.maxBytes / 1_000_000)}MB size limit`);
        if (value && value.length) h.update(value);
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    hash = h.digest('hex');
  }
  return { size, sha256: hash, finalUrl: current };
}

// ---------------------------------------------------------------------------
// GitHub REST helper
// ---------------------------------------------------------------------------

export async function ghApi(
  env: any,
  path: string,
  opts: { installationId?: string; token?: string } = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  const token = opts.token || (opts.installationId ? await installationToken(env, opts.installationId) : null);
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rx-store-github',
    },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}
