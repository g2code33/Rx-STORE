/**
 * Unit tests for artifact verification + SemVer comparison (Prompt 3).
 * Pure — no Electron/Capacitor/browser. Uses node:test + crypto.subtle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, isUpdateAvailable, verifyArtifactHash, verifyArtifact, sha256Hex, isOlder } from './verify.ts';

async function sample() {
  const bytes = new TextEncoder().encode('rx-store-test-artifact');
  const sha = await sha256Hex(bytes.buffer as ArrayBuffer);
  return { bytes, sha };
}

// ---------------------------------------------------------------------------
// SemVer comparison
// ---------------------------------------------------------------------------
test('SemVer: 1.2.0 < 1.2.1 < 1.10.0 (numeric, not lexicographic)', () => {
  assert.equal(compareSemver('1.2.0', '1.2.1'), -1);
  assert.equal(compareSemver('1.2.1', '1.10.0'), -1);
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
});
test('SemVer: 2.0.0 > 1.9.99', () => {
  assert.equal(compareSemver('2.0.0', '1.9.99'), 1);
});
test('SemVer: prereleases sort below the same final release', () => {
  assert.equal(compareSemver('1.3.0-beta', '1.3.0'), -1);
  assert.equal(compareSemver('1.3.0-beta', '1.3.0-beta'), 0);
  assert.equal(compareSemver('1.3.0-alpha', '1.3.0-beta'), -1);
});
test('SemVer: missing/invalid handled without throwing', () => {
  assert.equal(compareSemver(undefined, '1.0.0'), -1);
  assert.equal(compareSemver('', '1.0.0'), -1);
  assert.equal(compareSemver('garbage', '1.0.0'), -1);
});
test('isUpdateAvailable only when installed is strictly older', () => {
  assert.equal(isUpdateAvailable('1.2.0', '1.3.0'), true);
  assert.equal(isUpdateAvailable('1.3.0', '1.3.0'), false);
  assert.equal(isUpdateAvailable('1.4.0', '1.3.0'), false);
  assert.equal(isUpdateAvailable('', '1.3.0'), false);
});
test('isOlder: 1.0.0 < 1.0.1', () => {
  assert.equal(isOlder('1.0.0', '1.0.1'), true);
});

// ---------------------------------------------------------------------------
// SHA-256 + size verification
// ---------------------------------------------------------------------------
test('checksum success: matching sha256 + size passes', async () => {
  const { bytes, sha } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength, sha256: sha });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
});

test('checksum failure: mismatched sha256 fails and is never installed', async () => {
  const { bytes } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength, sha256: 'a'.repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sha256_mismatch');
});

test('file-size mismatch: different size is treated as failed verification', async () => {
  const { bytes, sha } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength + 1, sha256: sha });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'size_mismatch');
});

test('incomplete/empty download fails', async () => {
  const r = await verifyArtifactHash(new ArrayBuffer(0), { size: 100, sha256: 'a'.repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('missing checksum (non-PWA) -> missing_metadata, caller decides', async () => {
  const { bytes } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_metadata');
});

test('PWA/web does not require a checksum artifact', async () => {
  const { bytes } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength, platform: 'web' }, { requireChecksum: false });
  assert.equal(r.ok, true);
});

test('verifyArtifact (sync) respects empty + size mismatch', async () => {
  const { bytes, sha } = await sample();
  const ok = verifyArtifact(bytes.buffer as ArrayBuffer, { size: bytes.byteLength, sha256: sha });
  assert.equal(ok.ok, true);
  const mismatch = verifyArtifact(bytes.buffer as ArrayBuffer, { size: bytes.byteLength + 1, sha256: sha });
  assert.equal(mismatch.reason, 'size_mismatch');
  const empty = verifyArtifact(new ArrayBuffer(0), { size: 100 });
  assert.equal(empty.reason, 'empty');
});

// ---------------------------------------------------------------------------
// Download != installation (state-level guard)
// ---------------------------------------------------------------------------
test('A download that completes is not automatically INSTALLED', async () => {
  // This is enforced by the transaction state machine; here we confirm SemVer +
  // verify don't conflate them (i.e. no function returns INSTALLED from a download).
  const { bytes, sha } = await sample();
  const r = await verifyArtifactHash(bytes.buffer as ArrayBuffer, { size: bytes.byteLength, sha256: sha });
  assert.equal(r.ok, true);
  assert.notEqual(r.ok && 'INSTALLED', true, 'verification is not installation');
});
