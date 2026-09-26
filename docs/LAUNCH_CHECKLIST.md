# RX Store — Production Launch Checklist

The ~30-minute operator runbook. Every item is a LIVE verification that
repository inspection cannot prove. Work top to bottom; each item says exactly
how to verify it. Nothing here modifies production data.

## Standing pre-flight (2 min)

```bash
cd ~/Documents/Rx-STORE
./scripts/release-preflight.sh
```

Expect `READY` with only optional warnings. This checks Worker secrets
presence, `[vars]`, frontend config and the latest release state — never
secret values.

Confirm the deployed API answers:

```bash
curl -s https://rx-store-api.calcitoninpay.workers.dev/v1/auth/oauth/providers
# {"success":true,"data":{"google":true,"github":true}}
```

## 1. Google sign-in — live round-trip (3 min)

1. Open **https://rx-store-web.pages.dev/login** (incognito).
2. Click **Continue with Google** → complete the Google consent.
3. ✅ You land back on RX Store **signed in**.
4. Check **Profile → Security**: Google shows **CONNECTED**.

If it fails with a redirect error → the console redirect URI does not match.
Required (exact): `https://rx-store-api.calcitoninpay.workers.dev/auth/oauth/google/callback`.
If Google shows "access blocked" → the OAuth consent screen is in *Testing*
mode: add your Google account as a test user, or click **Publish app**.

## 2. GitHub sign-in — live round-trip (3 min)

Same as above with **Continue with GitHub**. Required callback (exact):
`https://rx-store-api.calcitoninpay.workers.dev/auth/oauth/github/callback`.

## 3. Safe linking sanity check (2 min)

While signed in with Google from step 1, try the password login with the SAME
email on another browser: RX Store must ask you to confirm with the account
password before linking — never merge silently.

## 4. Paystack webhook + one live purchase (5 min)

1. Paystack dashboard → **Settings → API Keys & Webhooks** → add:
   ```
   https://rx-store-api.calcitoninpay.workers.dev/payments/webhook/paystack
   ```
2. In RX Store, buy your cheapest paid app with a real (small) amount.
3. ✅ Entitlement unlocks → the app downloads.
4. Open **Admin → Payments**: the status header shows the webhook event
   counter ≥ 1 (`charge.success`) and the transaction in the list.

## 5. VirusTotal — one real scan (5 min)

Upload a small test package through the normal release/publish flow (admin).
The package security pipeline runs the real scan. Verify in the admin package
security view: a VirusTotal result (clean/detected/unknown-hash), not
`UNAVAILABLE`.

## 6. Email deliverability (5 min)

Resend dashboard → **Domains** → add + verify your sending domain, then ensure
the Worker secret `FROM_EMAIL` uses it (e.g. `notifications@yourdomain.com`).
Test: request a password reset for a real mailbox → the email arrives.
Until the domain is verified, delivery only works to the account owner's
address (the UI reports failures honestly).

## 7. Admin inbox loop (2 min)

Incognito → **/advertise** → submit the booking form → your admin bell shows
`📣 Ad booking` within a minute → click it → the message opens in
**Admin → Inbox** → reply with the *ad_approved* template → email arrives.

## 8. Real-device QA (10 min)

| Check | Expected |
| --- | --- |
| Install `rx-store-<v>.apk` over the previous version (do NOT uninstall) | App updates, user **still signed in** |
| Reboot phone → open app | Still signed in |
| Tap a `rxstore://app/<slug>` link (e.g. from the SDK sample) | RX Store opens directly on that app page |
| Desktop: with v1.5.2+ installed, after a new release | Update banner offers v<new>, installs on quit, user stays signed in |
| Kill app from recents → reopen | Still signed in |

## 9. Go / no-go

All green → the store is live-ready. Anything red → fix that item only; the
rest of the system keeps working (every degraded capability fails honestly,
never silently).
