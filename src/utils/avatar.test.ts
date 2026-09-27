/**
 * Avatar value classification tests (production bug, 2026-09-27).
 *
 * Accounts made via Google/GitHub sign-in carry the provider PICTURE as a URL;
 * password accounts carry an emoji. The UI must branch on the value —
 * rendering the URL as text was the bug. These tests pin the decision logic
 * used by every avatar render site (src/components/common/UserAvatar.tsx).
 *
 * Run: node --experimental-strip-types --test src/utils/avatar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isImageAvatar, avatarFallbackText } from './avatar.ts';

test('provider picture URLs are classified as images', () => {
  assert.equal(isImageAvatar('https://avatars.githubusercontent.com/u/123?v=4'), true);
  assert.equal(isImageAvatar('https://lh3.googleusercontent.com/a/ACg8ocK/test=s96-c'), true);
  assert.equal(isImageAvatar('http://avatars.example/octo.png'), true);
  assert.equal(isImageAvatar('data:image/png;base64,iVBORw0KGgo='), true);
});

test('emoji and text avatars are NOT images (legacy password accounts)', () => {
  assert.equal(isImageAvatar('👤'), false);
  assert.equal(isImageAvatar('🧑‍⚕️'), false);
  assert.equal(isImageAvatar('AB'), false);
});

test('missing, empty and junk values are NOT images', () => {
  assert.equal(isImageAvatar(null), false);
  assert.equal(isImageAvatar(undefined), false);
  assert.equal(isImageAvatar(''), false);
  assert.equal(isImageAvatar('   '), false);
  assert.equal(isImageAvatar('javascript:alert(1)'), false, 'never treat a script URL as an image');
  assert.equal(isImageAvatar('ftp://example.com/x.png'), false);
  assert.equal(isImageAvatar('data:text/html,<script>'), false, 'only data:IMAGE urls qualify');
  assert.equal(isImageAvatar('https://' + 'a'.repeat(3000)), false, 'absurdly long values are rejected');
});

test('fallback text never prints a URL and never renders empty', () => {
  assert.equal(avatarFallbackText('👤'), '👤');
  assert.equal(avatarFallbackText('🧑‍⚕️'), '🧑‍⚕️');
  assert.equal(avatarFallbackText(null), '👤');
  assert.equal(avatarFallbackText(''), '👤');
  // A picture URL that failed to load degrades to the emoji, never raw text.
  assert.equal(avatarFallbackText('https://avatars.githubusercontent.com/u/123?v=4'), '👤');
  assert.equal(avatarFallbackText('data:image/png;base64,iVBORw0KGgo='), '👤');
});
