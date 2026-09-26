# RX Store — Backup & Recovery Runbook

Honest scope: the repository contains **no automated backup job**. Production
data lives in three Cloudflare resources; this runbook documents what each
provides, what you should schedule manually, and how to recover.

## What holds production data

| Resource | Contents | Loss impact | Platform protection |
| --- | --- | --- | --- |
| **D1 `rx-store-db`** | Users, sessions, purchases, entitlements, releases, packages, inbox — everything | **Critical** | Cloudflare-managed durability + **Time Travel** (point-in-time recovery; availability/retention depends on your plan — check the D1 dashboard) |
| **R2 `rx-store-storage`** | App packages, quarantine, icons/attachments | **High** (binaries; metadata is in D1) | Cloudflare-managed durability; **no versioning/backup by default** |
| **KV `CACHE`** | Rate-limit windows, settings cache | **Low** (self-healing) | None needed |

## Backup routine (recommended)

### D1 — scheduled export (the one that matters)

Manual export:

```bash
npx wrangler d1 export rx-store-db --remote --output backups/rx-store-db-$(date +%F).sql
```

Schedule it (pick one):

* **GitHub Actions** — a tiny workflow running the export on a cron and
  storing it privately (ask and it will be added), or
* **cron on your machine**:
  ```bash
  # crontab -e  (daily 03:00, keep 30 days)
  0 3 * * * cd ~/Documents/Rx-STORE && npx wrangler d1 export rx-store-db --remote --output backups/rx-store-db-$(date +\%F).sql && find backups -name 'rx-store-db-*.sql' -mtime +30 -delete
  ```

Backups are plain SQL — **they contain password hashes, hashed refresh tokens
and purchase records. Store them somewhere private** (encrypted disk/private
bucket), never in the repository.

### R2 — periodic mirror

R2 exposes an S3-compatible API; mirror the bucket with rclone:

```bash
rclone sync :s3,provider=Cloudflare,endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com: rxstore-mirror --s3-access-key-id <KEY> --s3-secret-access-key <SECRET>
```

(Read-only R2 API credentials can be created in the Cloudflare dashboard.)
A weekly mirror is plenty — package uploads are rare events.

### Time Travel (built-in, plan-dependent)

D1 keeps a point-in-time history. Restore from the **D1 dashboard** (database →
Time Travel) or check `npx wrangler d1 time-travel --help` for your wrangler
version. Verify your plan's retention window in the dashboard — do not assume
30 days.

## Recovery procedures

### D1 partial (bad migration / accidental row damage)

1. Export the CURRENT state first (so you can diff):
   `npx wrangler d1 export rx-store-db --remote --output pre-restore.sql`
2. Preferred: **Time Travel** restore to a timestamp before the damage.
3. Or import a known-good backup:
   ```bash
   npx wrangler d1 execute rx-store-db --remote --file=backups/rx-store-db-<date>.sql
   ```
   (D1 executes the SQL as one import — the backup is a full schema+data dump.)

### D1 total loss

Recreate from the last export (same command as above). The exported SQL is
complete (all 50 tables) — after import, run the preflight script to confirm.

### R2 object loss

Re-upload from the rclone mirror, or re-publish affected packages via the
admin release flow (package metadata is in D1; only the bytes live in R2).

### KV loss

No action. Rate-limit windows rebuild on traffic; the settings cache refetches
from D1 within 30 seconds.

## Pre-release checklist (before every `git tag vX.Y.Z`)

- [ ] `./scripts/release-preflight.sh` → READY
- [ ] Fresh D1 export taken and stored off-machine
- [ ] (If packages shipped since last mirror) rclone sync done
- [ ] `npx wrangler d1 execute rx-store-db --remote --command "PRAGMA foreign_key_check"` returns no rows

## RPO/RTO summary

| With | RPO (max data loss) | RTO (restore time) |
| --- | --- | --- |
| Time Travel only | Plan-dependent window | Minutes (dashboard) |
| Daily export | ≤ 24 h | Minutes–an hour (import) |
| Daily export + R2 mirror | ≤ 24 h (DB) / ≤ 1 week (packages) | ~1 hour full rebuild |
