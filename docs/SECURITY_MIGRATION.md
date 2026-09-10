# Security Migration & Deployment Notes (Prompt 6)

What changed in the security-hardening phase and exactly what an operator must do
to deploy it safely.

## 1. Database

Run the new migration once against production D1 (idempotent, safe to re-run):

```bash
npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0007_auth_sessions.sql
```

It creates `auth_sessions` (refresh-token rotation / revocation). The Worker also
creates the table lazily, so the migration is not strictly required — but running
it up front is recommended.

**No destructive change.** No existing table is dropped or rewritten.

## 2. Configuration (wrangler vars / secrets)

| Name | Purpose | Notes |
| --- | --- | --- |
| `JWT_SECRET` | Signs access + refresh tokens | **Required.** Rotate if it ever leaked — this invalidates all tokens (users re-sign-in). |
| `CORS_ALLOWED_ORIGINS` | Extra exact-match allowed origins | Comma-separated. First-party origins (`https://rxstore.com`, `app://rxstore`, `https://localhost`, …) are built in. |
| `ENVIRONMENT` | `production` disables dev shortcuts | In production: localhost origins are rejected and reset tokens are never returned. |
| `RESET_TOKEN_DEBUG` | Return reset token in non-production | Defaults to `1` outside production; ignored in production. |

## 3. Password hashing migration

Existing users are **not locked out**:

* Legacy hashes (static-salt SHA-256, 64 hex chars) are still verified.
* On the next successful login the password is transparently re-hashed with
  PBKDF2-HMAC-SHA256 (600,000 iterations, per-user random salt) and the new hash
  is stored. No user action is required.

Because Workers cannot load native modules, Argon2id/bcrypt are unavailable; see
`docs/SECURITY.md` for the full rationale.

## 4. Client behaviour changes

* Login/register now persist a **refresh token** (`rx-store-refresh-token`).
* The API client automatically refreshes once on a `401` and retries the request
  (single-flight, so a single-use rotated token is never replayed concurrently).
* `POST /auth/logout` revokes the current session; `{ allDevices: true }` revokes
  every session. Profile exposes "Sign out all devices". **Neither uninstalls
  applications** — sessions and installations are independent.
* CORS is now an allowlist. Native shells and the web app keep working; any other
  browser origin must be added to `CORS_ALLOWED_ORIGINS` explicitly.

## 5. Behaviour that intentionally fails closed

* `POST /payments/subscribe` returns `501 PAYMENTS_NOT_ENABLED` in production —
  no payment provider is integrated, so no paid access is ever granted.
* Duplicate/Rotated refresh tokens are rejected (replay protection).
* Requests from non-allowlisted browser origins receive no CORS grant, so the
  browser blocks the credentialed read.

## 6. Not configured (do not claim otherwise)

* Email delivery for password reset (no provider wired).
* Malware scanning, signed download URLs, signed update manifests.
* 2FA, account lockout, email verification.
* Compliance certifications.

See `docs/SECURITY.md` for the full IMPLEMENTED / PARTIAL / PLANNED matrix.
