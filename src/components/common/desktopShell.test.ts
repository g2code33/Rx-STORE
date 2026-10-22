/**
 * Desktop-shell capability guards.
 *
 * PRODUCTION BUG: every admin action that asked for a reason used
 * `window.prompt()` — Manual approve, Reject, Withdraw, Delete, Suspend/
 * Disconnect a repository, reset a user's password, and the clipboard
 * fallbacks. Electron does not implement `prompt`; calling it throws
 * `Error: prompt() is and will not be supported.`, so on the desktop app the
 * button did nothing at all and no request was ever sent.
 *
 * These tests fail if `window.prompt`/bare `prompt(` returns to the source, and
 * pin that the replacement (PromptDialog) is what the GitHub admin panels use.
 * `window.confirm` IS supported by Electron, so it is not banned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Strip comments so an explanatory mention of window.prompt is not a hit. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = walk(SRC).filter((f) => !f.endsWith('.test.ts'));

test('no source file calls window.prompt (it throws in Electron)', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    // `window.prompt(` anywhere, or a bare `prompt(` call (not `promptUser(`,
    // and not the English word "prompt (" inside a toast string — the lookbehind
    // excludes a whitespace-separated word boundary is not enough there, so the
    // bare-call form requires no space before the parenthesis).
    if (/\bwindow\.prompt\s*\(/.test(code) || /(^|[^.\w])prompt\(/.test(code)) {
      offenders.push(file.replace(SRC, 'src/'));
    }
  }
  assert.deepEqual(offenders, [],
    'Electron does not implement prompt() — use src/components/common/PromptDialog.tsx');
});

test('the GitHub admin panels capture reasons with PromptDialog, not a browser dialog', () => {
  for (const rel of [
    'components/admin/GithubReleasesPanel.tsx',
    'components/admin/GithubConnectionsPanel.tsx',
  ]) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    assert.match(src, /import PromptDialog from '\.\.\/common\/PromptDialog'/, `${rel} must import PromptDialog`);
    assert.match(src, /<PromptDialog/, `${rel} must render PromptDialog`);
    assert.match(src, /minLength=\{10\}/, `${rel}: a reason must require 10+ characters`);
  }
});

test('PromptDialog enforces the reason rule and closes on Escape', () => {
  const src = readFileSync(join(SRC, 'components/common/PromptDialog.tsx'), 'utf8');
  // Disabled confirm until the minimum length is met.
  assert.match(src, /const tooShort = trimmed\.length < minLength/);
  assert.match(src, /disabled=\{tooShort\}/);
  // Explicit cancellation paths (Cancel button, backdrop, Escape).
  assert.match(src, /onClick=\{onCancel\}/);
  assert.match(src, /e\.key === 'Escape'/);
  // Accessible dialog semantics.
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
});

test('the manual-approve flow sends the reason to the audited endpoint', () => {
  const src = readFileSync(join(SRC, 'components/admin/GithubReleasesPanel.tsx'), 'utf8');
  assert.match(src, /api\.githubAdmin\.manualVerifyAsset\(rel\.id, asset\.id, decision, reason\)/,
    'the typed reason must reach the manual-verify endpoint (it is audited)');
  // All four reason-taking actions are wired through the dialog.
  for (const call of ['manualVerifyAsset', 'removeRelease', 'withdraw']) {
    assert.ok(src.includes(call), `${call} must still be reachable`);
  }
  assert.match(src, /setAskReason\(\{/, 'actions ask for a reason in-app');
});

test('the manual-verify URL the panel builds matches what the Worker parses', () => {
  // The browser calls this exact path; the Worker splits it and reads the ids
  // from positions 4 and 6. If either side drifts, the button "does nothing".
  const api = readFileSync(join(SRC, 'services/api.ts'), 'utf8');
  const route = readFileSync(join('backend/src/routes/githubIntegration.ts'), 'utf8');
  const m = /`\/admin\/github\/releases\/\$\{encodeURIComponent\(releaseId\)\}\/assets\/\$\{encodeURIComponent\(assetId\)\}\/manual-verify`/.exec(api);
  assert.ok(m, 'the client must POST /admin/github/releases/:id/assets/:assetId/manual-verify');
  assert.match(route, /async manualVerifyAsset\(request: Request, env: any\)/);
  assert.match(route, /const releaseId = parts\[4\]/, 'Worker reads the release id from position 4');
  assert.match(route, /const assetId = parts\[6\]/, 'Worker reads the asset id from position 6');
});
