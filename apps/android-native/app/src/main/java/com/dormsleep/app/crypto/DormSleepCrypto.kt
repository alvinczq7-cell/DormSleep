package com.dormsleep.app.crypto

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 标准密码学核心（与 shared/crypto.js 与 services/windows-companion/crypto_core.py 字节级一致）
 */
object DormSleepCrypto {
    private const val REQ_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    private val rng = SecureRandom()

    fun generateRequestId(): String {
        val part1 = buildString(4) {
            repeat(4) { append(REQ_ALPHABET[rng.nextInt(REQ_ALPHABET.length)]) }
        }
        val part2 = (10 + rng.nextInt(90)).toString()
        return "$part1-$part2"
    }

    fun canonicalPayload(
        pairId: String,
        sessionId: String,
        requestId: String,
        actionType: String,
        targetAppId: String?,
    ): String {
        val target = if (actionType == "END_TONIGHT") "ALL" else (targetAppId ?: "ALL")
        return "$pairId|$sessionId|${requestId.trim().uppercase()}|$actionType|$target"
    }

    /**
     * 标准 HMAC-SHA256 + RFC 4226 Dynamic Truncation（6 位数字）。
     * 用于离线模式下手机本地校验电脑端派生的应急码。
     */
    fun deriveOfflineEmergencyCode(
        sharedSecret: String,
        pairId: String,
        sessionId: String,
        requestId: String,
        actionType: String,
        targetAppId: String?,
    ): String {
        val msg = canonicalPayload(pairId, sessionId, requestId, actionType, targetAppId)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sharedSecret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        val digest = mac.doFinal(msg.toByteArray(StandardCharsets.UTF_8))

        val offset = digest[digest.size - 1].toInt() and 0x0f
        val binary =
            ((digest[offset].toInt() and 0x7f) shl 24) or
                ((digest[offset + 1].toInt() and 0xff) shl 16) or
                ((digest[offset + 2].toInt() and 0xff) shl 8) or
                (digest[offset + 3].toInt() and 0xff)

        return (binary % 1_000_000).toString().padStart(6, '0')
    }

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun signLanRequest(
        sharedSecret: String,
        pairId: String,
        timestampMs: Long,
        nonce: String,
        method: String,
        path: String,
        bodyBytes: ByteArray,
    ): String {
        val bodySha = sha256Hex(bodyBytes)
        val signingStr = "$pairId|$timestampMs|$nonce|${method.uppercase()}|$path|$bodySha"
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sharedSecret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(signingStr.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    fun constantTimeEquals(a: String, b: String): Boolean {
        return MessageDigest.isEqual(
            a.toByteArray(StandardCharsets.UTF_8),
            b.toByteArray(StandardCharsets.UTF_8),
        )
    }
}
