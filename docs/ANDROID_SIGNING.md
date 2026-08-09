# Stable Android signing for future RX Store updates

Android accepts an APK as an update only when it is signed by the same key as the installed APK. Keep one release keystore permanently and use it for every RX Store release.

> Never commit the keystore or its passwords. Never paste them into issues, logs, or chat. Losing this keystore means existing Android installations cannot be updated in place.

## 1. Generate the keystore locally

Run this on a trusted computer with a JDK installed. `keytool` asks for the passwords interactively, so they do not appear in shell history:

```bash
keytool -genkeypair \
  -alias rxstore \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storetype PKCS12 \
  -keystore rx-store-release.p12
```

Back up `rx-store-release.p12` and the passwords in a secure password manager/offline backup.

## 2. Add GitHub Actions secrets

Encode the keystore without printing it:

```bash
base64 -w 0 rx-store-release.p12 > rx-store-release.p12.base64
```

In **GitHub → Rx-STORE → Settings → Secrets and variables → Actions**, create:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Contents of `rx-store-release.p12.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password entered in `keytool` |
| `ANDROID_KEY_ALIAS` | `rxstore` |
| `ANDROID_KEY_PASSWORD` | Key password entered in `keytool` |

Delete the temporary Base64 file after saving the secret:

```bash
rm rx-store-release.p12.base64
```

## 3. First stable-key release

If the APK currently installed on a device used a temporary/debug key, uninstall it once before installing the first APK signed by this stable key. Every later release can then install over the existing app as long as these same four secrets remain configured.

The release workflow injects the keystore into `android/app/release-keystore.p12` only on the GitHub runner. The file is ignored by Git and must never enter the repository.
