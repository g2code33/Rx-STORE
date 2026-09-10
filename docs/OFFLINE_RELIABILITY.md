# RX Store — Offline Mode, Recovery & Reliability

How RX Store behaves when the network, an installer, or the app itself fails.
Reflects what is actually implemented.

---

## 1. Offline-first current device

**Native detection never needs the backend.** `detectInstalledApp()` talks only to
the OS (Electron IPC / Android `PackageManager`). The decision layer
(`src/platform/detect.ts`) is pure. Therefore, with no connectivity a user can
still:

* see locally installed applications,
* open them (`runtime.open`),
* read the installed version,
* see `GET` / `OPEN` / `UPDATE` correctly — `UPDATE` only when the cached release
  metadata knows a newer version exists.

The website/PWA cannot inspect the OS and reports `DETECTION_UNAVAILABLE`
(→ `GET`); it never fabricates a local install.

---

## 2. Cache domains (account isolation)

`src/native/cache.ts` namespaces every persisted value as
`rx:<ns>:<scope>:<account|anon>:<name>`:

| Namespace | Scope | Contents | Cleared on logout |
| --- | --- | --- | --- |
| `auth` | account | session-adjacent metadata | yes |
| `catalog` | **device** | the public app listing cache | no |
| `device` | **device** | stable device id + name | no |
| `installation` | account | last-known install state, sync queue | yes |
| `transaction` | account | in-flight install attempt (recovery) | yes |

**Cross-account leak fixed.** Previously `AppContext` read a *shared* legacy key
(`rx-store-installed`) as a fallback and mirrored writes into it, so account A's
installed list could appear for account B on a shared computer. Now:

* the per-user key is the only key read for a signed-in user,
* the legacy shared key is written only while signed out,
* `clearAccountData()` runs on logout and removes the account-scoped namespaces
  plus `rx-store-token` / `rx-store-refresh-token` / `rx-store-user` / the legacy
  keys — while **preserving** the device identity and the public catalog.

Tokens keep their existing non-namespaced keys for compatibility with the API
client and native shells; they are removed explicitly on logout.

---

## 3. Sync queue (durable, idempotent)

`src/native/syncQueue.ts` queues installation/device state changes instead of
firing-and-forgetting.

* **Durable** — persisted per account, so a crash or offline session keeps the work.
* **Coalesced / idempotent** — deduped by `(kind, deviceId, appSlug)`. Reporting the
  same app twice replaces the pending item rather than enqueuing a second one, so
  retries cannot create duplicate installation records. The backend additionally
  upserts on `UNIQUE(device_id, application_id)` (defence in depth).
* **Backoff** — exponential from 5 s, capped at 15 min, with deterministic jitter
  derived from the item key. A failing item is *not* retried immediately.
* **Flush triggers** — on sign-in, on app foreground, on periodic visibility
  refresh (15 min, only when visible), and immediately when connectivity returns.

`reportCurrentInstallation()` enqueues first, then best-effort flushes. A failed
flush leaves the item queued with backoff — never hammering the backend.

---

## 4. Connectivity

`src/native/connectivity.ts` uses `navigator.onLine` + the `online`/`offline`
events, plus the Capacitor `AppInstaller.getNetworkStatus()` bridge on Android.
It **does not poll** — events drive updates, and the queue backoff covers the rest.

When a device is offline the Profile → My Devices tab shows an offline banner and
the number of pending sync changes ("Sync now" appears once back online).

---

## 5. Crash recovery

The in-flight attempt is persisted as it progresses
(`src/native/transactionRecovery.ts`). On the next launch
`recoverInterruptedAttempt()`:

1. loads the persisted attempt,
2. runs **native detection** to learn the real state,
3. decides an outcome:

| Outcome | Meaning | UI |
| --- | --- | --- |
| `recovered_installed` | detection reports the target version (or newer) | success message |
| `recovered_previous` | an interrupted **update** left the OLD version | "update was interrupted — your existing version is still installed" |
| `not_installed` | detection says it is not installed | "did not complete — try again" |
| `stale_cleared` | the attempt is older than 30 min (abandoned) | neutral message |
| `still_installing` | detection unavailable — cannot verify | "could not be verified yet" |

4. synchronizes the correction (unless detection was unavailable),
5. clears the persisted attempt.

**The target version is never assumed.** An interrupted `1.2.0 → 1.3.0` update where
detection still reports `1.2.0` keeps `1.2.0` installed and offers `UPDATE` — never
`GET` and never a false `1.3.0`.

Because the persisted record is consulted (rather than React state), a crash can
never leave a permanently stuck "Installing…".

---

## 6. Interrupted downloads & artifacts

* A download that fails leaves the transaction in `DOWNLOAD_FAILED`; nothing is
  installed.
* Artifacts are only cleaned up once an install is definitively over:
  `artifactCleanupCandidate()` returns `null` while `still_installing` (an
  installer may still need the file) and only returns a path for
  `not_installed` / `stale_cleared`.
* Resume is **not** implemented — the existing architecture
  (Electron `will-download`, Android `DownloadManager`) handles partial transfers
  itself; RX Store re-downloads rather than resuming, and re-verifies SHA-256.

---

## 7. Error boundaries

`src/components/common/ErrorBoundary.tsx` provides:

* `RouteErrorBoundary` — wraps the routed content in `App.tsx`, so a broken page
  renders an in-layout fallback while navigation keeps working.
* `SectionBoundary` / `ErrorBoundary` — for risky sections.

**Backend outage** → the catalog keeps serving the cached listing; only an empty
catalog surfaces an error. **Malformed cache** → `readCatalogCache()` filters out
unusable records and `cacheGet()` returns `null` on invalid JSON instead of
throwing. **Native installer failure** → the transaction records a failure state
and the account state is untouched.

---

## 8. Stale cloud state

* **Current device:** native detection always wins. If the cloud says `installed`
  but detection says `not_installed`, the UI shows `GET` and the correction is
  synced (`resolveDeviceView` + the queue).
* **Other devices:** the record is qualified by age
  (`otherDeviceInstallLabel`): "Installed on another device" (active, <24 h),
  "Last known installed on another device" (stale, <14 d),
  "Previously installed on another device" (older). It is never presented as
  guaranteed-current.

---

## 9. Tests

`src/native/reliability.test.ts` (30 tests): account-scoped cache isolation,
device-scoped survival, `clearAccountData` semantics, durable + coalesced queue,
backoff growth/cap, flush success/failure/prune, offline flush no-op,
connectivity events, crash recovery for every outcome (including the interrupted
update preserving `1.2.0`), artifact-cleanup safety, stale-cloud resolution, stale
other-device labelling, and malformed-data resilience.

---

## 10. Known limitations

* **No download resume** — a partial transfer is discarded and re-downloaded
  (integrity is re-verified).
* **Detection unavailability blocks verification**, not installation: when the OS
  cannot confirm (web/PWA, or a transient detection error) the outcome is
  `still_installing` and nothing is synced — the app never claims success.
* **The queue is per-device localStorage**; a user installing on two devices keeps
  two independent queues (correct, but there is no cross-device coordination).
* **No background sync service** — flushes happen on app events only (sign-in,
  foreground, connectivity recovery, 15-min visible refresh). A native shell that
  is fully closed cannot sync until it is reopened.
* **UI surface is minimal** — the pending-sync count and the offline banner live in
  Profile → My Devices; the app card/detail pages do not yet show a per-app "will
  sync when online" chip.
