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

/**
 * The OAuth callback URL that MUST be registered on the GitHub App
 * (Identifying and authorizing users → Callback URL).
 *
 * IMPORTANT: the Worker serves the public API under `/v1` (VITE_API_URL is
 * `https://…workers.dev/v1`), but routes are dispatched on the path AFTER that
 * prefix is stripped. Building the URL from the incoming request origin alone
 * therefore produced `…/developers/github/callback` — which does NOT match the
 * documented registration (`…/v1/developers/github/callback`) and makes GitHub
 * answer "redirect_uri must match the registered callback URL".
 *
 * Override with GITHUB_APP_CALLBACK_URL when the deployment lives elsewhere.
 */
export function githubAppCallbackUrl(env: any, request?: Request): string {
  const explicit = String(env?.GITHUB_APP_CALLBACK_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const origin = request ? new URL(request.url).origin : 'https://rx-store-api.calcitoninpay.workers.dev';
  return `${origin}/v1/developers/github/callback`;
}

// ---------------------------------------------------------------------------
// User-to-server OAuth (GitHub App's own client credentials)
//
// This is the RELIABLE connection path: the developer authorizes the App as a
// USER, we receive a short-lived user token, and list ONLY the installations
// and repositories that user can already access. It does not depend on the
// post-install redirect (which drops our state when the App is already
// installed) and needs no RX Store session in the browser that completes it.
//
// Secrets: GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET (the App's own
// client credentials — NOT the sign-in OAuth app's). Optional: when absent the
// install-redirect flow stays available.
// ---------------------------------------------------------------------------

export interface GithubAppOAuthConfig { clientId: string; clientSecret: string }

export function githubAppOAuthConfig(env: any): GithubAppOAuthConfig | null {
  const clientId = String(env?.GITHUB_APP_CLIENT_ID || '').trim();
  const clientSecret = String(env?.GITHUB_APP_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function githubAppOAuthConfigured(env: any): boolean {
  return githubAppOAuthConfig(env) !== null;
}

/** Authorization URL for user-to-server OAuth (the App's own client id). */
export function userAuthorizeUrl(env: any, input: { state: string; redirectUri: string }): string | null {
  const cfg = githubAppOAuthConfig(env);
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    state: input.state,
    redirect_uri: input.redirectUri,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Exchange the user authorization code for a user access token. */
export async function exchangeUserCode(env: any, input: { code: string; redirectUri: string }): Promise<string | null> {
  const cfg = githubAppOAuthConfig(env);
  if (!cfg) return null;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
        code: input.code, redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await res.json().catch(() => null);
    return res.ok && typeof j?.access_token === 'string' && j.access_token ? String(j.access_token) : null;
  } catch {
    return null;
  }
}

export interface UserInstallation { installationId: string; accountLogin: string; accountType: string }

/** Installations the USER can access (never a global App listing). */
export async function userInstallations(userToken: string): Promise<UserInstallation[]> {
  try {
    const res = await fetch('https://api.github.com/user/installations?per_page=100', {
      headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-github' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const j: any = await res.json().catch(() => null);
    const list = Array.isArray(j?.installations) ? j.installations : [];
    return list.map((i: any) => ({
      installationId: String(i?.id ?? ''),
      accountLogin: String(i?.account?.login ?? ''),
      accountType: String(i?.account?.type ?? ''),
    })).filter((i: UserInstallation) => !!i.installationId);
  } catch {
    return [];
  }
}

export interface UserRepo { repositoryId: string; installationId: string; fullName: string; name: string; private: boolean }

/** Repositories of ONE installation that the USER can access. */
export async function userInstallationRepos(userToken: string, installationId: string): Promise<UserRepo[]> {
  try {
    const out: UserRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rx-store-github' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;
      const j: any = await res.json().catch(() => null);
      const repos = Array.isArray(j?.repositories) ? j.repositories : [];
      for (const r of repos) {
        out.push({
          repositoryId: String(r?.id ?? ''), installationId,
          fullName: String(r?.full_name ?? ''), name: String(r?.name ?? ''),
          private: r?.private === true,
        });
      }
      if (repos.length < 100) break;
    }
    return out.filter((r) => !!r.repositoryId);
  } catch {
    return [];
  }
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

// ---------------------------------------------------------------------------
// PEM → DER (both key formats GitHub can give you)
//
// GitHub issues App private keys as **PKCS#1** ("BEGIN RSA PRIVATE KEY"), but
// WebCrypto's importKey only understands **PKCS#8** ("BEGIN PRIVATE KEY").
// The old parser only matched the PKCS#8 header, so a real GitHub key was
// never decoded: the App JWT could not be signed, installation tokens failed,
// and connecting a repository dead-ended with "the GitHub installation could
// not be read". Both formats are handled now; PKCS#1 is wrapped into PKCS#8
// with a tiny DER encoder (no dependency needed).
// ---------------------------------------------------------------------------

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x >>>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derElement(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** rsaEncryption OID + NULL parameters (AlgorithmIdentifier). */
const RSA_ALGORITHM_ID = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
const PKCS8_VERSION_0 = new Uint8Array([0x02, 0x01, 0x00]);

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const parts = [PKCS8_VERSION_0, RSA_ALGORITHM_ID, derElement(0x04, pkcs1)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const inner = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { inner.set(part, offset); offset += part.length; }
  return derElement(0x30, inner);
}

export type PemKey = { der: Uint8Array; format: 'pkcs8' | 'pkcs1' } | { error: string };

/** Parse a PEM private key into importable PKCS#8 DER (PKCS#1 is converted). */
export function pemToDer(pemInput: string): PemKey {
  // Accept literal "\n" sequences (a key pasted into a single-line env var).
  const pem = String(pemInput || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!pem) return { error: 'the private key is empty' };
  if (/ENCRYPTED PRIVATE KEY/.test(pem)) {
    return { error: 'the private key is encrypted — generate an unencrypted key in the GitHub App settings' };
  }
  const match = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) return { error: 'the private key is not a valid PEM block' };
  const label = match[1].trim();
  const base64 = match[2].replace(/\s+/g, '');
  let bytes: Uint8Array;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { error: 'the private key body is not valid base64' };
  }
  if (label === 'RSA PRIVATE KEY') return { der: pkcs1ToPkcs8(bytes), format: 'pkcs1' };
  if (label === 'PRIVATE KEY') return { der: bytes, format: 'pkcs8' };
  return { error: `unsupported private key type "${label}"` };
}

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function appSigningKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const parsed = pemToDer(pem);
  if ('error' in parsed) throw new Error(`GitHub App private key could not be read: ${parsed.error}`);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8', parsed.der as unknown as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
  } catch (e: any) {
    throw new Error(`GitHub App private key could not be imported (${parsed.format}): ${String(e?.message || e)}`);
  }
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
