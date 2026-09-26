# Windows Code Signing — current state & future setup

## Current state (honest)

The production Windows installer (`RXStore-Setup-<version>.exe`) is **UNSIGNED**.
Every release says so explicitly in its notes — the release pipeline generates
that label itself and never claims a signature that does not exist:

> "The Windows installer is UNSIGNED (no code-signing certificate is configured on this deployment)."

What this means in practice:

* Windows SmartScreen shows *"Windows protected your PC"* on first run — users
  must click **More info → Run anyway**.
* The binary carries no publisher identity and no cryptographic tamper
  protection.
* Nothing is hidden: the release notes, the admin panels and this document all
  state the same thing.

This is an accepted business decision for now, not an oversight. When a
certificate is configured, the pipeline signs automatically and the release
notes flip to **"The Windows installer is code-signed."** — that label is the
proof.

## When you are ready: setup guide (~20 minutes after purchase)

### 1. Buy a certificate

| Option | Approx. cost | Notes |
| --- | --- | --- |
| **Certum "Open Source Code Signing"** | ~€25–70/yr | Cheap, designed for open-source; standard OV. Private key on a SimplySign cloud token (no USB stick needed) |
| **SSL.com / Sectigo OV** | ~$130–240/yr | Standard OV code signing |
| **Azure Trusted Signing** | ~$10/mo | Microsoft-hosted signing (no cert file — needs a different pipeline step; ask and it will be wired) |

Individual (OV) certificates are fine; EV (hardware token, ~$300+/yr) removes
the SmartScreen warning *immediately*, OV builds reputation over time after
enough installs. For a store like RX Store, OV is the sensible start.

### 2. Export the certificate as a PFX file

From your CA's issuance flow, export/install the certificate into the Windows
certificate store, then export it **with the private key** as a `.pfx` file
(e.g. `rxstore-codesign.pfx`). Remember the password you set — it becomes
`WIN_CSC_KEY_PASSWORD`.

### 3. Base64-encode it (without printing the file)

On Linux/WSL/Git-Bash:

```bash
base64 -w 0 rxstore-codesign.pfx > rxstore-codesign.pfx.base64
wc -c rxstore-codesign.pfx.base64   # sanity: should be ~1.3× the PFX size
```

### 4. Set the two GitHub secrets

GitHub → Rx-STORE → **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `WIN_CSC_LINK_B64` | contents of `rxstore-codesign.pfx.base64` |
| `WIN_CSC_KEY_PASSWORD` | the PFX password |

Then delete the local files:

```bash
rm rxstore-codesign.pfx rxstore-codesign.pfx.base64
```

Never paste the PFX or the password into issues, chat, or commits.

### 5. (Recommended then) flip the fail-closed switch

Repository **Settings → Secrets and variables → Actions → Variables**:

```
REQUIRE_WIN_SIGNING = true
```

From that moment the release pipeline **fails hard** if a Windows build would
be unsigned — an unsigned installer can never be published again, even by
accident. (This switch is deliberately NOT set today because no certificate is
configured yet — it would block every release.)

### 6. Release and verify

Tag the next version as usual. Verification is automatic and visible:

* The release notes say **"The Windows installer is code-signed."** (generated
  by the pipeline only when the certificate was actually used).
* Locally: right-click the `.exe` → Properties → **Digital Signatures** tab
  shows the certificate. Or:
  ```powershell
  Get-AuthenticodeSignature .\RXStore-Setup-1.5.4.exe | Format-List
  ```

## How the pipeline handles signing (reference)

`.github/workflows/release.yml` → *"Windows signing configuration (explicit)"*:

* `WIN_CSC_LINK_B64` present → decoded to a file, `WIN_CSC_LINK` +
  `WIN_CSC_KEY_PASSWORD` exported for electron-builder → installer is signed.
* Absent + `REQUIRE_WIN_SIGNING=true` → **release fails closed**.
* Absent without the switch → installer builds UNSIGNED and the release notes
  say so (today's behaviour).

No certificate material is ever committed to the repository (`.gitignore`
blocks keystore/certificate file types).
