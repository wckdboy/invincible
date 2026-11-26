package sh.invincible.bot.core

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Web Push as a user agent reads it (RFC 8291 over RFC 8188's aes128gcm), for notifications through UnifiedPush: the node
 * encrypts each to this phone's own P-256 key and 16-byte secret, and the push service carries bytes it can't read. A
 * message is the salt, the record size, the node's one-time public key, then the records.
 */
object WebPush {
    private val P256: ECParameterSpec = AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp256r1"))
        getParameterSpec(ECParameterSpec::class.java)
    }

    /** This phone's side of a subscription: its private scalar (32 bytes), its public point (65, uncompressed), its secret (16). */
    class Keys(val privateScalar: ByteArray, val publicPoint: ByteArray, val auth: ByteArray)

    fun newKeys(random: SecureRandom = SecureRandom()): Keys {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }.generateKeyPair()
        val w = (pair.public as ECPublicKey).w
        return Keys(fixed((pair.private as ECPrivateKey).s), byteArrayOf(4) + fixed(w.affineX) + fixed(w.affineY), ByteArray(16).also(random::nextBytes))
    }

    /** What the node sent, its padding taken off. Throws when it isn't for these keys, or was changed on the way. */
    fun decrypt(body: ByteArray, keys: Keys): ByteArray {
        require(body.size > 21) { "not a Web Push message" }
        val salt = body.copyOfRange(0, 16)
        val recordSize = ByteBuffer.wrap(body, 16, 4).int.toLong() and 0xffffffffL
        val idLength = body[20].toInt() and 0xff
        require(recordSize >= 18 && idLength == 65 && body.size > 21 + idLength) { "not a Web Push message" }
        val sender = body.copyOfRange(21, 21 + idLength)
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, keys.privateScalar), P256)))
            doPhase(publicKey(sender), true)
            generateSecret()
        }
        // RFC 8291 §3.4: the secret salts the shared one, and both public keys are its info.
        val ikm = expand(Hash.hmac(keys.auth, shared), "WebPush: info".toByteArray() + byteArrayOf(0) + keys.publicPoint + sender, 32)
        // RFC 8188 §2.2: the content key and the nonce, from the message's own salt.
        val prk = Hash.hmac(salt, ikm)
        val key = SecretKeySpec(expand(prk, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16), "AES")
        val nonce = expand(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)
        val out = ByteArrayOutputStream()
        var at = 21 + idLength
        var sequence = 0L
        while (at < body.size) {
            val end = minOf(body.size.toLong(), at + recordSize).toInt()
            val iv = nonce.copyOf()
            for (i in 0 until 8) iv[11 - i] = (iv[11 - i].toInt() xor ((sequence ushr (8 * i)).toInt() and 0xff)).toByte()
            val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                doFinal(body, at, end - at)
            }
            // A record ends in its delimiter (2 for the last, 1 otherwise), then zeros.
            var last = plain.size - 1
            while (last >= 0 && plain[last] == 0.toByte()) last--
            require(last >= 0 && plain[last] == (if (end == body.size) 2 else 1).toByte()) { "a record without its delimiter" }
            out.write(plain, 0, last)
            at = end
            sequence += 1
        }
        return out.toByteArray()
    }

    private fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray = Hash.hmac(prk, info + byteArrayOf(1)).copyOf(length)

    private fun publicKey(point: ByteArray) = run {
        require(point.size == 65 && point[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, point.copyOfRange(1, 33)), BigInteger(1, point.copyOfRange(33, 65))), P256))
    }

    private fun fixed(n: BigInteger): ByteArray {
        val raw = n.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }
}
