# RX Store Security — Status

This document describes **what is actually implemented today**. It deliberately
avoids claiming controls that do not exist.

Legend: **IMPLEMENTED** · **PARTIAL** · **PLANNED**

> Last reviewed: Prompt 6 security hardening.

---

## Authentication model

**PRIMARY:** email/phone + password (unchanged, fully backward compatible).
**SECONDARY (optional):** Google and GitHub OAuth — secondary methods on top
of the password system, never a replacement.

```
RX Store Login ── Continue with Google/GitHub
  → backend generates single-use state (10 min, PKCE S256 + nonce for Google)
  → provider authorization → backend callback
  → provider identity VALIDATED server-side (Google id_token: RS256/JWKS +
    iss/aud/exp/nonce; GitHub: server-side token exchange + /user + verified
    primary email)
  → identity resolution by provider SUBJECT (never by email):
      existing link            → log into that account
      verified email match     → NO merge — explicit password-confirmed linking
      no match                 → create a fresh account (no invented password)
  → ONE-TIME completion code → SPA exchanges it → NORMAL RX Store session
    (JWT access token + opaque persistent refresh credential + auth_sessions)
```

Rules enforced (and unit-tested in `backend/src/oauth.test.ts`):

* Provider **subject** (`sub` / immutable GitHub id) is the permanent identity
  key — emails and usernames never are.
* **Email never auto-merges**: a provider identity matching an existing
  account's email requires that account's PASSWORD before it attaches.
* One-time tokens (state/completion codes/link tokens/link intents) are
  hashed, 10-minute, **single-use enforced atomically in D1** — replay is
  impossible, including across concurrent requests.
* OAuth client secrets live only as Worker secrets; they never reach the
  frontend bundle, logs, or API responses (asserted by tests).
* The final redirect always targets the configured web origin with a SAFE
  in-app path only — no open redirects, no arbitrary callback URLs.
* A user can never remove their last usable sign-in method (password or the
  final connected provider) — enforced server-side.
* Google blocks OAuth in embedded WebViews: native shells (Android app,
  Electron) sign in via the web deployment and carry the session over with a
  one-time **sign-in code** (10 min, single use) — documented, deliberate.

## Authentication & sessions

| Control | Status | Notes |
| --- | --- | --- |
| Password hashing (password-specific KDF) | **IMPLEMENTED** | PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte per-user random salt, versioned format `pbkdf2$sha256$iter$salt$hash`. See "Password hashing note" below. |
| Legacy hash migration | **IMPLEMENTED** | Old static-salt SHA-256 hashes still verify; they are transparently re-hashed to PBKDF2 on the next successful login. No user lockout. |
| Constant-time hash comparison | **IMPLEMENTED** | Prevents early-exit timing leaks. |
| Access tokens (JWT) | **IMPLEMENTED** | HS256 only; `alg` is verified (a forged `alg:none` token is rejected). `iss`/`aud`/`exp`/`iat`/`jti` are set and validated. |
| Refresh tokens | **IMPLEMENTED** | Server-side sessions; only the SHA-256 **hash** of a refresh token is stored (`auth_sessions`), never the raw token. |
| Refresh rotation | **IMPLEMENTED** | `POST /auth/refresh` revokes the presented token and issues a new pair. Replaying a rotated token fails. |
| Session expiry | **IMPLEMENTED** | **Persistent device sessions**: access tokens expire (24 h) and refresh silently; refresh credentials are opaque with no embedded expiry and end ONLY via revocation (sign-out / all-devices / password reset / admin revoke). Legacy 30-day sessions migrated to persistent on first refresh. |
| Session revocation / logout | **IMPLEMENTED** | `POST /auth/logout` revokes the current session, or **all** sessions with `allDevices: true`. Session revocation never touches app installations. |
| Token-type confusion protection | **IMPLEMENTED** | A refresh token cannot be used as an access token (and vice versa). |
| Rate limiting on auth endpoints | **IMPLEMENTED** | Sliding window over KV; stricter limits on login/register/reset/refresh. |
| Password reset | **IMPLEMENTED (truthful)** | Single-use, 30-minute, stored **hashed**. Production + configured email (`RESEND_API_KEY`/`FROM_EMAIL`) → sends the reset email; production + unconfigured → the API/UI truthfully report `delivery: unconfigured` and never claim an email was sent; the raw token is NEVER returned in production. |
| Password change invalidates sessions | **IMPLEMENTED** | `reset-password` revokes all of the user's sessions. |
| Account lockout after failed attempts | **PLANNED** | Not implemented. Rate limiting mitigates brute force; there is no per-account lockout. |
| Two-factor authentication (2FA/TOTP) | **PLANNED** | Not implemented. |
| Email verification | **PLANNED** | The `users.email_verified` column exists but is not enforced. |

### Password hashing note (honest limitation)

The prompt prefers **Argon2id** (or **bcrypt**). Neither is available in the
Cloudflare Workers runtime: it cannot load native modules, and a pure-JS bcrypt
at a sane cost exceeds the Worker CPU budget. The strongest password KDF
available via the runtime's WebCrypto is **PBKDF2-HMAC-SHA256**, which OWASP
lists as acceptable. The stored format is versioned so an Argon2id/WASM
implementation can be added later and migrated on login (same mechanism used for
the legacy SHA-256 → PBKDF2 upgrade).

**CPU budget caveat (operational):** 600,000 PBKDF2-SHA256 iterations is the
OWASP recommendation, but it costs roughly 100–300 ms of CPU per hash. That fits
the Workers **paid** CPU budget, but will exceed the **free** plan's 10 ms limit
and cause login to fail with a CPU-limit error. If you deploy on the free plan,
either raise the plan or lower `PBKDF2_ITERATIONS` in
`backend/src/services/password.ts` (the iteration count is embedded in the stored
hash, and `needsRehash` will transparently upgrade hashes on the next login after
you raise it again).

---

## API security

| Control | Status | Notes |
| --- | --- | --- |
| Standardized error responses | **IMPLEMENTED** | `{ success:false, error:{ code, message, requestId } }`. |
| No internal error leakage | **IMPLEMENTED** | Database/runtime error messages and stack traces are never returned; they are logged server-side (redacted). |
| Request IDs / correlation | **IMPLEMENTED** | Every response carries `X-Request-Id`; the id is echoed in error bodies. |
| CORS allowlist | **IMPLEMENTED** | Exact-match allowlist (`CORS_ALLOWED_ORIGINS` + first-party origins). No suffix/substring matching. Localhost dev origins only outside production. Disallowed origins are never reflected and get no credentials header. |
| Rate limiting | **IMPLEMENTED** | True sliding window in KV; per-route-group limits; identity = authenticated user id, else IP. |
| Authorization scoping | **IMPLEMENTED** | User-specific resources (devices, installations, notifications, profile, payments history, reviews) are scoped to the authenticated user. **Client-supplied `user_id` is never trusted** as authorization. |
| SQL injection prevention | **IMPLEMENTED** | All queries use D1 parameterized `bind(...)`. |
| Input validation | **IMPLEMENTED** | Server-side validators for email, password, ids, platform, architecture, version, checksum, device info; unexpected-field detection for mass-assignment guards. |
| Admin endpoint protection | **IMPLEMENTED** | All `/admin/*` require a valid admin access token (role checked). |
| Security headers | **PARTIAL** | API responses set `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`. A full `Content-Security-Policy` for the web app is **PLANNED** (the SPA is served by Cloudflare Pages, not this Worker). |
| CSRF protection | **PARTIAL** | The API is token-based (no cookie session), so classic CSRF does not apply. No explicit CSRF token is implemented. |
| Request size limits | **PLANNED** | Uploads have per-file limits; a global body-size limit is not enforced. |
| WAF / DDoS protection | **PARTIAL** | Relies on Cloudflare's platform defaults if enabled on the zone. Not configured in this repository. |

---

## Data security

| Control | Status | Notes |
| --- | --- | --- |
| Encryption in transit | **IMPLEMENTED** | HTTPS only (HSTS set by the API; Cloudflare terminates TLS). |
| Encryption at rest | **PLANNED** | Depends on the D1/R2 provider configuration; not asserted here. |
| Sensitive data masking in logs | **IMPLEMENTED** | A `redact()` helper strips tokens/keys/passwords from logged strings. |
| PII handling / GDPR / HIPAA | **PLANNED** | No compliance program exists. Do not claim HIPAA/GDPR/SOC 2. |
| Database connection pooling with SSL | **N/A** | D1 is a managed binding; there is no connection pool to configure. |

---

## File & upload security

| Control | Status | Notes |
| --- | --- | --- |
| File type / size validation | **PARTIAL** | Admin uploads validate size and platform; **magic-byte content inspection is not implemented**. |
| Malware / virus scanning | **PLANNED** | Not implemented. |
| Checksum verification of downloads | **IMPLEMENTED** (client) | The client computes SHA-256 of an artifact and compares it to the package metadata before install. |
| Signed / expiring download URLs | **PLANNED** | Not implemented (see "Download exposure" below). |

### Download exposure (important, honest)

Object storage is served by the Worker at `GET /r2/<key>`. **That route is
public**: anyone who knows or guesses a storage key can fetch the object without
authenticating. Keys follow a predictable pattern
(`apps/<slug>/<version>/<platform>/<filename>`).

* Package binaries and icons are therefore **effectively public** once published.
* The `/apps/:slug/download` endpoint adds bookkeeping (download counts, admin
  toggles, maintenance mode) and returns the storage URL — it is **not** an
  access-control boundary.
* Do **not** treat paid/private packages as protected by authentication until
  signed, expiring URLs (or an authenticated streaming route) are implemented.

---

## Update system security

| Control | Status | Notes |
| --- | --- | --- |
| Checksum verification before install | **IMPLEMENTED** | SHA-256 compared against authoritative package metadata; a mismatch aborts the install. |
| Secure transport for updates | **IMPLEMENTED** | HTTPS only. |
| Code signing for app packages | **PARTIAL** | Windows/Linux installers are built via electron-builder; a maintained signing certificate is **not** configured for all platforms. Android release signing is optional (debug key fallback). |
| Signed update manifests | **PLANNED** | Not implemented (checksums are used). |
| Rollback capability | **PARTIAL** | Admin release rollback exists (re-serves the previous published release). |

---

## Monitoring & incident response

| Control | Status | Notes |
| --- | --- | --- |
| Audit logging | **PARTIAL** | Admin actions are written to `audit_logs`; there is no comprehensive security event pipeline. |
| Anomaly detection / alerting | **PLANNED** | Not implemented. |
| Incident response plan | **PLANNED** | Not documented. |
| Dependency updates | **PARTIAL** | Manual; no automated dependency-update bot configured here. |
| Penetration testing | **PLANNED** | Never performed. Do not claim otherwise. |
| Bug bounty program | **PLANNED** | Does not exist. |

---

## Payments

| Control | Status | Notes |
| --- | --- | --- |
| Real payment provider integration | **PLANNED** | **No provider is integrated.** Paystack / Mobile Money / Hubtel are stubs. |
| Paid-access enforcement | **IMPLEMENTED** (fail-closed) | `POST /payments/subscribe` returns `PAYMENTS_NOT_ENABLED` (501) in production. Simulated "success" only happens outside production and marks the subscription `test` — it grants no real entitlement. |
| PCI DSS compliance | **N/A** | No card data is handled by this application. |

---

## Known gaps summary

* No 2FA, no account lockout, no email verification.
* Malware scanning IS implemented (VirusTotal hash lookup / custom REST via `MALWARE_SCANNER`); signature chain-of-trust validation is honestly NEEDS_REVIEW with an admin-override path (not possible inside the Workers runtime).
* Paid downloads use short-lived signed grants (see below); free published binaries are public by design.
* No `Content-Security-Policy` for the web app; no global request-size limit.
* No compliance certifications (HIPAA/GDPR/SOC 2/PCI DSS) — do not claim any.
* Password reset email delivery requires `RESEND_API_KEY` + `FROM_EMAIL` to be configured; without them the deployment reports the unconfigured state truthfully instead of pretending an email was sent.
* Argon2id/bcrypt are unavailable in the Workers runtime; PBKDF2-HMAC-SHA256 is used instead.

---

## Download security — free vs paid (canonical model)

**Paid applications (entitlement-gated, fail closed):**

```
purchase → entitlement (payments ledger)
        → download endpoint checks entitlement
        → issues a 10-minute, SHA-256-hashed download grant
        → GET /downloads/<grant> proxies the binary from R2
```

Paid binaries are NEVER publicly addressable: the `/r2/` public route denies
every key owned by a paid application (`r2KeyIsPubliclyServed`), the legacy
`app_versions.files` fallback fails closed for paid apps, and the unauthenticated
`/updates/check` response never contains a binary URL for a paid app — the SDK
only receives the store/deep-link destination. Grants are single-purpose,
short-lived and bound to user + package; revoked entitlements invalidate the
flow at grant-resolution time.

**Free applications (public by design):**

Published packages of FREE applications are intentionally **public**: a valid,
published, non-deleted package key of a free app is served by `/r2/<key>`
without authentication. This is the documented model for open distribution —
`/r2/<key>` for free apps is **not private and does not expire**, and must
never be described as such.

**Future hardening path (implementation-ready, not breaking the current model):**
free downloads can adopt the SAME short-lived grant flow as paid downloads
(entitlement check replaced by a rate-limited anonymous grant). The
`resolveDownloadGrant` machinery and the `/downloads/:token` proxy already
support it; switching free apps to grant-gated downloads is a policy change in
`r2KeyIsPubliclyServed` + grant issuance, not new architecture.
