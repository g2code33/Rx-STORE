/**
 * Unit tests for deterministic profile-section navigation + safe redirects.
 *
 * The profile page derives its active tab from ?tab=…, so every account link
 * (header dropdown, mobile quick links, notifications panel) opens its section
 * DIRECTLY, unknown values fall back to the default section, and browser
 * back/forward works because each section is a distinct URL.
 *
 * Run: node --experimental-strip-types --test src/utils/profileTabs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_TABS, DEFAULT_PROFILE_TAB, isProfileTab, normalizeProfileTab,
  profileTabHref, safeRedirectTarget,
} from './profileTabs.ts';

// ---------------------------------------------------------------------------
// Tab normalization (what ?tab= values are legal)
// ---------------------------------------------------------------------------

test('every required account section is directly addressable', () => {
  for (const tab of ['profile', 'apps', 'devices', 'purchases', 'subscriptions', 'notifications', 'settings', 'trash']) {
    assert.ok((PROFILE_TABS as readonly string[]).includes(tab), `${tab} is a addressable tab`);
  }
});

test('normalizeProfileTab accepts valid tabs and rejects everything else', () => {
  assert.equal(normalizeProfileTab('profile'), 'profile');
  assert.equal(normalizeProfileTab('apps'), 'apps');
  assert.equal(normalizeProfileTab('devices'), 'devices');
  assert.equal(normalizeProfileTab('purchases'), 'purchases');
  assert.equal(normalizeProfileTab('notifications'), 'notifications');
  assert.equal(normalizeProfileTab('settings'), 'settings');
  // Missing / unknown / hostile values fall back to the default section.
  assert.equal(normalizeProfileTab(null), DEFAULT_PROFILE_TAB);
  assert.equal(normalizeProfileTab(undefined), DEFAULT_PROFILE_TAB);
  assert.equal(normalizeProfileTab(''), DEFAULT_PROFILE_TAB);
  assert.equal(normalizeProfileTab('admin'), DEFAULT_PROFILE_TAB);
  assert.equal(normalizeProfileTab('../../etc/passwd'), DEFAULT_PROFILE_TAB);
  assert.equal(normalizeProfileTab('APPS'), DEFAULT_PROFILE_TAB, 'case-sensitive');
});

test('profileTabHref produces the exact URL for each section', () => {
  assert.equal(profileTabHref('profile'), '/profile?tab=profile');
  assert.equal(profileTabHref('apps'), '/profile?tab=apps');
  assert.equal(profileTabHref('devices'), '/profile?tab=devices');
  assert.equal(profileTabHref('purchases'), '/profile?tab=purchases');
  assert.equal(profileTabHref('notifications'), '/profile?tab=notifications');
  assert.equal(profileTabHref('settings'), '/profile?tab=settings');
});

test('isProfileTab is a precise type guard', () => {
  assert.equal(isProfileTab('apps'), true);
  assert.equal(isProfileTab('nope'), false);
  assert.equal(isProfileTab(42), false);
  assert.equal(isProfileTab(null), false);
  assert.equal(isProfileTab(undefined), false);
});

// ---------------------------------------------------------------------------
// Post-login redirect targets (open-redirect safe)
// ---------------------------------------------------------------------------

test('safeRedirectTarget accepts in-app paths (including profile tabs with query strings)', () => {
  assert.equal(safeRedirectTarget('/'), '/');
  assert.equal(safeRedirectTarget('/profile?tab=devices'), '/profile?tab=devices');
  assert.equal(safeRedirectTarget('/library'), '/library');
});

test('safeRedirectTarget rejects missing, external and protocol-relative targets', () => {
  assert.equal(safeRedirectTarget(null), null);
  assert.equal(safeRedirectTarget(''), null);
  assert.equal(safeRedirectTarget('https://evil.example'), null);
  assert.equal(safeRedirectTarget('//evil.example'), null);
  assert.equal(safeRedirectTarget('/\\evil.example'), null);
  assert.equal(safeRedirectTarget('javascript:alert(1)'), null);
});
