/**
 * Appearance / theme tests.
 *
 * The theme is a three-way choice (light | dark | system) that must be
 * predictable without a browser: the same functions run in the web bundle, the
 * Electron renderer, the Android WebView and the pre-paint script in
 * index.html. These tests pin the rules, the storage contract and the DOM
 * painting, and guard the pre-paint script against drifting from the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  applyStoredTheme,
  applyTheme,
  currentTheme,
  normalizeThemePreference,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
} from './theme.ts';

// ---------------------------------------------------------------------------
// Minimal fakes — no browser required.
// ---------------------------------------------------------------------------

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? String(map.get(k)) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

function fakeDoc() {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  return {
    attrs,
    props,
    documentElement: {
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      getAttribute: (k: string) => (attrs.has(k) ? String(attrs.get(k)) : null),
      style: {
        colorScheme: '',
        setProperty: (k: string, v: string) => { props.set(k, v); },
      },
    },
  };
}

const win = (dark: boolean) => ({ matchMedia: (q: string) => ({ matches: q.includes('dark') ? dark : !dark }) });

// ---------------------------------------------------------------------------

test('normalizeThemePreference accepts the three choices and rejects everything else', () => {
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('DARK'), 'dark');
  assert.equal(normalizeThemePreference(' system '), 'system');
  // Corrupted storage, an old value, an API null, etc. → follow the device.
  assert.equal(normalizeThemePreference('sepia'), 'system');
  assert.equal(normalizeThemePreference(''), 'system');
  assert.equal(normalizeThemePreference(null), 'system');
  assert.equal(normalizeThemePreference(undefined), 'system');
  assert.equal(normalizeThemePreference(42), 'system');
});

test('resolveTheme: explicit wins, system follows the OS', () => {
  assert.equal(resolveTheme('light', true), 'light', 'an explicit light choice ignores a dark OS');
  assert.equal(resolveTheme('dark', false), 'dark', 'an explicit dark choice ignores a light OS');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('systemPrefersDark never throws (broken or missing matchMedia)', () => {
  assert.equal(systemPrefersDark(win(true)), true);
  assert.equal(systemPrefersDark(win(false)), false);
  assert.equal(systemPrefersDark(null), false);
  assert.equal(systemPrefersDark({}), false);
  assert.equal(systemPrefersDark({ matchMedia: () => { throw new Error('nope'); } }), false);
});

test('storage: default is dark, a stored choice round-trips, bad storage never throws', () => {
  assert.equal(DEFAULT_THEME, 'dark', 'the existing dark storefront is never silently replaced');
  assert.equal(readStoredTheme(fakeStorage()), 'dark');
  assert.equal(readStoredTheme(null), 'dark');

  const s = fakeStorage();
  storeTheme('light', s);
  assert.equal(s.map.get(THEME_STORAGE_KEY), 'light');
  assert.equal(readStoredTheme(s), 'light');

  storeTheme('system', s);
  assert.equal(readStoredTheme(s), 'system');

  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readStoredTheme(broken), 'dark');
  assert.doesNotThrow(() => storeTheme('light', broken));
});

test('applyTheme paints data-theme + color-scheme on <html>', () => {
  const doc = fakeDoc();
  applyTheme('light', doc);
  assert.equal(doc.attrs.get('data-theme'), 'light');
  assert.equal(doc.documentElement.style.colorScheme, 'light');
  assert.equal(doc.props.get('color-scheme'), 'light', 'older WebViews read the CSS property');

  applyTheme('dark', doc);
  assert.equal(doc.attrs.get('data-theme'), 'dark');
  assert.equal(doc.documentElement.style.colorScheme, 'dark');
});

test('currentTheme reads what was painted (defaults to dark)', () => {
  const doc = fakeDoc();
  assert.equal(currentTheme(doc), 'dark');
  applyTheme('light', doc);
  assert.equal(currentTheme(doc), 'light');
  assert.equal(currentTheme(null), 'dark');
});

test('applyStoredTheme: the whole boot path (storage → OS → DOM)', () => {
  // A user who chose light on a dark OS still gets light.
  const lightDoc = fakeDoc();
  const pref = applyStoredTheme({ storage: fakeStorage({ 'rx-theme': 'light' }), win: win(true), doc: lightDoc });
  assert.equal(pref, 'light');
  assert.equal(lightDoc.attrs.get('data-theme'), 'light');

  // "system" follows the OS.
  const sysDoc = fakeDoc();
  applyStoredTheme({ storage: fakeStorage({ 'rx-theme': 'system' }), win: win(false), doc: sysDoc });
  assert.equal(sysDoc.attrs.get('data-theme'), 'light');
  const sysDoc2 = fakeDoc();
  applyStoredTheme({ storage: fakeStorage({ 'rx-theme': 'system' }), win: win(true), doc: sysDoc2 });
  assert.equal(sysDoc2.attrs.get('data-theme'), 'dark');

  // Nothing stored → the historical dark look.
  const fresh = fakeDoc();
  applyStoredTheme({ storage: fakeStorage(), win: win(false), doc: fresh });
  assert.equal(fresh.attrs.get('data-theme'), 'dark');
});

test('THEME_OPTIONS exposes exactly the three supported choices', () => {
  assert.deepEqual(THEME_OPTIONS.map((o) => o.value), ['light', 'dark', 'system']);
  for (const o of THEME_OPTIONS) {
    assert.ok(o.label.length > 0);
    assert.ok(o.description.length > 0);
  }
});

test('the pre-paint script in index.html cannot drift from theme.ts', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  // Same storage key, same three values, same default, same media query.
  assert.ok(html.includes(`'${THEME_STORAGE_KEY}'`), `index.html must read ${THEME_STORAGE_KEY}`);
  assert.match(html, /pref !== 'light' && pref !== 'dark' && pref !== 'system'/);
  assert.match(html, /pref = 'dark'/, 'the no-JS/empty-storage default is dark');
  assert.match(html, /prefers-color-scheme: dark/, 'system must follow the OS media query');
  assert.match(html, /setAttribute\('data-theme'/, 'the script paints the same attribute React does');
  // And the document must not start life without a theme.
  assert.match(html, /<html[^>]*data-theme="dark"/);
});

test('the CSS defines both palettes (surfaces, ink, muted)', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  // Dark + light surface ramps.
  assert.match(css, /\[data-theme='light'\]\s*\{[\s\S]*?--rx-dark: 243 246 250/);
  assert.match(css, /\[data-theme='light'\]\s*\{[\s\S]*?--rx-ink: 15 20 25/);
  assert.match(css, /\[data-theme='light'\]\s*\{[\s\S]*?--rx-muted:/);
  // The brand yellow must stay a bright FILL in light mode — only text darkens.
  assert.match(css, /\[data-theme='light'\] \.text-rx-yellow\s*\{[^}]*color: #6f5300/);
  assert.match(css, /\[data-theme='light'\]\s*\{[\s\S]*?--rx-yellow: 255 214 0/);
  // Ink on an accent surface (yellow button) stays dark in both themes.
  assert.match(css, /\[data-theme='light'\] \.text-rx-dark\s*\{[^}]*color: #0f1419/);
});
