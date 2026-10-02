package com.leadingthink.miniq.push;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * Relay push key storage and payload decryption. Mirrors
 * ios/App/App/MiniqPushContent.swift: AES-256-GCM, 12-byte nonce, ciphertext
 * with the 16-byte tag appended, all base64url encoded.
 *
 * The relay key is wrapped with a non-exportable Android Keystore key before
 * it is written to SharedPreferences, so a backup or file dump alone cannot
 * decrypt pushes.
 */
public final class MiniqPushCrypto {
    private static final String PREFS = "miniq_push";
    private static final String PREF_WRAPPED_KEY = "wrapped_key";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String WRAP_ALIAS = "miniq_push_wrap";
    private static final int GCM_TAG_BITS = 128;

    private MiniqPushCrypto() {}

    public static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static byte[] base64UrlDecode(String text) {
        if (text == null || text.isEmpty()) return null;
        try {
            return Base64.decode(text, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    /** Stores a base64url AES-256 key. Returns false when the key is malformed. */
    public static boolean saveKey(Context context, String key) {
        byte[] raw = base64UrlDecode(key);
        if (raw == null || raw.length != 32) return false;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(raw);
            byte[] out = new byte[1 + iv.length + sealed.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(sealed, 0, out, 1 + iv.length, sealed.length);
            return prefs(context).edit().putString(PREF_WRAPPED_KEY, Base64.encodeToString(out, Base64.NO_WRAP)).commit();
        } catch (Exception error) {
            return false;
        }
    }

    public static void clearKey(Context context) {
        prefs(context).edit().remove(PREF_WRAPPED_KEY).apply();
    }

    public static SecretKey loadKey(Context context) {
        String stored = prefs(context).getString(PREF_WRAPPED_KEY, null);
        if (stored == null) return null;
        try {
            byte[] data = Base64.decode(stored, Base64.NO_WRAP);
            int ivLength = data[0] & 0xff;
            if (ivLength <= 0 || data.length <= 1 + ivLength) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), new GCMParameterSpec(GCM_TAG_BITS, data, 1, ivLength));
            byte[] raw = cipher.doFinal(data, 1 + ivLength, data.length - 1 - ivLength);
            return raw.length == 32 ? new SecretKeySpec(raw, "AES") : null;
        } catch (Exception error) {
            return null;
        }
    }

    /** Decrypts a relay push payload; returns null on any failure. */
    public static JSONObject decrypt(SecretKey key, String nonce, String ciphertext) {
        byte[] iv = base64UrlDecode(nonce);
        byte[] sealed = base64UrlDecode(ciphertext);
        if (key == null || iv == null || iv.length != 12 || sealed == null || sealed.length <= 16) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(sealed);
            return new JSONObject(new String(plain, StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        }
    }

    private static SecretKey wrappingKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry entry = store.getEntry(WRAP_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
