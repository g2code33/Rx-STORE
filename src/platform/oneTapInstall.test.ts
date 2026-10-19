/**
 * One-tap install decision tests (production feedback, 2026-10).
 *
 * Pins the Play-Store behaviour: on a confidently-detected device whose app
 * ships a matching package, GET starts the download immediately — the
 * platform picker only appears for web/iOS recommendations, undetected
 * devices, or apps without a matching package.
 *
 * Run: node --experimental-strip-types --test src/platform/oneTapInstall.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOneTapPlatform,
  platformAvailableFor,
  effectiveRecommendation,
  ONE_TAP_PLATFORMS,
} from './oneTapInstall.ts';

const androidPhone = { device: 'android_phone', recommended: 'android' };
const androidTablet = { device: 'android_tablet', recommended: 'android' };
const iPhone = { device: 'iphone', recommended: 'ios' };
const windows = { device: 'windows', recommended: 'windows' };
const macos = { device: 'macos', recommended: 'macos' };
const linux = { device: 'linux', recommended: 'linux_deb' };
const unknown = { device: 'unknown', recommended: 'web' };

test('ONE-TAP: Android device + app with an Android package starts immediately', () => {
  assert.equal(resolveOneTapPlatform(androidPhone, ['web', 'android']), 'android');
  assert.equal(resolveOneTapPlatform(androidTablet, ['android']), 'android');
});

test('ONE-TAP: Windows / macOS / Linux devices with matching packages start immediately', () => {
  assert.equal(resolveOneTapPlatform(windows, ['windows']), 'windows');
  assert.equal(resolveOneTapPlatform(macos, ['web', 'macos']), 'macos');
  assert.equal(resolveOneTapPlatform(linux, ['linux_deb']), 'linux_deb');
  // An app declaring the base 'linux' platform serves linux_deb too.
  assert.equal(resolveOneTapPlatform(linux, ['linux']), 'linux_deb');
});

test('PICKER: Android device + app WITHOUT an Android package (web-only, or others-only)', () => {
  assert.equal(resolveOneTapPlatform(androidPhone, ['web']), null);
  assert.equal(resolveOneTapPlatform(androidPhone, ['web', 'windows']), null);
});

test('PICKER: web / iOS recommendations never one-tap (iOS needs the PWA walkthrough)', () => {
  assert.equal(resolveOneTapPlatform(iPhone, ['ios']), null);
  assert.equal(resolveOneTapPlatform(iPhone, ['web']), null);
  assert.equal(resolveOneTapPlatform(unknown, ['android']), null, 'undetected device → picker');
  assert.equal(resolveOneTapPlatform(null, ['android']), null, 'no detection at all → picker');
  assert.equal(resolveOneTapPlatform({ device: 'x', recommended: '' }, ['android']), null);
});

test('PICKER: missing platform list defaults to web-only (never a broken direct start)', () => {
  assert.equal(resolveOneTapPlatform(androidPhone, undefined), null);
  assert.equal(resolveOneTapPlatform(androidPhone, []), null);
  assert.equal(resolveOneTapPlatform(androidPhone, null), null);
});

test('platformAvailableFor matches exact and base platform ids', () => {
  assert.equal(platformAvailableFor(['android'], 'android'), true);
  assert.equal(platformAvailableFor(['linux'], 'linux_deb'), true);
  assert.equal(platformAvailableFor(['linux_deb'], 'linux_deb'), true);
  assert.equal(platformAvailableFor(['web'], 'android'), false);
  assert.equal(platformAvailableFor([], 'android'), false, 'empty list defaults to web');
});

test('effectiveRecommendation falls back to what the app actually ships', () => {
  // Detected platform available → keep it.
  assert.equal(effectiveRecommendation(androidPhone, ['web', 'android']), 'android');
  // Android user on a web-only app → Web/PWA is the highlighted option.
  assert.equal(effectiveRecommendation(androidPhone, ['web']), 'web');
  assert.equal(effectiveRecommendation(androidPhone, ['web', 'windows']), 'web');
  // Nothing for this device and no web → first shipped platform.
  assert.equal(effectiveRecommendation(androidPhone, ['windows', 'macos']), 'windows');
  // No platforms at all → web.
  assert.equal(effectiveRecommendation(androidPhone, null), 'web');
});

test('ONE_TAP_PLATFORMS never includes web or ios (picker-only recommendations)', () => {
  assert.ok(!((ONE_TAP_PLATFORMS as readonly string[]).includes('web')));
  assert.ok(!((ONE_TAP_PLATFORMS as readonly string[]).includes('ios')));
});
