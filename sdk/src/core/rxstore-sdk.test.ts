/**
 * RX Store Developer SDK — core behaviour tests (Phase 22 matrix).
 *
 * Everything runs against a mock fetch + injected openLink, so the tests
 * assert the real contract: the SDK checks the update API, reports
 * server-authoritative results, never crashes the host, never fetches or
 * installs binaries, and never touches authentication state.
 *
 * Run: node --experimental-strip-types --test sdk/src/core/rxstore-sdk.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createRxStoreSDK, validateConfig, DEFAULT_API_URL, DEFAULT_WEB_URL } from './createRxStoreSDK.ts';
import { detectPlatform, archFromUa } from './platform.ts';
import { deriveBannerState } from './banner.ts';

const OK_UPDATE = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    appId: 'app_123',
    app: 'PharmaTRACK',
    slug: 'pharmatrack',
    currentVersion: '1.1.4',
    latestVersion: '1.1.5',
    platform: 'android',
    architecture: 'arm64',
    channel: 'stable',
    updateAvailable: true,
    mandatory: false,
    minimumSupportedVersion: null,
    releaseNotes: ['Bug fixes', 'Performance improvements'],
    fileSize: 12345678,
    checksum: 'a'.repeat(64),
    storeUrl: 'https://rx-store-web.pages.dev/app/pharmatrack',
    deepLink: 'rxstore://app/pharmatrack',
    checkedAt: new Date().toISOString(),
    ...over,
  },
});

function mockFetch(handler: (url: string, init?: any) => any) {
  const calls: Array<{ url: string; init?: any }> = [];
  const impl = async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init);
    if (out instanceof Error) throw out;
    if (typeof out === 'number') return new Response('{}', { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { impl, calls };
}

function capturingOpen() {
  const opened: string[] = [];
  return { open: (url: string) => { opened.push(url); }, opened };
}

function baseConfig(over: Record<string, unknown> = {}) {
  return { appId: 'pharmatrack', currentVersion: '1.1.4', ...over } as any;
}

let clock = 1_000_000;
beforeEach(() => { clock = 1_000_000; });
function tick(ms: number) { clock += ms; }

// ---------------------------------------------------------------------------
// Initialization & configuration
// ---------------------------------------------------------------------------

test('SDK initializes with valid config and sane defaults', () => {
  const sdk = createRxStoreSDK(baseConfig());
  assert.equal(sdk.config.appId, 'pharmatrack');
  assert.equal(sdk.config.currentVersion, '1.1.4');
  assert.equal(sdk.config.apiUrl, DEFAULT_API_URL);
  assert.equal(sdk.config.webUrl, DEFAULT_WEB_URL);
  sdk.destroy();
});

test('missing appId is a configuration error', () => {
  assert.throws(() => createRxStoreSDK({ currentVersion: '1.0.0' } as any), /appId is required/);
  assert.throws(() => createRxStoreSDK({ appId: '', currentVersion: '1.0.0' } as any), /appId is required/);
  assert.equal(validateConfig({ currentVersion: '1.0.0' } as any), 'appId is required (the RX Store application slug, e.g. "pharmatrack")');
});

test('invalid version is a configuration error (strict SemVer)', () => {
  for (const bad of ['1.0', 'v1.0.0', 'latest', '', null]) {
    assert.throws(() => createRxStoreSDK({ appId: 'pharmatrack', currentVersion: bad } as any), /currentVersion must be a valid SemVer/);
  }
  // Valid forms are accepted, including prereleases.
  for (const good of ['1.0.0', '1.0.0-beta.1', '1.0.0-rc.1', '2.0.0']) {
    createRxStoreSDK({ appId: 'pharmatrack', currentVersion: good }).destroy();
  }
});

test('invalid platform override is a configuration error', () => {
  assert.throws(() => createRxStoreSDK(baseConfig({ platform: 'Solaris' as any })), /platform must be one of/);
});

// ---------------------------------------------------------------------------
// Update checks
// ---------------------------------------------------------------------------

test('update available: server-authoritative result with full metadata', async () => {
  const { impl, calls } = mockFetch(() => OK_UPDATE());
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'UPDATE_AVAILABLE');
  assert.equal(result.update?.latestVersion, '1.1.5');
  assert.equal(result.update?.mandatory, false);
  assert.equal(result.update?.appName, 'PharmaTRACK');
  assert.equal(result.update?.checksum, `sha256:${'a'.repeat(64)}`, 'checksum normalized to sha256:');
  assert.ok(result.update?.deepLink === 'rxstore://app/pharmatrack');
  // The ONE canonical endpoint (with /v1 default base):
  assert.match(calls[0].url, /^https:\/\/rx-store-api\.calcitoninpay\.workers\.dev\/v1\/updates\/check\?/);
  assert.match(calls[0].url, /app=pharmatrack/);
  assert.match(calls[0].url, /currentVersion=1\.1\.4/);
  assert.ok(sdk.hasUpdate());
  sdk.destroy();
});

test('no update: status NO_UPDATE and hasUpdate() false', async () => {
  const { impl } = mockFetch(() => OK_UPDATE({ updateAvailable: false, latestVersion: '1.1.4' }));
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'NO_UPDATE');
  assert.equal(sdk.hasUpdate(), false);
  assert.equal(sdk.isMandatoryUpdate(), false);
  sdk.destroy();
});

test('mandatory update: server flag becomes MANDATORY_UPDATE', async () => {
  const { impl } = mockFetch(() => OK_UPDATE({ mandatory: true }));
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'MANDATORY_UPDATE');
  assert.ok(sdk.hasUpdate());
  assert.ok(sdk.isMandatoryUpdate());
  sdk.destroy();
});

test('below minimumSupportedVersion is surfaced (updateRequired + mandatory)', async () => {
  const { impl } = mockFetch(() => OK_UPDATE({ minimumSupportedVersion: '1.1.2', updateRequired: true, mandatory: true }));
  const sdk = createRxStoreSDK(baseConfig({ currentVersion: '1.1.0', fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'MANDATORY_UPDATE');
  assert.equal(result.update?.minimumSupportedVersion, '1.1.2');
  assert.equal(result.update?.updateRequired, true);
  sdk.destroy();
});

test('network failure → NETWORK_ERROR result (never a throw, never a crash)', async () => {
  const { impl } = mockFetch(() => new Error('offline'));
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'NETWORK_ERROR');
  assert.ok(result.error);
  // Host application continues normally — no exception escaped.
  sdk.destroy();
});

test('malformed response → INVALID_RESPONSE (fail closed for unsafe metadata)', async () => {
  const cases: any[] = [
    { success: true, data: { updateAvailable: 'yes' } },                    // non-boolean
    { success: true, data: { updateAvailable: true, latestVersion: 'soon' } }, // invalid semver target
    { success: true, data: null },
    { garbage: true },
  ];
  for (const body of cases) {
    const { impl } = mockFetch(() => body);
    const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
    const result = await sdk.checkForUpdate({ force: true });
    assert.equal(result.status, 'INVALID_RESPONSE', JSON.stringify(body));
    assert.equal(sdk.hasUpdate(), false, 'unsafe metadata never surfaces as an update');
    sdk.destroy();
  }
});

test('hostile destinations in an otherwise-valid response are rejected', async () => {
  const { impl } = mockFetch(() => OK_UPDATE({
    storeUrl: 'javascript:alert(1)',
    deepLink: 'rxstore://app/../../evil',
  }));
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  const result = await sdk.checkForUpdate({ force: true });
  // The metadata was unsafe → fail closed.
  assert.equal(result.status, 'INVALID_RESPONSE');
  sdk.destroy();
});

test('rate limited → RATE_LIMITED', async () => {
  const { impl } = mockFetch(() => 429);
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  assert.equal((await sdk.checkForUpdate({ force: true })).status, 'RATE_LIMITED');
  sdk.destroy();
});

test('server error → SERVER_ERROR', async () => {
  const { impl } = mockFetch(() => 503);
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  assert.equal((await sdk.checkForUpdate({ force: true })).status, 'SERVER_ERROR');
  sdk.destroy();
});

test('unknown app → APP_NOT_FOUND', async () => {
  const { impl } = mockFetch(() => 404);
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  assert.equal((await sdk.checkForUpdate({ force: true })).status, 'APP_NOT_FOUND');
  sdk.destroy();
});

// ---------------------------------------------------------------------------
// Platform / architecture selection
// ---------------------------------------------------------------------------

test('explicit platform + architecture overrides are sent to the API', async () => {
  const { impl, calls } = mockFetch(() => OK_UPDATE());
  const sdk = createRxStoreSDK(baseConfig({ platform: 'android', architecture: 'arm64', fetchImpl: impl as any }));
  await sdk.checkForUpdate({ force: true });
  assert.match(calls[0].url, /platform=android/);
  assert.match(calls[0].url, /arch=arm64/);
  sdk.destroy();
});

test('channel is sent (default stable)', async () => {
  const { impl, calls } = mockFetch(() => OK_UPDATE());
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  await sdk.checkForUpdate({ force: true });
  assert.match(calls[0].url, /channel=stable/);
  sdk.destroy();
});

test('detectPlatform: a browser UA mentioning Android is NOT an Android host', () => {
  // Chrome on Android — a normal web page, NOT a native host.
  const web = detectPlatform(null, { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128 Mobile' });
  assert.equal(web.platform, 'web');
  assert.equal(web.source, 'heuristic');
  // Only the HARD bridge evidence (Capacitor native) identifies Android.
  const native = detectPlatform(null, {
    userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  });
  assert.equal(native.platform, 'android');
  assert.equal(native.source, 'bridge');
  // Override always wins.
  const forced = detectPlatform('linux', { userAgent: 'Android' });
  assert.equal(forced.platform, 'linux');
  assert.equal(forced.source, 'override');
  // PWA standalone display mode.
  const pwa = detectPlatform(null, { userAgent: 'anything', standalone: true } as any);
  assert.equal(pwa.platform, 'pwa');
});

test('architecture hints are conservative', () => {
  assert.equal(archFromUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'x64');
  assert.equal(archFromUa('Mozilla/5.0 (Linux; Android 14; arm64)'), 'arm64');
  assert.equal(archFromUa('Mozilla/5.0 (compatible)'), null);
});

// ---------------------------------------------------------------------------
// Links, deep linking, HTTPS fallback
// ---------------------------------------------------------------------------

test('deep link + store URL builders produce the canonical formats', () => {
  const sdk = createRxStoreSDK(baseConfig());
  assert.equal(sdk.buildDeepLink(), 'rxstore://app/pharmatrack');
  assert.equal(sdk.buildStoreUrl(), 'https://rx-store-web.pages.dev/app/pharmatrack');
  sdk.destroy();
});

test('slug encoding is safe (kebab-case allowlist, no traversal)', () => {
  const ok = createRxStoreSDK({ appId: 'clinical-rx-2', currentVersion: '1.0.0' });
  assert.equal(ok.buildDeepLink(), 'rxstore://app/clinical-rx-2');
  ok.destroy();
});

test('openUpdateInRxStore: web host goes straight to the HTTPS store page', async () => {
  const { impl } = mockFetch(() => OK_UPDATE());
  const { open, opened } = capturingOpen();
  const sdk = createRxStoreSDK(baseConfig({ platform: 'web', fetchImpl: impl as any, openLink: open }));
  await sdk.checkForUpdate({ force: true });
  sdk.openUpdateInRxStore();
  assert.deepEqual(opened, ['https://rx-store-web.pages.dev/app/pharmatrack']);
  sdk.destroy();
});

test('openUpdateInRxStore: native host tries the deep link, falls back to HTTPS when still visible', async () => {
  const { impl } = mockFetch(() => OK_UPDATE());
  const { open, opened } = capturingOpen();
  const sdk = createRxStoreSDK(baseConfig({
    platform: 'android',
    fetchImpl: impl as any,
    openLink: open,
    isVisible: () => true, // RX Store never opened → host still visible
    fallbackDelayMs: 50,
  }));
  await sdk.checkForUpdate({ force: true });
  sdk.openUpdateInRxStore();
  assert.deepEqual(opened, ['rxstore://app/pharmatrack'], 'deep link first');
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(opened, ['rxstore://app/pharmatrack', 'https://rx-store-web.pages.dev/app/pharmatrack'], 'then HTTPS fallback');
  sdk.destroy();
});

test('openUpdateInRxStore: NO fallback when the host lost visibility (RX Store opened)', async () => {
  const { impl } = mockFetch(() => OK_UPDATE());
  const { open, opened } = capturingOpen();
  let visible = true;
  const sdk = createRxStoreSDK(baseConfig({
    platform: 'windows',
    fetchImpl: impl as any,
    openLink: open,
    isVisible: () => visible,
    fallbackDelayMs: 40,
  }));
  await sdk.checkForUpdate({ force: true });
  sdk.openUpdateInRxStore();
  visible = false; // the deep link took the user away
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(opened, ['rxstore://app/pharmatrack'], 'no fallback — RX Store handled it');
  sdk.destroy();
});

test('THE SDK NEVER INSTALLS: the only request it ever makes is the update check', async () => {
  const { impl, calls } = mockFetch(() => OK_UPDATE({ downloadURL: 'https://evil.example/binary.exe' }));
  const { open, opened } = capturingOpen();
  const sdk = createRxStoreSDK(baseConfig({ platform: 'android', fetchImpl: impl as any, openLink: open }));
  await sdk.checkForUpdate({ force: true });
  sdk.openUpdateInRxStore();
  await new Promise((r) => setTimeout(r, 30));
  // One fetch — the update check. No binary, no POSTs, no auth headers.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/updates\/check\?/);
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.headers?.Authorization, undefined, 'no credentials in a public check');
  // And the ONLY navigation targets are the store page / deep link.
  for (const url of opened) assert.match(url, /^(rxstore:\/\/app\/|https:\/\/rx-store-web\.pages\.dev\/app\/)/);
  sdk.destroy();
});

// ---------------------------------------------------------------------------
// Check policy: cache, dedupe, backoff
// ---------------------------------------------------------------------------

test('successful responses are cached briefly (no duplicate requests inside the TTL)', async () => {
  const { impl, calls } = mockFetch(() => OK_UPDATE());
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any, cacheTtlMs: 60_000 }));
  const a = await sdk.checkForUpdate({ force: true });
  const b = await sdk.checkForUpdate();
  assert.equal(calls.length, 1, 'second call served from cache');
  assert.equal(b.cached, true);
  assert.equal(b.status, a.status);
  sdk.destroy();
});

test('concurrent checks are de-duplicated into ONE request', async () => {
  let resolveOne: (v: any) => void;
  const { impl, calls } = mockFetch(() => new Promise((res) => { resolveOne = res; }));
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any, cacheTtlMs: 0 }));
  const p1 = sdk.checkForUpdate({ force: true });
  const p2 = sdk.checkForUpdate({ force: true });
  const p3 = sdk.checkForUpdate({ force: true });
  resolveOne!(OK_UPDATE());
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls.length, 1, 'single-flight');
  assert.equal(r1.status, 'UPDATE_AVAILABLE');
  assert.equal(r2.status, 'UPDATE_AVAILABLE');
  assert.equal(r3.status, 'UPDATE_AVAILABLE');
  sdk.destroy();
});

test('failures apply exponential backoff (force bypasses it)', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const { impl, calls } = mockFetch(() => (mode === 'fail' ? new Error('down') : OK_UPDATE()));
  const sdk = createRxStoreSDK(baseConfig({
    fetchImpl: impl as any,
    cacheTtlMs: 0,
    backoff: { initialMs: 1_000, factor: 2, maxMs: 10_000 },
  }));
  const first = await sdk.checkForUpdate({ force: true });
  assert.equal(first.status, 'NETWORK_ERROR');
  // Immediately again → suppressed by backoff, same result, no request.
  const second = await sdk.checkForUpdate();
  assert.equal(calls.length, 1);
  assert.equal(second.backoffActive, true);
  assert.equal(second.status, 'NETWORK_ERROR');
  // Force bypasses backoff and can succeed again.
  mode = 'ok';
  const third = await sdk.checkForUpdate({ force: true });
  assert.equal(calls.length, 2);
  assert.equal(third.status, 'UPDATE_AVAILABLE');
  sdk.destroy();
});

test('destroy() stops timers and further checks', async () => {
  const { impl } = mockFetch(() => OK_UPDATE());
  const sdk = createRxStoreSDK(baseConfig({ fetchImpl: impl as any }));
  sdk.destroy();
  const result = await sdk.checkForUpdate({ force: true });
  assert.equal(result.status, 'NETWORK_ERROR');
  assert.match(String(result.error), /destroyed/);
});

// ---------------------------------------------------------------------------
// Banner policy (used by the optional React component)
// ---------------------------------------------------------------------------

test('banner: non-mandatory update is dismissible per version', () => {
  const check = { status: 'UPDATE_AVAILABLE', update: { latestVersion: '1.1.5' } } as any;
  assert.equal(deriveBannerState(check, { version: null }).kind, 'available');
  const dismissed = deriveBannerState(check, { version: '1.1.5' });
  assert.equal(dismissed.kind, 'hidden', 'dismissed for this version');
  const next = deriveBannerState({ status: 'UPDATE_AVAILABLE', update: { latestVersion: '1.1.6' } } as any, { version: '1.1.5' });
  assert.equal(next.kind, 'available', 'a NEW version shows the banner again');
});

test('banner: mandatory update cannot be dismissed', () => {
  const check = { status: 'MANDATORY_UPDATE', update: { latestVersion: '1.1.5' } } as any;
  assert.equal(deriveBannerState(check, { version: '1.1.5' }).kind, 'mandatory', 'dismissal is never honoured');
  assert.equal(deriveBannerState(check, { version: null }).kind, 'mandatory');
});

test('banner: network errors are retryable; bad metadata fails closed (hidden)', () => {
  assert.deepEqual(
    { ...deriveBannerState({ status: 'NETWORK_ERROR' } as any, { version: null }) },
    { kind: 'error', status: 'NETWORK_ERROR', retryable: true },
  );
  assert.equal(deriveBannerState({ status: 'INVALID_RESPONSE' } as any, { version: null }).kind, 'hidden');
  assert.equal(deriveBannerState({ status: 'APP_NOT_FOUND' } as any, { version: null }).kind, 'hidden');
  assert.equal(deriveBannerState(null, { version: null }).kind, 'loading');
  assert.equal(deriveBannerState({ status: 'NO_UPDATE' } as any, { version: null }).kind, 'hidden');
});

// ---------------------------------------------------------------------------
// Security: no secrets ship in the SDK sources
// ---------------------------------------------------------------------------

test('the SDK sources contain no secrets', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const patterns: RegExp[] = [
    /JWT_SECRET/, /PAYSTACK_SECRET/i, /VIRUSTOTAL_API_KEY/i, /sk_live_/, /sk-or-v1-/,
    /nvapi-/, /AIza[0-9A-Za-z_-]{30}/, /r2 access key/i, /CLOUDFLARE_API_TOKEN/i,
    /BEGIN (RSA |EC )?PRIVATE KEY/,
  ];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const re of patterns) assert.ok(!re.test(src), `${f} matches secret pattern ${re}`);
  }
});
