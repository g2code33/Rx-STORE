# RX Store — Testing

This document describes the tests that **actually exist and run**. Earlier
versions of this file described Jest/Vitest/Supertest/Playwright/k6 suites that
were never implemented — those claims have been removed.

---

## Running the tests

```bash
npm test            # the full suite (236 tests)
npm run test:detect # same as npm test (kept for backwards compatibility)
```

The suite uses **Node's built-in test runner** with native TypeScript type
stripping — no Jest/Vitest dependency is required:

```
node --experimental-strip-types --test <files>
```

Requires **Node 22+** (the runner and type-stripping are Node features).

Individual suites:

```bash
npm run test:security    # backend/src/security.test.ts
npm run test:releases    # backend/src/releases.test.ts
npm run test:reliability # src/native/reliability.test.ts
npm run test:hardening   # src/native/hardening.test.ts
```

---

## Test files

| File | Tests | Covers |
| --- | --- | --- |
| `src/platform/detect.test.ts` | 57 | version comparison, detection state, Windows/Linux/Android detection, install-state model, current-vs-other-device resolution, uninstall metadata, staleness |
| `src/native/deviceIdentity.test.ts` | 5 | stable device id, survival across logout, distinct installs, human-readable name, web never claims native detection |
| `src/native/verify.test.ts` | 14 | SemVer ordering, SHA-256 success/failure, size mismatch, empty/incomplete download, missing checksum, PWA exemption |
| `src/native/installTransaction.test.ts` | 9 | transaction state machine, DOWNLOAD ≠ INSTALL, failed update preserves the old version, store subscription |
| `src/native/installUi.test.ts` | 11 | GET/OPEN/UPDATE, downloading %, verifying/checking, retry, updating wording, accessible statuses, current-device authority |
| `src/native/reliability.test.ts` | 30 | cache account isolation, durable/coalesced sync queue, backoff, crash recovery, interrupted install/update, stale state, malformed data |
| `src/native/hardening.test.ts` | 30 | no-fake-state, unified SemVer, E2E multi-device + per-platform lifecycles, logging redaction, health check, migration integrity, security regressions |
| `backend/src/security.test.ts` | 43 | password hashing + legacy migration, JWT (expiry/alg/type), refresh rotation, sessions, CORS allowlist, rate limits, validation, device/installation ownership, payments fail-closed |
| `backend/src/releases.test.ts` | 36 | SemVer, channels, platform/architecture selection, integrity, manifest, publish validation, rollback, pagination |

**Total: 236 tests.**

---

## What the tests do NOT cover (honest limits)

* **No browser/DOM tests** — there is no React Testing Library or Playwright
  setup. Component tests run through the pure logic they depend on.
* **No real OS integration tests** — Windows registry reads, Linux `dpkg`/PATH
  lookups, Android `PackageManager` queries and Electron IPC are not executed.
  The *decision layer* they feed is fully unit-tested; the OS access itself needs
  real hardware.
* **No live-backend tests** — the D1/KV/R2 bindings are stubbed with in-memory
  fakes. `wrangler dev` + a real D1 instance is required for true integration.
* **No coverage instrumentation** — no coverage tool is configured, so there are
  no coverage numbers to report (and none are claimed).
* **No performance tests** — k6 was never set up.

---

## Adding a test

Test files live beside the code they cover and end in `.test.ts`. Import with an
explicit `.ts` extension (required by Node's type stripping for relative
imports):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myFunction } from './myModule.ts';

test('describes the behaviour', () => {
  assert.equal(myFunction('a'), 'b');
});
```

Then add the file to the `test` script in `package.json`.

**Prefer pure functions.** Anything that needs `localStorage`, `window` or a
network binding should have that dependency injected (see `reliability.test.ts`
for the in-memory `localStorage` polyfill pattern).
