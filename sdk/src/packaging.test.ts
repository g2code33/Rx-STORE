/**
 * SDK packaging manifest tests (production gate §1).
 *
 * Validates that `npm pack` can only ever ship the COMPILED package (never
 * TypeScript sources, tests, the sample app or secrets) and that the exports
 * map matches the built layout. The full external-consumer proof (pack →
 * clean install → compile) runs via `npm run verify:sdk` in CI.
 *
 * Run: node --experimental-strip-types --test sdk/src/packaging.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sdkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));

test('package identity: @rx-store/sdk, ESM, tree-shakeable', () => {
  assert.equal(pkg.name, '@rx-store/sdk');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.sideEffects, false, 'sideEffects: false keeps consumer tree-shaking');
});

test('the shipped payload is ONLY compiled output + README (no sources)', () => {
  assert.deepEqual(pkg.files, ['dist', 'README.md']);
  for (const forbidden of ['src', 'sample-app', 'tsconfig.json', 'tsconfig.build.json']) {
    assert.ok(!pkg.files.includes(forbidden), `${forbidden} must not ship`);
  }
});

test('exports expose the root + the optional /react subpath with types', () => {
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./react'].types, './dist/react/index.d.ts');
  assert.equal(pkg.exports['./react'].default, './dist/react/index.js');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
});

test('React is an OPTIONAL peer dependency (core never requires React)', () => {
  assert.equal(pkg.peerDependencies.react, '>=17');
  assert.equal(pkg.peerDependenciesMeta.react.optional, true);
  assert.ok(!pkg.dependencies, 'the SDK has zero runtime dependencies');
});

test('when the build has run, the exported entry points exist as compiled files', () => {
  const dist = path.join(sdkDir, 'dist');
  if (!existsSync(dist)) {
    // Fresh checkout without a build — the CI verify:sdk step covers the
    // built case; skip here rather than fake a pass.
    return;
  }
  for (const f of ['index.js', 'index.d.ts', 'react/index.js', 'react/index.d.ts']) {
    assert.ok(existsSync(path.join(dist, f)), `dist/${f} exists after build:sdk`);
  }
  // Compiled output must not contain raw TypeScript imports (Node ESM can't
  // resolve them)…
  const entry = readFileSync(path.join(dist, 'index.js'), 'utf8');
  assert.ok(!/from\s+['"]\.[^'"]*\.ts['"]/.test(entry), 'no .ts import specifiers in emitted JS');
  // …and no test/sample sources may have been compiled into dist.
  assert.ok(!existsSync(path.join(dist, 'core', 'rxstore-sdk.test.js')), 'tests are not compiled into dist');
});

test('the manifest carries no secrets (defence in depth; build scan enforces dist too)', () => {
  const raw = readFileSync(path.join(sdkDir, 'package.json'), 'utf8');
  for (const re of [/sk_live_/, /sk-or-v1-/, /nvapi-/, /AIza[0-9A-Za-z_-]{30}/, /PRIVATE KEY/, /JWT_SECRET/, /PAYSTACK_SECRET/, /VIRUSTOTAL_API_KEY/]) {
    assert.ok(!re.test(raw), `package.json matches secret pattern ${re}`);
  }
});
