package com.dormsleep.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 基于 Android Keystore (AES/GCM/NoPadding) 的共享密钥安全存储。
 * 注意：仅向本地校验引擎与局域网签名模块开放，绝不向 WebView 前端暴露明文密钥。
 */
class KeystoreSecretStore(context: Context) {
    private val prefs = context.getSharedPreferences("dormsleep_keystore_vault", Context.MODE_PRIVATE)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "dormsleep_pair_secret_aes_key"
        private const val PREF_IV = "secret_iv"
        private const val PREF_CIPHER = "secret_cipher"
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        keyGen.init(spec)
        return keyGen.generateKey()
    }

    fun saveSharedSecret(secret: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(secret.toByteArray(StandardCharsets.UTF_8))
        prefs.edit()
            .putString(PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(PREF_CIPHER, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply()
    }

    fun loadSharedSecret(): String? {
        val ivB64 = prefs.getString(PREF_IV, null) ?: return null
        val ctB64 = prefs.getString(PREF_CIPHER, null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(128, Base64.decode(ivB64, Base64.NO_WRAP))
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), spec)
        val plain = cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP))
        return String(plain, StandardCharsets.UTF_8)
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
