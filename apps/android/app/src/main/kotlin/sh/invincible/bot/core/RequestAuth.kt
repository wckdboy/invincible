package sh.invincible.bot.core

import java.security.SecureRandom

/** Something that signs as this device: the Keystore's key on a phone, a known scalar in the tests. */
interface Signer {
    /** `c_` and the base64url of the key's uncompressed point (core's identity.ts). */
    val device: String

    /** ECDSA P-256 over SHA-256 of [message], as raw r ‖ s. */
    fun sign(message: ByteArray): ByteArray
}

/**
 * Every request to the node is signed by the device key, as packages/core/src/request-auth.ts verifies it: the domain,
 * the method, the path with its query, the time, a nonce and the body's hash, one per line, and the node it is for, last
 * (`invincible-req/v2`), so another node refuses it (the slice 8 note's item 11). With no node, `invincible-req/v1` and
 * none: what whoami's proof is asked with (NodeProof), and what a node from before reads. A nonce is spent once and the
 * time may be a minute off at most, so a request is signed afresh each time it is sent, never resent as it was.
 */
object RequestAuth {
    const val DOMAIN = "invincible-req/v1"
    const val DOMAIN_NAMED = "invincible-req/v2"
    const val DEVICE = "x-invincible-device"
    const val TS = "x-invincible-ts"
    const val NONCE = "x-invincible-nonce"
    const val SIG = "x-invincible-sig"
    /** This device's time zone, beside the signature (core's ZONE_HEADER): the time it says it is in an answer to you. Only a hint. */
    const val ZONE = "x-invincible-tz"
    const val MAX_SKEW_MS = 60_000L

    private val random = SecureRandom()

    fun bodyHash(body: ByteArray): String = Base64Url.encode(Hash.sha256(body))

    /** What is signed: for [node], as that node proved it (v2), or for none (v1). */
    fun signingInput(method: String, path: String, ts: String, nonce: String, body: ByteArray, node: String? = null): ByteArray {
        val parts = listOf(method.uppercase(), path, ts, nonce, bodyHash(body)) + listOfNotNull(node)
        return "${if (node == null) DOMAIN else DOMAIN_NAMED}\n${parts.joinToString("\n")}".toByteArray(Charsets.UTF_8)
    }

    /** Twelve random bytes: sixteen characters of base64url. */
    fun nonce(): String = Base64Url.encode(ByteArray(12).also { random.nextBytes(it) })

    fun headers(signer: Signer, method: String, path: String, body: ByteArray, ts: String = System.currentTimeMillis().toString(), nonce: String = nonce(), node: String? = null): Map<String, String> {
        val signature = signer.sign(signingInput(method, path, ts, nonce, body, node))
        return mapOf(DEVICE to signer.device, TS to ts, NONCE to nonce, SIG to Base64Url.encode(signature))
    }

    /** A device id from a P-256 public key as Java encodes it (X.509 SubjectPublicKeyInfo, the point last). */
    fun deviceOf(spki: ByteArray): String {
        require(spki.size >= 65) { "not a P-256 public key" }
        val point = spki.copyOfRange(spki.size - 65, spki.size)
        require(point[0] == 0x04.toByte()) { "not an uncompressed P-256 point" }
        return "c_" + Base64Url.encode(point)
    }
}
