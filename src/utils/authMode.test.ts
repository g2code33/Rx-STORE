/**
 * Login page mode derivation — regression tests for the "header Get Started /
 * Sign In buttons stop working" bug.
 *
 * The mode must follow the URL on EVERY render, not just at mount, because
 * header navigation between /login and /login?mode=register does not remount
 * the page. These tests pin the derivation semantics the Login page relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authModeFromSearch } from './authMode.ts';

test('no mode param (Sign In link / plain /login) -> login mode', () => {
  assert.equal(authModeFromSearch(''), 'login');
  assert.equal(authModeFromSearch(null), 'login');
  assert.equal(authModeFromSearch(undefined), 'login');
  assert.equal(authModeFromSearch('?foo=bar'), 'login');
  assert.equal(authModeFromSearch(new URLSearchParams('')), 'login');
});

test('mode=register (Get Started link) -> register mode', () => {
  assert.equal(authModeFromSearch('?mode=register'), 'register');
  assert.equal(authModeFromSearch('mode=register'), 'register');
  assert.equal(authModeFromSearch(new URLSearchParams('mode=register')), 'register');
  // Other params present alongside mode still resolve.
  assert.equal(authModeFromSearch('?foo=1&mode=register&bar=2'), 'register');
});

test('the switch between modes is purely URL-driven (the original bug)', () => {
  // Simulates the same mounted page receiving successive navigations:
  // Get Started -> Sign In -> Get Started must flip the mode every time.
  const clicks = ['', '?mode=register', '', '?mode=register'];
  const modes = clicks.map((q) => authModeFromSearch(q));
  assert.deepEqual(modes, ['login', 'register', 'login', 'register']);
});

test('unknown mode values fall back to login (never guessed)', () => {
  assert.equal(authModeFromSearch('?mode=admin'), 'login');
  assert.equal(authModeFromSearch('?mode=signup'), 'login');
  assert.equal(authModeFromSearch('?mode=REGISTER'), 'login', 'comparison is exact, not case-folded');
  assert.equal(authModeFromSearch('?mode='), 'login');
});
