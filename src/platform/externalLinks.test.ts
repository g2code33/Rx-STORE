/**
 * External-link routing contract.
 *
 * WEB LINKS BELONG TO THE USER'S BROWSER — on desktop (Electron) they go to the
 * default browser, on Android to the system browser, and on the website they
 * open a normal new tab. Only IN-APP destinations open an RX Store window.
 *
 * This test pins the shell decisions by reading the actual sources, so a future
 * refactor cannot silently reintroduce the embedded-window wrapper (which broke
 * third-party sites: framing blocked, logins and OAuth callbacks dead).
 *
 * Run: node --experimental-strip-types --test src/platform/externalLinks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../electron/preload.ts', import.meta.url), 'utf8');
const androidMain = readFileSync(
  new URL('../../android/app/src/main/java/com/calcitonin/rxstore/MainActivity.java', import.meta.url),
  'utf8',
);

test('desktop: the embedded external wrapper is GONE', () => {
  assert.ok(!main.includes('externalWrapperUrl'), 'the iframe wrapper helper must not exist');
  assert.ok(!main.includes('persist:rx-external'), 'no isolated partition for a wrapper window');
  assert.ok(!main.includes('<iframe'), 'no embedded frames anywhere in the shell');
});

test('desktop: web links go to the system browser, in-app links get a window', () => {
  const handlerStart = main.indexOf('setWindowOpenHandler');
  assert.ok(handlerStart > 0, 'the window-open handler exists');
  const handler = main.slice(handlerStart, handlerStart + 800);
  assert.match(handler, /openExternal\(url\)/, 'web links are handed to the system browser');
  assert.match(handler, /openAppWindow\(url\)/, 'in-app destinations still open a window (View live)');
  assert.match(main, /shell\.openExternal\(/, 'uses Electron shell.openExternal');
  assert.match(main, /will-navigate[\s\S]{0,400}openExternal\(/, 'will-navigate sends web links to the browser');
});

test('desktop: rxDesktop.openWindow never renders a website inside the app', () => {
  const ipcStart = main.indexOf("ipcMain.handle('window:open'");
  assert.ok(ipcStart > 0);
  const ipc = main.slice(ipcStart, ipcStart + 900);
  assert.match(ipc, /return openExternal\(pathOrUrl\)/, 'web URL -> browser, not a window');
  assert.ok(preload.includes('openInBrowser'), 'the renderer has an explicit browser escape hatch');
});

test('android: the WebView hands external links to the system browser', () => {
  assert.match(androidMain, /shouldOverrideUrlLoading/, 'overrides navigation');
  assert.match(androidMain, /Intent\.ACTION_VIEW/, 'opens the URL with the OS');
  assert.match(androidMain, /FLAG_ACTIVITY_NEW_TASK/, 'starts the browser outside the activity');
  assert.match(androidMain, /localhost|127\.0\.0\.1/, 'in-app (Capacitor) origin stays inside the WebView');
});
