# RX Store Security — Status

This document describes **what is actually implemented today**. It deliberately
avoids claiming controls that do not exist.

Legend: **IMPLEMENTED** · **PARTIAL** · **PLANNED**

> Last reviewed: Prompt 6 security hardening.

---

## Authentication & sessions

| Control | Status | Notes |
| --- | --- | --- |
| Password hashing (password-specific KDF) | **IMPLEMENTED** | PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte per-user random salt, versioned format `pbkdf2$sha256$iter$salt$hash`. See "Password hashing note" below. |
| Legacy hash migration | **IMPLEMENTED** | Old static-salt SHA-256 hashes still verify; they are transparently re-hashed to PBKDF2 on the next successful login. No user lockout. |
| Constant-time hash comparison | **IMPLEMENTED** | Prevents early-exit timing leaks. |
| Access tokens (JWT) | **IMPLEMENTED** | HS256 only; `alg` is verified (a forged `alg:none` token is rejected). `iss`/`aud`/`exp`/`iat`/`jti` are set and validated. |
| Refresh tokens | **IMPLEMENTED** | Server-side sessions; only the SHA-256 **hash** of a refresh token is stored (`auth_sessions`), never the raw token. |
| Refresh rotation | **IMPLEMENTED** | `POST /auth/refresh` revokes the presented token and issues a new pair. Replaying a rotated token fails. |
| Session expiry | **IMPLEMENTED** | Refresh sessions expire (30 days); access tokens expire (24 h). |
| Session revocation / logout | **IMPLEMENTED** | `POST /auth/logout` revokes the current session, or **all** sessions with `allDevices: true`. Session revocation never touches app installations. |
| Token-type confusion protection | **IMPLEMENTED** | A refresh token cannot be used as an access token (and vice versa). |
| Rate limiting on auth endpoints | **IMPLEMENTED** | Sliding window over KV; stricter limits on login/register/reset/refresh. |
| Password reset | **PARTIAL** | Single-use, 30-minute, stored **hashed**. **Email delivery is NOT configured** — in production the token is never returned to the client; in non-production it may be returned for testing (`ENVIRONMENT` / `RESET_TOKEN_DEBUG`). |
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
* No malware scanning, no signed download URLs, no signed update manifests.
* No `Content-Security-Policy` for the web app; no global request-size limit.
* No compliance certifications (HIPAA/GDPR/SOC 2/PCI DSS) — do not claim any.
* Password reset depends on an email provider that is not configured.
* Object storage (`/r2/*`) is public by key; published packages are not access-controlled.
* Argon2id/bcrypt are unavailable in the Workers runtime; PBKDF2-HMAC-SHA256 is used instead.
