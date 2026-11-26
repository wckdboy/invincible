package sh.invincible.bot.core

import java.math.BigInteger
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** base64url as packages/core/src/bytes.ts writes and reads it: unpadded, `-` and `_` for `+` and `/`. */
object Base64Url {
    fun encode(bytes: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Only A–Z, a–z, 0–9, `-` and `_`, no padding, and never a length one past a multiple of four (core's fromB64u). */
    fun decode(text: String): ByteArray? {
        if (text.length % 4 == 1 || !text.all { isCharacter(it) }) return null
        return try {
            java.util.Base64.getUrlDecoder().decode(text)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    fun isCharacter(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
}

/** SHA-256, HMAC-SHA256 and HKDF-SHA256 as core's crypto uses them, from what every JVM and Android has. */
object Hash {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun hmac(key: ByteArray, message: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            // (An empty key is HMAC's zero block: SecretKeySpec refuses empty bytes, and one zero byte pads the same.)
            init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
            doFinal(message)
        }

    /** RFC 5869 with no salt (HashLen zero bytes, which under HMAC is the empty salt core and Swift pass). */
    fun hkdf(ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmac(ByteArray(32), ikm)
        val out = ByteArray(length)
        var block = ByteArray(0)
        var at = 0
        var counter = 1
        while (at < length) {
            block = hmac(prk, block + info + byteArrayOf(counter.toByte()))
            val take = minOf(block.size, length - at)
            block.copyInto(out, at, 0, take)
            at += take
            counter += 1
        }
        return out
    }

    /** Constant time, on equal lengths; unequal or empty is no match. */
    fun same(a: ByteArray, b: ByteArray): Boolean {
        if (a.isEmpty() || a.size != b.size) return false
        var difference = 0
        for (i in a.indices) difference = difference or (a[i].toInt() xor b[i].toInt())
        return difference == 0
    }
}

/**
 * ECDSA P-256 signatures as the node reads them: IEEE P1363, r ‖ s, 32 bytes each (core's crypto.ts, which refuses
 * DER). Android's Keystore and the JVM sign in DER, so each signature is turned around once.
 */
object EcdsaSignature {
    fun rawFromDer(der: ByteArray): ByteArray {
        var i = 0
        fun byte(): Int = der[i++].toInt() and 0xFF
        fun length(): Int {
            val first = byte()
            if (first < 0x80) return first
            var n = 0
            repeat(first and 0x7F) { n = (n shl 8) or byte() }
            return n
        }
        require(byte() == 0x30) { "not a DER signature" }
        length()
        fun integer(): ByteArray {
            require(byte() == 0x02) { "not a DER signature" }
            val n = length()
            val value = der.copyOfRange(i, i + n)
            i += n
            val unsigned = BigInteger(1, value).toByteArray().let { if (it.size > 32 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
            require(unsigned.size <= 32) { "a signature's half is longer than P-256's" }
            return ByteArray(32 - unsigned.size) + unsigned
        }
        return integer() + integer()
    }

    fun derFromRaw(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "a raw P-256 signature is 64 bytes" }
        fun integer(half: ByteArray): ByteArray {
            val positive = BigInteger(1, half).toByteArray()
            return byteArrayOf(0x02, positive.size.toByte()) + positive
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
