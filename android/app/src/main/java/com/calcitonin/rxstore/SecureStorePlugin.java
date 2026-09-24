package com.calcitonin.rxstore;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Persistent, Keystore-backed credential storage for the long-lived RX Store
 * refresh token.
 *
 * Values live in the app's PRIVATE SharedPreferences file, each value
 * encrypted with an AES-256-GCM key that never leaves the Android Keystore.
 * Because the store is part of the app's private data directory it:
 *   - survives app updates (APK replacement) and Play-style updates,
 *   - survives process death, WebView recreation and device reboots,
 *   - is removed only when the app data is uninstalled or the JS layer calls
 *     remove/clear (explicit sign-out).
 *
 * The WebView's localStorage keeps a working copy too; the JS layer
 * (src/native/credentialStore.ts) reconciles the two at startup and mirrors
 * every write, so neither an update nor a WebView storage loss can sign the
 * user out.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String PREFS_NAME = "rx_secure_store";
    private static final String KEY_ALIAS = "rx_store_credential_key";
    private static final int GCM_IV_LENGTH = 12; // bytes — fixed by AndroidKeyStore GCM
    private static final int GCM_TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** Fetch (or lazily create) the AES key inside the Android Keystore. */
    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    /** AES-GCM encrypt → base64(iv || ciphertext+tag). */
    private String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    /** base64(iv || ciphertext+tag) → AES-GCM decrypt. */
    private String decrypt(String blob) throws Exception {
        byte[] all = Base64.decode(blob, Base64.NO_WRAP);
        if (all.length <= GCM_IV_LENGTH) throw new IllegalArgumentException("corrupt blob");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                new GCMParameterSpec(GCM_TAG_BITS, all, 0, GCM_IV_LENGTH));
        byte[] plain = cipher.doFinal(all, GCM_IV_LENGTH, all.length - GCM_IV_LENGTH);
        return new String(plain, StandardCharsets.UTF_8);
    }

    /** Get a value. Resolves { value: string } — absent key → value omitted. */
    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key", "");
        if (key.isEmpty()) { call.reject("key is required"); return; }
        try {
            String blob = prefs().getString(key, null);
            JSObject ret = new JSObject();
            if (blob != null) ret.put("value", decrypt(blob));
            call.resolve(ret);
        } catch (Exception e) {
            // A blob we cannot decrypt (e.g. Keystore wiped by a factory reset)
            // is equivalent to "no credential": drop it and report absent so
            // the JS layer falls back to its other copy instead of crashing.
            prefs().edit().remove(key).apply();
            call.resolve(new JSObject());
        }
    }

    /** Set (encrypt + persist) a value. */
    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        if (key.isEmpty()) { call.reject("key is required"); return; }
        try {
            prefs().edit().putString(key, encrypt(value)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure set failed", e);
        }
    }

    /** Remove a single value. */
    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key", "");
        if (key.isEmpty()) { call.reject("key is required"); return; }
        prefs().edit().remove(key).apply();
        call.resolve();
    }

    /** Remove every value (sign-out). */
    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().clear().apply();
        call.resolve();
    }
}
