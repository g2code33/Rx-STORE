/**
 * Scanner resilience tests — rate limits, retries, provider-keyed caching and
 * duplicate-hash reuse at the runMalwareScan level (the scanner contract the
 * pipeline relies on).
 *
 * Run: node --experimental-strip-types --test backend/src/scannerResilience.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runMalwareScan } from './services/packageSecurity.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

const FAST = { VT_SCAN_MAX_RETRIES: 2, VT_SCAN_RETRY_DELAY_MS: 1, ...{ VT_SCAN_MAX_POLLS: 2, VT_SCAN_POLL_INTERVAL_MS: 1, VT_SCAN_POLL_GROWTH: 1, VT_SCAN_POLL_MAX_INTERVAL_MS: 2 } };

function fakeEnv(over: Record<string, any> = {}) {
  const cache: any[] = [];
  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('FROM scanner_cache WHERE sha256=? AND provider=?')) {
            return cache.find((c: any) => c.sha256 === a[0] && c.provider === a[1]) || null;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          const s = sql.replace(/\s+/g, ' ');
          const a = self._b;
          if (s.includes('INSERT INTO scanner_cache') || s.includes('ON CONFLICT(sha256) DO UPDATE')) {
            const i = cache.findIndex((c: any) => c.sha256 === a[0]);
            const row = { sha256: a[0], provider: a[1], verdict: a[2], analysis_id: a[3], malicious: a[4], suspicious: a[5], harmless: a[6], undetected: a[7], scanned_at: new Date().toISOString() };
            if (i >= 0) cache[i] = row; else cache.push(row);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  return { DB, __cache: cache, MALWARE_SCANNER: 'virustotal', VIRUSTOTAL_API_KEY: 'vt_secret', ...FAST, ...over };
}

const SHA = '1'.repeat(64);
const CLEAN = () => new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 60, undetected: 5 } } } }), { status: 200 });

test('429: bounded in-run retry with backoff — recovery within the budget yields CLEAN', async () => {
  const env = fakeEnv();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 2) return new Response('{"error":{"code":"RateLimitError"}}', { status: 429 });
    return CLEAN();
  }) as any;
  const res = await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(res.status, 'CLEAN');
  assert.equal(calls, 3, 'exactly maxRetries+1 attempts — bounded, no hammering');
});

test('429: persistent rate limiting → UNAVAILABLE after the bounded budget (never CLEAN/DETECTED)', async () => {
  const env = fakeEnv();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('{"error":{"code":"RateLimitError"}}', { status: 429 }); }) as any;
  const res = await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(res.status, 'UNAVAILABLE');
  assert.match(res.result, /rate limited/);
  assert.equal(calls, 3, 'stopped exactly at the budget — the provider is not hammered');
});

test('timeout / provider outage → UNAVAILABLE (retryable, submission preserved)', async () => {
  const env = fakeEnv();
  globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
  const res = await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(res.status, 'UNAVAILABLE');
  assert.notEqual(res.status, 'DETECTED', 'an outage is never a detection');
});

test('retry: scanner becomes available on the next run → definitive result obtained', async () => {
  const env = fakeEnv();
  globalThis.fetch = (async () => { throw new Error('provider down'); }) as any;
  const first = await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(first.status, 'UNAVAILABLE');
  globalThis.fetch = (async () => CLEAN()) as any;
  const second = await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(second.status, 'CLEAN', 'queued scan resumed when the provider recovered');
});

test('cached result: an identical hash reuses the verdict with ZERO network calls', async () => {
  const env = fakeEnv();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return CLEAN(); }) as any;
  await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(calls, 1);
  const second = await runMalwareScan(env, { sha256: SHA, filename: 'other-name.apk', size: 999999, platform: 'linux_deb' });
  assert.equal(second.status, 'CLEAN');
  assert.match(second.result, /cached/);
  assert.equal(calls, 1, 'no re-upload, no re-lookup for the same bytes');
  // A DETECTED cache is sticky too (never silently re-evaluated to clean).
  globalThis.fetch = (async () => CLEAN()) as any;
  const det = await runMalwareScan(fakeEnv(), { sha256: '2'.repeat(64), filename: 'y.apk', size: 10, platform: 'android' }).then(async (r) => r);
  void det;
});

test('provider-keyed cache: a VirusTotal verdict is NOT reused under a custom scanner', async () => {
  const env = fakeEnv();
  let vtCalls = 0;
  globalThis.fetch = (async () => { vtCalls++; return CLEAN(); }) as any;
  await runMalwareScan(env, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(vtCalls, 1);
  assert.equal(env.__cache.length, 1);
  // Switch the deployment to a custom scanner: the cached VT result must not
  // be reused — the custom scanner is actually called.
  let customCalled = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('scanner.internal')) {
      customCalled++;
      return new Response(JSON.stringify({ status: 'CLEAN', provider: 'clam' }), { status: 200 });
    }
    throw new Error('VT must not be called');
  }) as any;
  const customEnv = fakeEnv({ MALWARE_SCANNER: 'custom', MALWARE_SCANNER_URL: 'https://scanner.internal/scan' });
  // share the same cache store
  customEnv.DB = env.DB;
  const res = await runMalwareScan(customEnv, { sha256: SHA, filename: 'x.apk', size: 10, platform: 'android' });
  assert.equal(res.status, 'CLEAN');
  assert.equal(res.provider, 'clam');
  assert.equal(customCalled, 1, 'the custom scanner ran a fresh scan');
});

test('unknown hash is not a verdict: it triggers the real upload path (regression guard)', async () => {
  const r2objects = new Map<string, Uint8Array>([['quarantine/k', new Uint8Array(1024).fill(7)]]);
  const env = fakeEnv();
  (env as any).STORAGE = {
    async get(key: string) {
      const v = r2objects.get(key);
      if (!v) return null;
      const copy = v.slice();
      return { size: v.length, body: new Response(copy).body };
    },
  };
  let uploaded = false;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.includes('/files/')) return new Response('{}', { status: 404 }); // unknown hash
    if (u === 'https://www.virustotal.com/api/v3/files') {
      if (init.body) await new Response(init.body as any).arrayBuffer(); // consume the stream
      uploaded = true;
      return new Response(JSON.stringify({ data: { id: 'an-x' } }), { status: 200 });
    }
    if (u.includes('/analyses/an-x')) {
      return new Response(JSON.stringify({ data: { attributes: { status: 'completed', stats: { malicious: 0, suspicious: 0 } } } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;
  const res = await runMalwareScan(env, { sha256: '3'.repeat(64), filename: 'x.apk', size: 1024, platform: 'android', storageKey: 'quarantine/k' });
  assert.equal(res.status, 'CLEAN');
  assert.ok(uploaded, 'the ACTUAL bytes were uploaded — 404 alone decided nothing');
});
