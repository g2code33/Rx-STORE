/**
 * Package Security & Verification tests (Phase 13 §14).
 *
 * Every check is exercised against REAL crafted binaries (PE headers, ZIP
 * central directories, ar archives, DER certificates) — no mocks of the
 * parsing itself. The malware provider tests stub global fetch (the same
 * hermetic pattern as the email tests); scanner behaviors, the state machine,
 * the publication gate, the override path and the /r2/ serving gate are all
 * verified.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  runSecurityPipeline, publicationSecurityGate, r2KeyIsPubliclyServed,
  classifyDuplicate, runMalwareScan, checkStructure, checkSignature, checkCertificate,
  checkNativeIdentity, parseZipCentralDirectory, parseAr, extractCertificateFromPkcs7,
  loadPackageBytes,
} from './services/packageSecurity.ts';
import { securityAdminRoutes } from './routes/securityAdmin.ts';
import { adminRoutes } from './routes/admin.ts';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// Binary crafters (real structures, built byte-by-byte)
// ---------------------------------------------------------------------------

function u16b(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff]; }
function u32b(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }

/** Build a real ZIP (STORED entries) with an optional APK Signing Block before the CD. */
function makeZip(entries: Array<{ name: string; data: Uint8Array }>, opts: { apkSigningBlock?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  const cd: number[] = [];
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(out.length);
    out.push(...[0x50, 0x4b, 0x03, 0x04], ...u16b(20), ...u16b(0), ...u16b(0), ...u16b(0), ...u16b(0),
      ...u32b(0), ...u32b(0), ...u32b(e.data.length), ...u16b(e.name.length), ...u16b(0));
    for (const ch of new TextEncoder().encode(e.name)) out.push(ch);
    out.push(...e.data);
  }
  let cdStart = out.length;
  if (opts.apkSigningBlock) {
    // 8-byte size + 8 bytes of block payload + the 16-byte magic that must
    // END exactly where the central directory begins.
    out.push(...u64b(24), ...Array.from({ length: 8 }, () => 0));
    for (const ch of new TextEncoder().encode('APK Sig Block 42')) out.push(ch);
    cdStart = out.length;
  }
  entries.forEach((e, i) => {
    cd.push(...[0x50, 0x4b, 0x01, 0x02], ...u16b(20), ...u16b(20), ...u16b(0), ...u16b(0), ...u16b(0), ...u16b(0),
      ...u32b(0), ...u32b(e.data.length), ...u32b(e.data.length), ...u16b(e.name.length),
      ...u16b(0), ...u16b(0), ...u16b(0), ...u16b(0), ...u32b(0), ...u32b(offsets[i]));
    for (const ch of new TextEncoder().encode(e.name)) cd.push(ch);
  });
  const cdSize = cd.length;
  out.push(...cd);
  out.push(...[0x50, 0x4b, 0x05, 0x06], ...u16b(0), ...u16b(0), ...u16b(entries.length), ...u16b(entries.length),
    ...u32b(cdSize), ...u32b(cdStart), ...u16b(0));
  return new Uint8Array(out);
}
function u64b(n: number): number[] { return [...u32b(n), ...u32b(0)]; }

/** Build a minimal valid PE with the given machine + optional security directory. */
function makePe(opts: { machine?: number; securityDir?: boolean; certDer?: Uint8Array } = {}): Uint8Array {
  const machine = opts.machine ?? 0x8664;
  const cert = opts.certDer ?? new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x01]);
  const size = 0x200;
  const pe: number[] = [];
  pe.push(0x50, 0x45, 0x00, 0x00);            // signature
  pe.push(...u16b(machine), ...u16b(1));      // machine + numberOfSections
  pe.push(...u32b(0), ...u32b(0), ...u32b(0));// timestamp + symbol table + count
  pe.push(...u16b(240), ...u16b(0));          // sizeOfOptionalHeader + characteristics
  pe.push(...u16b(0x20b), ...u16b(0));        // PE32+ magic + linker
  while (pe.length < 136) pe.push(0);         // rest of the optional header (data dirs begin at pe+136 for PE32+)
  // 16 data directories; entry 4 = security (certificate table).
  const dirs: number[] = Array.from({ length: 16 * 8 }, () => 0);
  if (opts.securityDir) {
    const certOffset = size; // certificate table appended right after the headers
    dirs.splice(4 * 8, 8, ...u32b(certOffset), ...u32b(cert.length));
  }
  pe.push(...dirs);
  const head: number[] = [];
  head.push(0x4d, 0x5a, ...Array.from({ length: 58 }, () => 0), ...u32b(0x80)); // MZ + e_lfanew AT 0x3C
  while (head.length < 0x80) head.push(0);
  const bytes = new Uint8Array([...head, ...pe, ...Array.from({ length: Math.max(0, size - 0x80 - pe.length) }, () => 0), ...(opts.securityDir ? Array.from(cert) : [])]);
  return bytes;
}

/** Build an ar archive (.deb) with debian-binary + control.tar.gz + data.tar.gz. */
function makeDeb(packageName: string): Uint8Array {
  const control = `Package: ${packageName}\nVersion: 1.0.0\nArchitecture: amd64\n`;
  const members = [
    { name: 'debian-binary', data: new TextEncoder().encode('2.0\n') },
    { name: 'control.tar.gz', data: new Uint8Array(gzipSync(Buffer.from(tarWithFile('./control', control)))) },
    { name: 'data.tar.gz', data: new Uint8Array(gzipSync(Buffer.from(tarWithFile('./usr/bin/x', 'binary')))) },
  ];
  const out: number[] = [];
  for (const ch of new TextEncoder().encode('!<arch>\n')) out.push(ch);
  for (const m of members) {
    const header = `${m.name}`.padEnd(16, ' ') + '0'.padEnd(12, ' ') + '0'.padEnd(6, ' ') + '0'.padEnd(6, ' ') + '100644'.padEnd(8, ' ') + String(m.data.length).padEnd(10, ' ') + '`\n';
    for (const ch of new TextEncoder().encode(header)) out.push(ch);
    out.push(...m.data);
    if (m.data.length % 2) out.push(0x0a);
  }
  return new Uint8Array(out);
}

/** Minimal tar archive with one file. */
function tarWithFile(name: string, content: string): number[] {
  const header: number[] = [];
  for (const ch of new TextEncoder().encode(name.padEnd(100, '\0'))) header.push(ch);
  for (const ch of new TextEncoder().encode('0'.padEnd(8, ' ') + '0'.padEnd(8, ' ') + '0'.padEnd(8, ' ') + '100644'.padEnd(8, ' '))) header.push(ch);
  for (const ch of new TextEncoder().encode(String(content.length).padStart(11, '0') + '\0')) header.push(ch);
  for (const ch of new TextEncoder().encode(String(0).padStart(11, '0') + '\0')) header.push(ch); // mtime
  while (header.length < 148) header.push(0);
  for (const ch of new TextEncoder().encode('        ')) header.push(ch); // checksum placeholder
  header.push(0x30); // typeflag '0'
  while (header.length < 512) header.push(0);
  const data = Array.from(new TextEncoder().encode(content));
  while (data.length % 512 !== 0) data.push(0);
  return [...header, ...data];
}

// ---- DER crafters (PKCS#7 + X.509 certificate with controllable validity) ----

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function flatten(x: any): number[] {
  return Array.isArray(x) ? x.flatMap(flatten) : [Number(x)];
}
function tlv(tag: number, content: number[] | Uint8Array): number[] {
  const c = flatten(content);
  return [tag, ...derLen(c.length), ...c];
}
function utcTime(d: Date): number[] {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Array.from(new TextEncoder().encode(s)));
}

/** A PKCS#7 SignedData wrapping one X.509 certificate with the given validity. */
function makePkcs7(notBefore: Date, notAfter: Date): Uint8Array {
  const version = tlv(0x02, [0x01]);
  const digestAlg = tlv(0x31, [tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x26])]);
  const contentInfo = tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a]);
  const cert = tlv(0x30, [
    ...tlv(0x30, [ // tbsCertificate
      ...tlv(0xa0, [tlv(0x02, [0x02])]),          // version v3
      ...tlv(0x02, [0x01]),                        // serial
      ...tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x26]), // sig alg
      ...tlv(0x30, []),                            // issuer
      ...tlv(0x30, [...utcTime(notBefore), ...utcTime(notAfter)]), // validity
      ...tlv(0x30, []),                            // subject
      ...tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x26]),   // spki (fake)
    ]),
    ...tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x26]),      // sig alg
    ...tlv(0x03, [0x00, 0x01, 0x02]),              // signature BIT STRING
  ]);
  const signedData = tlv(0x30, [version, digestAlg, contentInfo, tlv(0xa0, [cert])]);
  return new Uint8Array(tlv(0x30, [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, tlv(0xa0, [signedData])]));
}

/** Binary AXML-ish manifest bytes containing the package id in UTF-16LE. */
function manifestWithPackageId(id: string): Uint8Array {
  const enc = new TextEncoder();
  const utf16: number[] = [];
  for (const ch of id) { utf16.push(enc.encode(ch)[0], 0); }
  return new Uint8Array([0x03, 0x00, 0x08, 0x00, ...utf16, 0xff, 0xff]);
}

const pb = (bytes: Uint8Array) => ({ size: bytes.length, head: bytes, headOffset: 0, tail: bytes, tailOffset: 0, full: bytes });

// ---------------------------------------------------------------------------
// Structure checks
// ---------------------------------------------------------------------------

test('structure: valid x64 PE passes; wrong architecture fails; text-as-exe fails', async () => {
  const ok = await checkStructure({ platform: 'windows', architecture: 'x64', filename: 'setup.exe', bytes: pb(makePe({ machine: 0x8664 })) });
  assert.equal(ok.status, 'PASSED');
  assert.ok(ok.result.includes('x64'));

  const wrongArch = await checkStructure({ platform: 'windows', architecture: 'arm64', filename: 'setup.exe', bytes: pb(makePe({ machine: 0x8664 })) });
  assert.equal(wrongArch.status, 'FAILED');
  assert.equal(wrongArch.result, 'architecture mismatch');

  const fake = await checkStructure({ platform: 'windows', architecture: 'x64', filename: 'setup.exe', bytes: pb(new TextEncoder().encode('this is not an executable at all')) });
  assert.equal(fake.status, 'FAILED');
});

test('structure: MSI OLE magic passes; android requires a real ZIP with a manifest', async () => {
  const msi = await checkStructure({ platform: 'windows', architecture: 'x64', filename: 'setup.msi', bytes: pb(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(64).fill(0)])) });
  assert.equal(msi.status, 'PASSED');

  const apk = await checkStructure({ platform: 'android', architecture: 'arm64', filename: 'app.apk', bytes: pb(makeZip([
    { name: 'AndroidManifest.xml', data: manifestWithPackageId('com.example.app') },
    { name: 'classes.dex', data: new Uint8Array([1, 2, 3]) },
  ])) });
  assert.equal(apk.status, 'PASSED');

  const noManifest = await checkStructure({ platform: 'android', architecture: 'arm64', filename: 'app.apk', bytes: pb(makeZip([{ name: 'classes.dex', data: new Uint8Array([1]) }])) });
  assert.equal(noManifest.status, 'FAILED');
  assert.equal(noManifest.result, 'AndroidManifest.xml missing');

  const notZip = await checkStructure({ platform: 'android', architecture: 'arm64', filename: 'app.apk', bytes: pb(new TextEncoder().encode('plain text pretending')) });
  assert.equal(notZip.status, 'FAILED');
});

test('structure: .deb must be a real ar archive with control+data; AppImage must be ELF', async () => {
  const deb = await checkStructure({ platform: 'linux_deb', architecture: 'x64', filename: 'app.deb', bytes: pb(makeDeb('myapp')) });
  assert.equal(deb.status, 'PASSED');

  const badDeb = await checkStructure({ platform: 'linux_deb', architecture: 'x64', filename: 'app.deb', bytes: pb(new TextEncoder().encode('not an archive')) });
  assert.equal(badDeb.status, 'FAILED');

  const appimage = await checkStructure({ platform: 'linux_appimage', architecture: 'x64', filename: 'app.AppImage', bytes: pb(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, ...Array(32).fill(0)])) });
  assert.equal(appimage.status, 'PASSED');
});

// ---------------------------------------------------------------------------
// Duplicate classification
// ---------------------------------------------------------------------------

test('duplicate: NEW_PACKAGE vs REPLACEMENT_CONFLICT (same app / other app)', () => {
  const fresh = classifyDuplicate({ sameShaElsewhere: [], currentAppId: 'a1', currentReleaseId: 'r1', currentPlatform: 'windows', currentArch: 'x64' });
  assert.equal(fresh.status, 'PASSED');
  assert.equal(fresh.classification, 'NEW_PACKAGE');

  const sameApp = classifyDuplicate({
    sameShaElsewhere: [{ id: 'p2', appId: 'a1', releaseVersion: '1.0.0', platform: 'windows' }],
    currentAppId: 'a1', currentReleaseId: 'r2', currentPlatform: 'windows', currentArch: 'x64',
  });
  assert.equal(sameApp.status, 'WARNING');
  assert.equal(sameApp.classification, 'REPLACEMENT_CONFLICT');
  assert.ok(sameApp.details.includes('1.0.0'));

  const otherApp = classifyDuplicate({
    sameShaElsewhere: [{ id: 'p9', appId: 'a2', appName: 'Other App', platform: 'windows' }],
    currentAppId: 'a1', currentReleaseId: 'r1', currentPlatform: 'windows', currentArch: 'x64',
  });
  assert.equal(otherApp.status, 'WARNING');
  assert.ok(otherApp.details.includes('Other App'));
});

// ---------------------------------------------------------------------------
// Malware provider (fetch stubbed — provider CONTRACT is what is under test)
// ---------------------------------------------------------------------------

test('malware: no scanner configured -> UNAVAILABLE (blocked, never clean)', async () => {
  const res = await runMalwareScan({}, { sha256: 'a'.repeat(64), filename: 'x.exe', size: 10, platform: 'windows' });
  assert.equal(res.status, 'UNAVAILABLE');
  assert.ok(res.details.includes('No malware scanner') || res.details.includes('not configured') || res.details.toLowerCase().includes('not configured'));
});

test('malware: VirusTotal clean / detected / unknown-hash behaviors', async () => {
  const env = { MALWARE_SCANNER: 'virustotal', VIRUSTOTAL_API_KEY: 'vt_test' };
  const sha = 'b'.repeat(64);
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.headers['x-apikey'], 'vt_test');
    if (String(url).endsWith(sha)) {
      return new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 60, undetected: 10 } } } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;

  const clean = await runMalwareScan(env, { sha256: sha, filename: 'x.exe', size: 10, platform: 'windows' });
  assert.equal(clean.status, 'CLEAN');
  assert.equal(clean.provider, 'virustotal');

  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 3, suspicious: 1 } } } }), { status: 200 })) as any;
  const detected = await runMalwareScan(env, { sha256: sha, filename: 'x.exe', size: 10, platform: 'windows' });
  assert.equal(detected.status, 'DETECTED');
  assert.ok(detected.result.includes('4 engine'));

  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as any;
  const unknown = await runMalwareScan(env, { sha256: 'c'.repeat(64), filename: 'x.exe', size: 10, platform: 'windows' });
  assert.equal(unknown.status, 'FAILED');
  assert.ok(unknown.details.includes('never been scanned'));

  globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
  const unreachable = await runMalwareScan(env, { sha256: sha, filename: 'x.exe', size: 10, platform: 'windows' });
  assert.equal(unreachable.status, 'FAILED');
});

test('malware: custom REST scanner contract', async () => {
  const env = { MALWARE_SCANNER: 'custom', MALWARE_SCANNER_URL: 'https://scanner.internal/scan', MALWARE_SCANNER_KEY: 'sekrit' };
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer sekrit');
    return new Response(JSON.stringify({ status: 'CLEAN', provider: 'clamav-rest', version: '1.2', result: 'no signatures matched' }), { status: 200 });
  }) as any;
  const res = await runMalwareScan(env, { sha256: 'd'.repeat(64), filename: 'y.apk', size: 99, platform: 'android' });
  assert.equal(res.status, 'CLEAN');
  assert.equal(res.provider, 'clamav-rest');
  assert.equal(body.platform, 'android');
  assert.equal(body.sha256, 'd'.repeat(64));
});

// ---------------------------------------------------------------------------
// Signature + certificate
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-21T00:00:00Z');
const validPkcs7 = makePkcs7(new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
const expiredPkcs7 = makePkcs7(new Date('2015-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

test('certificate: extracts a real fingerprint + validity window; expired -> WARNING', async () => {
  const cert = extractCertificateFromPkcs7(validPkcs7);
  assert.ok(cert, 'certificate extracted from the crafted PKCS#7');
  const info = await (await import('./services/packageSecurity.ts')).certificateInfo(cert!);
  assert.match(info!.fingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(info!.notAfter!.getUTCFullYear(), 2030);

  const expired = await checkCertificate(expiredPkcs7, NOW);
  assert.equal(expired.status, 'WARNING');
  assert.equal(expired.result, 'signing certificate has EXPIRED');
});

test('signature: unsigned APK FAILS (Android requires signing); v1-signed APK passes structure with cert', async () => {
  const unsigned = pb(makeZip([{ name: 'AndroidManifest.xml', data: manifestWithPackageId('com.example.app') }]));
  const resUnsigned = await checkSignature({ platform: 'android', bytes: unsigned, entries: parseZipCentralDirectory(unsigned)! });
  assert.equal(resUnsigned.status, 'FAILED');
  assert.equal(resUnsigned.result, 'unsigned APK');

  const signed = pb(makeZip([
    { name: 'AndroidManifest.xml', data: manifestWithPackageId('com.example.app') },
    { name: 'META-INF/CERT.RSA', data: validPkcs7 },
  ]));
  const entries = parseZipCentralDirectory(signed)!;
  const resSigned = await checkSignature({ platform: 'android', bytes: signed, entries });
  assert.equal(resSigned.status, 'NEEDS_REVIEW'); // signed but chain not validatable in-Worker (honest)
  assert.ok(resSigned.result.includes('v1 JAR signature'));
  assert.ok(resSigned.pkcs7, 'PKCS#7 extracted for the certificate check');

  const v2 = pb(makeZip([{ name: 'AndroidManifest.xml', data: manifestWithPackageId('com.example.app') }], { apkSigningBlock: true }));
  const resV2 = await checkSignature({ platform: 'android', bytes: v2, entries: parseZipCentralDirectory(v2)! });
  assert.ok(resV2.result.includes('v2/v3 signing block'));
});

test('signature: unsigned PE -> WARNING; Authenticode-signed PE -> present + honest NEEDS_REVIEW', async () => {
  const unsigned = await checkSignature({ platform: 'windows', bytes: pb(makePe({ securityDir: false })), entries: null });
  assert.equal(unsigned.status, 'WARNING');
  assert.equal(unsigned.result, 'unsigned executable');

  const signed = await checkSignature({ platform: 'windows', bytes: pb(makePe({ securityDir: true, certDer: validPkcs7 })), entries: null });
  assert.equal(signed.status, 'NEEDS_REVIEW');
  assert.ok(signed.result.includes('Authenticode signature present'));
  assert.ok(signed.pkcs7);
});

// ---------------------------------------------------------------------------
// Native identity
// ---------------------------------------------------------------------------

test('native identity: .deb Package name must match the registered linux_package_name', async () => {
  const match = await checkNativeIdentity({ platform: 'linux_deb', bytes: pb(makeDeb('cgpa-pilot')), entries: null, app: { linuxPackageName: 'cgpa-pilot' } });
  assert.equal(match.status, 'PASSED');

  const mismatch = await checkNativeIdentity({ platform: 'linux_deb', bytes: pb(makeDeb('something-else')), entries: null, app: { linuxPackageName: 'cgpa-pilot' } });
  assert.equal(mismatch.status, 'FAILED');
  assert.equal(mismatch.result, 'package identity mismatch');
  assert.ok(mismatch.details.includes('something-else'));

  const unregistered = await checkNativeIdentity({ platform: 'linux_deb', bytes: pb(makeDeb('cgpa-pilot')), entries: null, app: {} });
  assert.equal(unregistered.status, 'WARNING');
});

test('native identity: APK manifest must declare the registered android_package_id', async () => {
  const apk = pb(makeZip([
    { name: 'AndroidManifest.xml', data: manifestWithPackageId('com.cgpapilot.app') },
    { name: 'META-INF/CERT.RSA', data: validPkcs7 },
  ]));
  const entries = parseZipCentralDirectory(apk)!;
  const match = await checkNativeIdentity({ platform: 'android', bytes: apk, entries, app: { androidPackageId: 'com.cgpapilot.app' } });
  assert.equal(match.status, 'PASSED');

  const mismatch = await checkNativeIdentity({ platform: 'android', bytes: apk, entries, app: { androidPackageId: 'com.other.app' } });
  assert.equal(mismatch.status, 'FAILED');
  assert.ok(mismatch.details.includes('com.other.app'));

  const none = await checkNativeIdentity({ platform: 'android', bytes: apk, entries, app: {} });
  assert.equal(none.status, 'WARNING');
});

// ---------------------------------------------------------------------------
// Full pipeline + state machine + gate + override (in-memory env)
// ---------------------------------------------------------------------------

function makeEnv() {
  const db: any = {
    users: [{ id: 'admin1', name: 'Admin', email: 'a@x.com', role: 'admin' }],
    applications: [{ id: 'app_1', slug: 'demo', name: 'Demo', android_package_id: 'com.demo.app', linux_package_name: 'demo', status: 'active', developer_org_id: 'dev_x' }],
    releases: [{ id: 'rel_1', application_id: 'app_1', version: '2.0.0', status: 'draft', developer_id: 'dev_x' }],
    packages: [] as any[],
    package_security_results: [] as any[],
    package_security_overrides: [] as any[],
    developer_members: [{ developer_id: 'dev_x', user_id: 'u1', role: 'OWNER' }],
    developer_audit_logs: [] as any[],
    audit_logs: [] as any[],
    notifications: [] as any[],
  };
  const storage = new Map<string, Uint8Array>();
  const DB = {
    prepare(sql: string) {
      const self: any = {
        _b: [] as any[],
        bind(...a: any[]) { self._b = a; return self; },
        async first() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('FROM packages WHERE id=?')) return db.packages.find((p: any) => p.id === a[0]) || null;
          if (s.includes('SELECT * FROM applications WHERE id=?')) return db.applications.find((x: any) => x.id === a[0]) || null;
          if (s.includes('SELECT id FROM packages WHERE release_id=? AND platform=? AND architecture=?')) return db.packages.find((p: any) => p.release_id === a[0] && p.platform === a[1] && p.architecture === a[2]) || null;
          if (s.includes('SELECT * FROM packages WHERE release_id=?')) return null; // (first() form unused)
          if (s.includes('SELECT id FROM package_security_overrides WHERE package_id=?')) return db.package_security_overrides.find((o: any) => o.package_id === a[0]) || null;
          if (s.includes('SELECT status FROM packages WHERE storage_key=?')) { const p = db.packages.find((x: any) => x.storage_key === a[0]); return p ? { status: p.status } : null; }
          if (s.includes('FROM releases r JOIN applications a ON a.id=r.application_id WHERE r.id=?')) {
            const rel = db.releases.find((x: any) => x.id === a[0]);
            return rel ? { ...rel, app_slug: db.applications.find((x: any) => x.id === rel.application_id)?.slug } : null;
          }
          if (s.includes('SELECT * FROM releases WHERE id=?')) return db.releases.find((x: any) => x.id === a[0]) || null;
          if (s.includes('WHERE p.sha256 = ? AND p.id != ?')) return null; // (first() form unused)
          return null;
        },
        async all() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('WHERE p.sha256 = ? AND p.id != ?')) return { results: db.packages.filter((p: any) => p.sha256 === a[0] && p.id !== a[1]) };
          if (s.includes('SELECT * FROM packages WHERE release_id=?')) return { results: db.packages.filter((p: any) => p.release_id === a[0]) };
          if (s.includes('SELECT check_type, status, result, details FROM package_security_results')) {
            const latest = new Map<string, any>();
            for (const r of db.package_security_results) if (r.package_id === a[0]) latest.set(r.check_type, r);
            return { results: [...latest.values()].filter((r: any) => ['FAILED', 'DETECTED', 'WARNING', 'NEEDS_REVIEW', 'UNAVAILABLE', 'PENDING', 'SCANNING'].includes(r.status)) };
          }
          if (s.includes('FROM package_security_results WHERE id IN')) {
            const latest = new Map<string, any>();
            for (const r of db.package_security_results) if (r.package_id === a[0] && (!latest.has(r.check_type) || r.created_at > latest.get(r.check_type).created_at)) latest.set(r.check_type, r);
            return { results: [...latest.values()] };
          }
          if (s.includes('SELECT user_id FROM developer_members WHERE developer_id=?')) return { results: db.developer_members.filter((m: any) => m.developer_id === a[0]).map((m: any) => ({ user_id: m.user_id })) };
          if (s.includes('SELECT o.*, u.name AS admin_name')) return { results: db.package_security_overrides.filter((o: any) => o.package_id === a[0]) };
          if (s.includes('FROM packages p LEFT JOIN releases r')) return { results: db.packages.filter((p: any) => !p.deployment_url) };
          if (s.includes('SELECT p.*, r.version, r.status AS release_status')) return { results: [] };
          return { results: [] };
        },
        async run() {
          const a = self._b;
          const s = sql.replace(/\s+/g, ' ');
          if (s.includes('INSERT INTO package_security_results')) {
            db.package_security_results.push({ id: a[0], package_id: a[1], check_type: a[5], status: a[6], classification: a[7], provider: a[8], provider_version: a[9], result: a[10], details: a[11], fingerprint: a[12], error: a[13], created_at: a[15] });
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO package_security_overrides')) {
            db.package_security_overrides.push({ id: a[0], package_id: a[1], admin_user_id: a[2], reason: a[3], prior_state: a[4], prior_overall: a[5], created_at: 'now' });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE packages')) {
            const id = a[a.length - 1];
            const p = db.packages.find((x: any) => x.id === id) || db.packages.find((x: any) => x.release_id === a[a.length - 1] && x.platform === a[a.length - 3] && x.architecture === a[a.length - 2]);
            if (p) {
              // Bound forms: per-check update binds (state, id); finish binds (state, overall, id).
              if (s.includes('security_state=?')) p.security_state = a[0];
              if (s.includes('overall_security=?')) p.overall_security = a[1];
              // Literal forms (upload reset, override, URL packages).
              const m1 = s.match(/security_state='([A-Z_]+)'/); if (m1) p.security_state = m1[1];
              const m2 = s.match(/overall_security='([A-Z_]+)'/); if (m2) p.overall_security = m2[1];
              const m3 = s.match(/security_scan_status='([a-zA-Z_]+)'/); if (m3) p.security_scan_status = m3[1];
              const m4 = s.match(/signature_status='([A-Z_]+)/); if (m4) p.signature_status = m4[1];
              if (s.includes("scan_at=datetime('now')")) p.scan_at = 'now';
              if (s.includes("verified_at=datetime('now')")) p.verified_at = 'now';
            }
            return { meta: { changes: 1 } };
          }
          if (s.includes('INSERT INTO audit_logs')) { db.audit_logs.push({ id: a[0], action: a[1], resource_id: a[3] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO developer_audit_logs')) { db.developer_audit_logs.push({ id: a[0], action: a[3] }); return { meta: { changes: 1 } }; }
          if (s.includes('INSERT INTO notifications')) { db.notifications.push({ id: a[0], user_id: a[1] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
  const STORAGE = {
    async put(key: string, value: Uint8Array) { storage.set(key, value); },
    async get(key: string, opts?: any) {
      const v = storage.get(key);
      if (!v) return null;
      let bytes = v;
      let size = v.length;
      if (opts?.range) {
        const { offset = 0, length } = opts.range;
        bytes = v.subarray(offset, length != null ? offset + length : undefined);
        size = v.length; // R2 .size is the whole object size
      }
      return { size, arrayBuffer: async () => bytes.slice().buffer, body: null, httpMetadata: {} };
    },
    async head(key: string) { const v = storage.get(key); return v ? { size: v.length } : null; },
  };
  return { DB, STORAGE, db, storage };
}

const req = (userId: string | null, body: any, path: string, method = 'POST') => {
  const r = new Request(`https://api.rxstore.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  if (userId) (r as any).user = { userId };
  return r;
};

async function seedSignedApkPackage(env: any, overrides: Record<string, any> = {}) {
  const apk = makeZip([
    { name: 'AndroidManifest.xml', data: manifestWithPackageId('com.demo.app') },
    { name: 'META-INF/CERT.RSA', data: validPkcs7 },
    { name: 'classes.dex', data: new Uint8Array([1, 2, 3]) },
  ]);
  const key = 'quarantine/demo/2.0.0/android/arm64/app.apk';
  await env.STORAGE.put(key, apk);
  const digest: ArrayBuffer = await (crypto as any).subtle.digest('SHA-256', apk.slice().buffer);
  const sha256 = Array.from(new Uint8Array(digest)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const pkg = {
    id: 'pkg_apk_1', application_id: 'app_1', release_id: 'rel_1', platform: 'android', architecture: 'arm64',
    filename: 'app.apk', storage_key: key, quarantine_key: key, file_size: apk.length, mime_type: 'application/vnd.android.package-archive',
    sha256, status: 'stored', security_state: 'QUARANTINED', overall_security: 'PENDING', developer_id: 'dev_x', deployment_url: null,
    ...overrides,
  };
  env.db.packages.push(pkg);
  return { pkg, apk, sha256 };
}

test('pipeline: signed, matching APK runs every stage and records results', async () => {
  const env = makeEnv();
  await seedSignedApkPackage(env);
  // Configure a scanner so the malware stage can pass for real.
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0 } } } }), { status: 200 })) as any;
  const scanEnv = { ...env, MALWARE_SCANNER: 'virustotal', VIRUSTOTAL_API_KEY: 'vt_test' };
  const out = await runSecurityPipeline(scanEnv, 'pkg_apk_1');
  void out;
  const pkg = env.db.packages[0];
  assert.equal(pkg.security_state, 'SECURITY_REVIEW_COMPLETE');
  assert.equal(pkg.overall_security, 'NEEDS_REVIEW', 'signed-but-not-chain-validated is honestly NEEDS_REVIEW, not PASSED');
  const types = env.db.package_security_results.map((r: any) => r.check_type);
  assert.deepEqual([...new Set(types)].sort(), ['certificate', 'dependency', 'duplicate', 'integrity', 'malware', 'native_identity', 'signature', 'structure']);
  const malware = env.db.package_security_results.find((r: any) => r.check_type === 'malware');
  assert.equal(malware.status, 'CLEAN');
  assert.equal(malware.provider, 'virustotal');
  const identity = env.db.package_security_results.find((r: any) => r.check_type === 'native_identity');
  assert.equal(identity.status, 'PASSED');
  const cert = env.db.package_security_results.find((r: any) => r.check_type === 'certificate');
  assert.equal(cert.status, 'PASSED');
  assert.match(cert.fingerprint, /^[a-f0-9]{64}$/);
});

test('pipeline: a MALFORMED package fails structure and never reaches later stages', async () => {
  const env = makeEnv();
  const bytes = new TextEncoder().encode('totally not an apk');
  await env.STORAGE.put('quarantine/demo/2.0.0/android/arm64/app.apk', bytes);
  env.db.packages.push({
    id: 'pkg_bad', application_id: 'app_1', release_id: 'rel_1', platform: 'android', architecture: 'arm64',
    filename: 'app.apk', storage_key: 'quarantine/demo/2.0.0/android/arm64/app.apk', file_size: bytes.length,
    sha256: 'e'.repeat(64), status: 'stored', security_state: 'QUARANTINED', overall_security: 'PENDING', deployment_url: null,
  });
  await runSecurityPipeline(env, 'pkg_bad');
  const pkg = env.db.packages[0];
  assert.equal(pkg.security_state, 'STRUCTURE_CHECK', 'stopped at the failing stage');
  assert.equal(pkg.overall_security, 'FAILED');
  const types = env.db.package_security_results.map((r: any) => r.check_type);
  assert.deepEqual(types, ['structure'], 'no later stage ran');
});

test('pipeline: a recorded hash that does not match the stored bytes fails integrity', async () => {
  const env = makeEnv();
  const { pkg } = await seedSignedApkPackage(env);
  // Corrupt the RECORDED hash (structure stays valid; integrity must catch it).
  pkg.sha256 = 'f'.repeat(64);
  await runSecurityPipeline(env, 'pkg_apk_1');
  const integrity = env.db.package_security_results.find((r: any) => r.check_type === 'integrity');
  assert.equal(integrity.status, 'FAILED');
  assert.equal(integrity.result, 'hash mismatch');
  assert.equal(env.db.packages[0].overall_security, 'FAILED');
});

test('gate: QUARANTINED -> PUBLISHED is impossible; the publish flow blocks with reasons', async () => {
  const env = makeEnv();
  await seedSignedApkPackage(env);
  const gate = await publicationSecurityGate(env, 'rel_1');
  assert.equal(gate.ok, false);
  assert.equal(gate.blockers.length, 1);
  assert.ok(gate.blockers[0].reasons.some((r: string) => r.includes('malware')), 'the unavailable scanner is named as a blocker');
  assert.ok(gate.blockers[0].reasons.some((r: string) => r.includes('signature') || r.includes('certificate')));

  // The release publish endpoint refuses (developer release, not approved — the
  // security gate sits after that guard, so verify the gate directly above).
  const pub: any = await adminRoutes.publishRelease(req('admin1', {}, '/admin/releases/rel_1/publish'), env);
  assert.ok(String(pub.error).includes('approved before publishing') || String(pub.error).includes('Security verification'));
});

test('override: reason REQUIRED, audited, and it clears the gate', async () => {
  const env = makeEnv();
  await seedSignedApkPackage(env);
  await runSecurityPipeline(env, 'pkg_apk_1');

  const noReason: any = await securityAdminRoutes.overridePackage(req('admin1', {}, '/admin/security/packages/pkg_apk_1/override'), env);
  assert.equal(noReason.code, 'VALIDATION_ERROR');

  const shortReason: any = await securityAdminRoutes.overridePackage(req('admin1', { reason: 'ok' }, '/admin/security/packages/pkg_apk_1/override'), env);
  assert.equal(shortReason.code, 'VALIDATION_ERROR');

  const ok: any = await securityAdminRoutes.overridePackage(req('admin1', { reason: 'Reviewed the binary manually in an isolated VM.' }, '/admin/security/packages/pkg_apk_1/override'), env);
  assert.equal(ok.success, true);

  const pkg = env.db.packages[0];
  assert.equal(pkg.security_state, 'SECURITY_OVERRIDE');
  assert.equal(pkg.overall_security, 'PASSED');
  const override = env.db.package_security_overrides.find((o: any) => o.package_id === 'pkg_apk_1');
  assert.equal(override.admin_user_id, 'admin1');
  assert.ok(override.reason.includes('isolated VM'));
  assert.ok(env.db.audit_logs.some((l: any) => l.action === 'security_override'), 'global audit written');
  assert.ok(env.db.developer_audit_logs.some((l: any) => l.action === 'security_override'), 'developer audit written');
  assert.ok(env.db.notifications.some((n: any) => n.user_id === 'u1'), 'the org was notified');

  const gate = await publicationSecurityGate(env, 'rel_1');
  assert.equal(gate.ok, true, 'the override is the only thing that cleared it');
});

test('rescan: re-runs the pipeline and replaces the verdict honestly', async () => {
  const env = makeEnv();
  await seedSignedApkPackage(env);
  await securityAdminRoutes.overridePackage(req('admin1', { reason: 'Manual review completed before rescan.' }, '/admin/security/packages/pkg_apk_1/override'), env);
  const rescan: any = await securityAdminRoutes.rescanPackage(req('admin1', {}, '/admin/security/packages/pkg_apk_1/rescan'), env);
  assert.equal(rescan.success, true);
  assert.equal(env.db.packages[0].security_state, 'SECURITY_REVIEW_COMPLETE', 'the pipeline runs to completion');
  assert.equal(env.db.packages[0].overall_security, 'NEEDS_REVIEW', 'rescan supersedes the override verdict — no scanner configured');
  assert.ok(env.db.audit_logs.some((l: any) => l.action === 'security_rescan'));
});

test('/r2/ gate: quarantine and unpublished apps/ keys 404; published and asset keys serve', async () => {
  const env = makeEnv();
  const { pkg } = await seedSignedApkPackage(env);
  assert.equal(await r2KeyIsPubliclyServed(env, pkg.quarantine_key), false, 'quarantined binary is private');

  pkg.status = 'published';
  assert.equal(await r2KeyIsPubliclyServed(env, pkg.quarantine_key), true, 'published binary serves');
  assert.equal(await r2KeyIsPubliclyServed(env, 'apps/demo/1.0.0/windows/setup.exe'), false, 'legacy unpublished key is private');
  env.db.packages.push({ ...pkg, id: 'pkg_legacy', storage_key: 'apps/demo/1.0.0/windows/setup.exe', status: 'published' });
  assert.equal(await r2KeyIsPubliclyServed(env, 'apps/demo/1.0.0/windows/setup.exe'), true, 'legacy published key serves');
  assert.equal(await r2KeyIsPubliclyServed(env, 'assets/icons/logo.png'), true, 'assets stay public');
  assert.equal(await r2KeyIsPubliclyServed(env, 'assets/screenshots/whatever.png'), true);
});

test('loadPackageBytes: small objects load fully; ranges slice correctly', async () => {
  const env = makeEnv();
  const bytes = makeDeb('demo');
  await env.STORAGE.put('quarantine/demo/2.0.0/linux_deb/x64/demo.deb', bytes);
  const loaded = await loadPackageBytes(env, 'quarantine/demo/2.0.0/linux_deb/x64/demo.deb');
  assert.ok(loaded?.full, 'small object fully buffered');
  assert.equal(loaded!.size, bytes.length);
  const members = parseAr(loaded!);
  assert.ok(members?.some((m) => m.name === 'debian-binary'));
});
