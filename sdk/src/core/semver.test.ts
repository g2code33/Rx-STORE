/**
 * SemVer tests for the SDK's standalone comparison (mirror of the backend's
 * authoritative compareSemver rules — see sdk/src/core/semver.ts).
 *
 * Run: node --experimental-strip-types --test sdk/src/core/semver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isValidSemver, parseSemver } from './semver.ts';

test('the spec ordering holds: 1.0.0 < 1.0.1 < 1.1.0 < 2.0.0', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1') < 0, true);
  assert.equal(compareVersions('1.0.1', '1.1.0') < 0, true);
  assert.equal(compareVersions('1.1.0', '2.0.0') < 0, true);
  assert.equal(compareVersions('2.0.0', '1.1.0') > 0, true);
});

test('prereleases sort below their release (and among themselves)', () => {
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-rc.1') < 0, true);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0') < 0, true);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta.2') < 0, true);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta.1') < 0, true);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1') > 0, true);
  // numeric identifiers compare numerically (2 > 10 would be a string bug)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true);
});

test('build metadata is ignored for precedence', () => {
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
});

test('validation is strict (no loose mode, no naive strings)', () => {
  assert.ok(isValidSemver('1.0.0'));
  assert.ok(isValidSemver('1.0.0-beta.1'));
  assert.ok(isValidSemver('1.0.0-rc.1'));
  assert.ok(isValidSemver('0.0.1'));
  assert.ok(!isValidSemver('1.0'));            // missing patch
  assert.ok(!isValidSemver('v1.0.0'));         // prefix
  assert.ok(!isValidSemver('1.0.0.0'));        // extra segment
  assert.ok(!isValidSemver('01.0.0'));         // leading zero
  assert.ok(!isValidSemver(''));
  assert.ok(!isValidSemver(null));
  assert.ok(!isValidSemver('latest'));
});

test('parseSemver exposes the components', () => {
  const p = parseSemver('2.13.9-rc.3');
  assert.deepEqual([p?.major, p?.minor, p?.patch], [2, 13, 9]);
  assert.deepEqual(p?.prerelease, ['rc', '3']);
  assert.equal(parseSemver('garbage'), null);
});

test('invalid versions sort lowest (defensive)', () => {
  assert.equal(compareVersions('garbage', '1.0.0') < 0, true);
  assert.equal(compareVersions('1.0.0', 'garbage') > 0, true);
  assert.equal(compareVersions('garbage', 'garbage'), 0);
});
