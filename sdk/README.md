# @rx-store/sdk

The official RX Store Developer SDK. Add it to **your** application to:

- check whether a newer RX Store release of your app exists
- detect mandatory / minimum-supported-version situations
- show an in-app update banner (optional React component, or build your own UI)
- send the user to **RX Store** with one action — where the secure, verified
  update pipeline (download → SHA-256 → package security → installer →
  installation confirmation) already lives

```
HOST APP → SDK → GET /updates/check → update metadata
        → your banner → "Update via RX Store"
        → rxstore://app/{slug}  (deep link; HTTPS fallback)
        → RX Store app page → RX Store's existing update pipeline
```

**The SDK never downloads or installs anything.** It contains no secrets —
the update check uses the same public API a browser uses.

> **Status (honest):** the SDK builds into a real compiled npm package
> (`sdk/dist`: ESM JavaScript + declarations) that CI installs into a clean
> sample app and compiles before any release. It is **not yet published to the
> public npm registry** — until it is, use the verified tarball path in
> Installation. The API below is stable and versioned with SemVer.

---

## Installation

**Target developer experience (what the package is built for):**

```bash
npm install @rx-store/sdk
```

```ts
import { createRxStoreSDK } from '@rx-store/sdk';
import { RxStoreUpdateBanner } from '@rx-store/sdk/react';   // optional
```

**Honest status:** the package is NOT yet published to the public npm registry
— do not expect `npm install @rx-store/sdk` to work until it is. What IS real
today: the repository builds a proper compiled package (plain ESM JavaScript +
`.d.ts` declarations under `sdk/dist`, tree-shakeable, `sideEffects: false`,
`/react` subpath optional) and CI verifies it by installing the packed tarball
into a clean sample application (`sdk/sample-app/`) and compiling it
(`npm run verify:sdk` from the repo root). Until the npm publication happens,
consume the verified tarball:

```bash
# Build + pack from the repository (verified path, no TypeScript shipped to consumers):
git clone https://github.com/g2code33/Rx-STORE && cd Rx-STORE
npm install && npm run build:sdk          # → sdk/dist (JS + declarations)
cd sdk && npm pack                        # → rx-store-sdk-<version>.tgz

# In YOUR application:
npm install ./path/to/rx-store-sdk-0.1.0.tgz
```

The package contents (`npm pack`) are exactly `dist/` + this README — compiled
JavaScript and declarations only, never SDK TypeScript sources, and never any
secrets (a build-time scan enforces this).

## Quick start

```ts
import { createRxStoreSDK } from '@rx-store/sdk';

export const rxStore = createRxStoreSDK({
  appId: 'pharmatrack',        // your RX Store slug (Developer Center → App → SDK)
  currentVersion: APP_VERSION, // your app's SemVer, e.g. '1.1.4'
  platform: 'android',         // optional override — recommended on native hosts
  channel: 'stable',
});

await rxStore.initialize();    // fires a non-blocking startup check
```

## Update checking

```ts
const result = await rxStore.checkForUpdate();   // never throws

if (result.status === 'UPDATE_AVAILABLE') {
  console.log(`${result.update.latestVersion} is available`);
} else if (result.status === 'MANDATORY_UPDATE') {
  // the server marked this release mandatory — updating is required
} else if (result.status === 'NO_UPDATE') {
  // up to date
} else {
  // NETWORK_ERROR | RATE_LIMITED | SERVER_ERROR → retry later (SDK backs off)
  // INVALID_RESPONSE | APP_NOT_FOUND | UNSUPPORTED_PLATFORM → check your config
}
```

Helpers:

```ts
rxStore.hasUpdate()             // boolean
rxStore.isMandatoryUpdate()    // boolean (server-authoritative)
rxStore.getUpdateInfo()        // full validated metadata, or null
```

The SDK automatically:

- checks once on `initialize()` (never blocks your startup — the promise resolves immediately)
- re-checks when the host app becomes visible/active
- **caches** a successful response briefly (5 min default)
- **de-duplicates** concurrent checks into one request
- **backs off exponentially** after network failures (30s → ×2 → 10 min cap)
- never polls aggressively (opt-in periodic check, 1-minute minimum)

## Opening RX Store

```ts
rxStore.openUpdateInRxStore();
```

- On native hosts (Android / Windows / Linux) the SDK opens
  `rxstore://app/{slug}`; if RX Store is not installed (the host is still
  visible after ~2s) it falls back to the HTTPS store page.
- On web hosts it goes straight to `https://rx-store-web.pages.dev/app/{slug}`.
- The HTTPS page always works and offers **Get RX Store** when the native app
  is not installed, preserving the intended destination.

Build links yourself if you prefer:

```ts
rxStore.buildDeepLink();   // 'rxstore://app/pharmatrack'
rxStore.buildStoreUrl();   // 'https://rx-store-web.pages.dev/app/pharmatrack'
```

## React banner (optional)

```tsx
import { RxStoreUpdateBanner } from '@rx-store/sdk/react';

export function App() {
  return (
    <>
      {/* your app */}
      <RxStoreUpdateBanner sdk={rxStore} onUpdateOpen={() => analytics.track('update_open')} />
    </>
  );
}
```

- Shows *"X v1.1.5 is available — Open RX Store to update securely."* with
  **[ Update via RX Store ]** and **Later** (dismiss).
- Mandatory updates render as a required-update banner that **cannot be
  dismissed permanently** (a dismissal only lasts for that version; the
  banner returns on the next check).
- Handles loading, retryable network errors and release notes; accessible
  (`role=status` / `alertdialog`, keyboard-operable buttons) and responsive.
- The core SDK has **no React dependency** — build your own UI from
  `checkForUpdate()` / `deriveBannerState()` if you don't use React.

## Platform & architecture

The SDK reports `web | pwa | android | windows | linux`. Automatic detection
only trusts **hard environment evidence** (a native Capacitor bridge or an
Electron bridge) — a browser user-agent mentioning "Android" is *never*
treated as an Android host. On native hosts, pass an explicit override:

```ts
createRxStoreSDK({ appId: 'pharmatrack', currentVersion: '1.1.4', platform: 'android', architecture: 'arm64' })
```

## Configuration reference

| Option | Default | Notes |
| --- | --- | --- |
| `appId` | — | **required** — your RX Store slug |
| `currentVersion` | — | **required** — valid SemVer (`1.0.0-beta.1` ok) |
| `apiUrl` | production Worker `/v1` | RX Store API base |
| `webUrl` | `https://rx-store-web.pages.dev` | HTTPS fallback origin |
| `platform` / `architecture` / `channel` | auto / `stable` | explicit overrides |
| `checkOnStart` | `true` | non-blocking startup check |
| `checkOnVisible` | `true` | re-check on visibility |
| `pollIntervalMs` | `0` (off) | opt-in periodic check, ≥ 60 000 |
| `cacheTtlMs` | `300000` | successful-response cache |
| `backoff` | `30s → ×2 → 10 min` | after failures |
| `fallbackDelayMs` | `2000` | deep link → HTTPS fallback window |
| `openLink` | `window.open` | inject for tests/custom navigation |

`destroy()` releases all timers/listeners — call it when your host app shuts down.

## Security notes

- No secrets ship with the SDK. The update check is unauthenticated and public.
- **Server-authoritative metadata**: `latestVersion`, `mandatory`,
  `minimumSupportedVersion`, `checksum` and destinations come from RX Store
  and are validated; client-supplied values are never trusted.
- The SDK **ignores** `downloadURL` entirely. Paid applications never expose a
  binary URL through the update check — entitlement + short-lived grants stay
  inside RX Store.
- Deep links are strictly `rxstore://app/{kebab-slug}` — RX Store validates
  them again before navigating; no arbitrary commands, paths or scripts.

## API contract

`GET {apiUrl}/updates/check?app={slug}&currentVersion={semver}&platform={platform}[&arch={arch}][&channel={channel}]`

Response (validated by the SDK before use):

```json
{
  "success": true,
  "data": {
    "appId": "app_xxx", "app": "PharmaTRACK", "slug": "pharmatrack",
    "currentVersion": "1.1.4", "latestVersion": "1.1.5",
    "platform": "android", "architecture": "arm64", "channel": "stable",
    "updateAvailable": true, "mandatory": false,
    "minimumSupportedVersion": "1.1.0", "updateRequired": false,
    "releaseNotes": ["Bug fixes", "Performance improvements"],
    "fileSize": 12345678, "checksum": "sha256:…",
    "storeUrl": "https://rx-store-web.pages.dev/app/pharmatrack",
    "deepLink": "rxstore://app/pharmatrack",
    "checkedAt": "2026-09-24T12:00:00.000Z",
    "downloadURL": null
  }
}
```

Rate limit: 300 requests/minute/IP (shared with general API traffic).
Errors: `404` unknown app · `400` missing params · `429` rate limited.

## SemVer

The SDK validates versions with full SemVer semantics
(`1.0.0 < 1.0.1 < 1.1.0 < 2.0.0`, `1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0`).
The server performs the authoritative comparison with the same rules.
