/**
 * Unit tests for the canonical rxstore:// deep-link protocol.
 *
 * These encode the security contract: a deep link may address EXACTLY one
 * shape (app/{kebab-slug}) — everything else (other schemes, hosts, paths,
 * query strings, javascript:/file:/data: URIs, traversal attempts) is
 * rejected before RX Store ever navigates.
 *
 * Run: node --experimental-strip-types --test src/platform/deepLinkProtocol.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeepLink, buildDeepLink, buildStoreUrl, encodeSlug,
  validatePendingDestination, extractDeepLinkFromArgv,
  APP_SLUG_PATTERN,
} from './deepLinkProtocol.ts';

// ---------------------------------------------------------------------------
// Parsing: the canonical link
// ---------------------------------------------------------------------------

test('the canonical link parses to its slug', () => {
  assert.deepEqual(parseDeepLink('rxstore://app/pharmatrack'), { kind: 'app', slug: 'pharmatrack' });
  assert.deepEqual(parseDeepLink('rxstore://app/clinical-rx'), { kind: 'app', slug: 'clinical-rx' });
  // Scheme is case-insensitive (RFC 3986); the slug is not.
  assert.deepEqual(parseDeepLink('RXSTORE://app/pharmatrack'), { kind: 'app', slug: 'pharmatrack' });
  // A single optional trailing slash is tolerated.
  assert.deepEqual(parseDeepLink('rxstore://app/pharmatrack/'), { kind: 'app', slug: 'pharmatrack' });
});

test('dangerous schemes are rejected', () => {
  assert.equal(parseDeepLink('javascript:alert(1)'), null);
  assert.equal(parseDeepLink('javascript://app/pharmatrack'), null);
  assert.equal(parseDeepLink('file:///etc/passwd'), null);
  assert.equal(parseDeepLink('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(parseDeepLink('https://rx-store-web.pages.dev/app/pharmatrack'), null, 'https is NOT a deep link');
  assert.equal(parseDeepLink('rxstoreevil://app/pharmatrack'), null);
});

test('malformed deep links are rejected', () => {
  assert.equal(parseDeepLink('rxstore://'), null);                       // no host
  assert.equal(parseDeepLink('rxstore://app'), null);                    // no slug
  assert.equal(parseDeepLink('rxstore://app/'), null);                   // trailing slash, still no slug
  assert.equal(parseDeepLink('rxstore://apps/pharmatrack'), null);       // wrong host
  assert.equal(parseDeepLink('rxstore://app/a/b'), null);                // extra path segment
  assert.equal(parseDeepLink('rxstore://app/pharmatrack?x=1'), null);    // query string
  assert.equal(parseDeepLink('rxstore://app/pharmatrack#frag'), null);   // fragment
  assert.equal(parseDeepLink('rxstore:app/pharmatrack'), null);          // missing //
  assert.equal(parseDeepLink('rxstore://app/PharmaTRACK'), null);        // uppercase slug
  assert.equal(parseDeepLink('rxstore://app/../etc/passwd'), null);      // traversal
  assert.equal(parseDeepLink('rxstore://app/pharma track'), null);       // space
  assert.equal(parseDeepLink('rxstore://app/-leading'), null);           // leading dash
  assert.equal(parseDeepLink('rxstore://app/a'.repeat(80)), null);       // too long
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink(null), null);
  assert.equal(parseDeepLink(12345), null);
});

test('the slug pattern is a strict kebab-case allowlist', () => {
  assert.ok(APP_SLUG_PATTERN.test('a'));
  assert.ok(APP_SLUG_PATTERN.test('pharmatrack'));
  assert.ok(APP_SLUG_PATTERN.test('clinical-rx-2'));
  assert.ok(!APP_SLUG_PATTERN.test('.'));
  assert.ok(!APP_SLUG_PATTERN.test('..'));
  assert.ok(!APP_SLUG_PATTERN.test('a/b'));
  assert.ok(!APP_SLUG_PATTERN.test('a?b'));
  assert.ok(!APP_SLUG_PATTERN.test('A'));
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test('buildDeepLink produces the canonical link and rejects bad slugs', () => {
  assert.equal(buildDeepLink('pharmatrack'), 'rxstore://app/pharmatrack');
  assert.equal(buildDeepLink('../etc/passwd'), null);
  assert.equal(buildDeepLink('PharmaTRACK'), null);
  assert.equal(buildDeepLink(''), null);
});

test('slugs are URL-encoded safely', () => {
  assert.equal(encodeSlug('pharmatrack'), 'pharmatrack');
  // A slug like "a b" is rejected by the pattern before it can be built —
  // encoding never rescues an invalid slug.
  assert.equal(buildDeepLink('a b'), null);
});

test('buildStoreUrl produces the HTTPS fallback and validates inputs', () => {
  assert.equal(buildStoreUrl('https://rx-store-web.pages.dev', 'pharmatrack'), 'https://rx-store-web.pages.dev/app/pharmatrack');
  assert.equal(buildStoreUrl('https://rx-store-web.pages.dev/', 'pharmatrack'), 'https://rx-store-web.pages.dev/app/pharmatrack', 'trailing slash normalized');
  assert.equal(buildStoreUrl('https://rx-store-web.pages.dev', '../evil'), null);
  assert.equal(buildStoreUrl('http://insecure.example', 'pharmatrack'), null, 'https only');
  assert.equal(buildStoreUrl('javascript://x', 'pharmatrack'), null);
  assert.equal(buildStoreUrl('https://rx-store-web.pages.dev', 'javascript:alert(1)'), null);
});

// ---------------------------------------------------------------------------
// Pending destination (install-then-continue)
// ---------------------------------------------------------------------------

test('pending destinations accept only /app/{slug}', () => {
  assert.equal(validatePendingDestination('/app/pharmatrack'), '/app/pharmatrack');
  assert.equal(validatePendingDestination('  /app/pharmatrack  '), '/app/pharmatrack');
  assert.equal(validatePendingDestination('/app/../admin'), null);
  assert.equal(validatePendingDestination('/admin'), null);
  assert.equal(validatePendingDestination('https://evil.example/app/x'), null);
  assert.equal(validatePendingDestination('javascript:alert(1)'), null);
  assert.equal(validatePendingDestination('/app/PharmaTRACK'), null);
  assert.equal(validatePendingDestination(null), null);
  assert.equal(validatePendingDestination('/app/' + 'x'.repeat(200)), null);
});

// ---------------------------------------------------------------------------
// Electron argv extraction (cold start + second-instance)
// ---------------------------------------------------------------------------

test('extractDeepLinkFromArgv finds the link in a cold-start argv', () => {
  const argv = ['C:\\Users\\joe\\RXStore.exe', '--flag', 'rxstore://app/pharmatrack'];
  assert.equal(extractDeepLinkFromArgv(argv), 'rxstore://app/pharmatrack');
});

test('extractDeepLinkFromArgv handles the second-instance payload (Windows wraps the URL)', () => {
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 'rxstore://app/clinical-rx']), 'rxstore://app/clinical-rx');
  // Case-insensitive scheme in argv.
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 'RXSTORE://app/clinical-rx']), 'RXSTORE://app/clinical-rx');
});

test('extractDeepLinkFromArgv rejects hostile argv content', () => {
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 'javascript:alert(1)']), null);
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 'rxstore://app/../../etc/passwd']), null);
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 'https://evil.example']), null);
  assert.equal(extractDeepLinkFromArgv([]), null);
  assert.equal(extractDeepLinkFromArgv(null as any), null);
  assert.equal(extractDeepLinkFromArgv(['RXStore.exe', 42 as any]), null);
});

// ---------------------------------------------------------------------------
// The acceptance-flow wiring: parse → navigate mapping
// ---------------------------------------------------------------------------

test('the acceptance flow: rxstore://app/pharmatrack maps to /app/pharmatrack', () => {
  const link = buildDeepLink('pharmatrack');
  assert.ok(link);
  const parsed = parseDeepLink(link!);
  assert.ok(parsed);
  const route = `/app/${parsed!.slug}`;
  assert.equal(route, '/app/pharmatrack', 'the deep link opens the marketplace page, never the homepage');
});
