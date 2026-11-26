package sh.invincible.bot.core

import java.net.URI

/*
 * Joining a fleet as a new device, as packages/core/src/pairing.ts defines it:
 *  1. A trusted node mints a one-time invite (a 32-byte secret, ten minutes, used once).
 *  2. This device proves it holds the invite (an HMAC over its own fields) without ever sending the secret.
 *  3. Both sides derive a six-digit code from the secret, the fleet and this device's key. You approve only if the codes
 *     match: someone who intercepted the invite has another key, and so another code.
 *  4. The node's approval comes with a proof only the invite's holder can make, checked before it is trusted.
 */

/** An invite (core's Invite): exactly six fields, each as core's schema has it. */
data class Invite(val v: Int, val e: String, val f: String, val i: String, val s: String, val k: String) {
    val secret: ByteArray get() = Base64Url.decode(s) ?: ByteArray(0)

    class Refused(message: String) : Exception(message)

    companion object {
        private val pairIn = Regex("[#&?]pair=([A-Za-z0-9._-]+)")

        /** A bare invite (`gi1.…`), or any text carrying `#pair=<invite>` (core's decodeInvite). */
        fun decode(text: String): Invite {
            val trimmed = text.trim()
            val token = pairIn.find(trimmed)?.groupValues?.get(1) ?: trimmed
            val json = if (token.startsWith("gi1.")) Base64Url.decode(token.substring(4)) else null
            val parsed = try {
                json?.let { Json.parse(String(it, Charsets.UTF_8)) }
            } catch (_: JsonError) {
                null
            }
            return parsed?.let(::of) ?: throw Refused("That isn't an Invincible invite.")
        }

        private fun of(json: Json): Invite? {
            // A strict object: a field core doesn't know makes it no invite at all.
            if (json !is Json.Obj || json.fields.keys != setOf("v", "e", "f", "i", "s", "k")) return null
            val v = json["v"].long?.toInt() ?: return null
            val e = json["e"].string ?: return null
            val f = json["f"].string ?: return null
            val i = json["i"].string ?: return null
            val s = json["s"].string ?: return null
            val k = json["k"].string ?: return null
            val base64url = { t: String -> t.isNotEmpty() && t.all(Base64Url::isCharacter) }
            if (v != 1 || !isUrl(e) || f.length != 43 || !base64url(f) || !base64url(i) || !base64url(s) || (k != "client" && k != "node")) return null
            return Invite(v, e, f, i, s, k)
        }

        /** What core's z.string().url() takes here: an absolute URL with a scheme and a host. */
        private fun isUrl(text: String): Boolean = try {
            val u = URI(text)
            !u.scheme.isNullOrEmpty() && !u.host.isNullOrEmpty()
        } catch (_: Exception) {
            false
        }
    }
}

/** The pairing math (core's pairing.ts): HKDF-SHA256 from the invite's secret, then HMAC-SHA256 for each proof. */
object PairingMath {
    private fun mac(secret: ByteArray, message: String): String =
        Base64Url.encode(Hash.hmac(Hash.hkdf(secret, "invincible/pair/v1/mac".toByteArray(), 32), message.toByteArray(Charsets.UTF_8)))

    /** What this device says of itself, as core canonicalises it: device, invite, kind, name. */
    fun requestFields(invite: String, device: String, name: String, kind: String = "client"): Json.Obj =
        Json.obj("invite" to invite, "device" to device, "name" to name, "kind" to kind)

    fun requestProof(secret: ByteArray, fields: Json.Obj): String = mac(secret, "request|${fields.canonical()}")

    fun statusProof(secret: ByteArray, invite: String, device: String): String = mac(secret, "status|$invite|$device")

    fun approvalProof(secret: ByteArray, invite: String, device: String, fleet: String): String = mac(secret, "approved|$invite|$device|$fleet")

    /** Constant time, on the bytes; anything that isn't base64url matches nothing. */
    fun proofMatches(expected: String, given: String): Boolean {
        val a = Base64Url.decode(expected) ?: return false
        val b = Base64Url.decode(given) ?: return false
        return Hash.same(a, b)
    }

    /** The six-digit code both screens show, as "482 913". */
    fun sas(secret: ByteArray, fleet: String, device: String): String {
        val b = Hash.hkdf(secret, "invincible/pair/v1/sas|$fleet|$device".toByteArray(Charsets.UTF_8), 4)
        val n = (((b[0].toLong() and 0xFF) shl 24) or ((b[1].toLong() and 0xFF) shl 16) or ((b[2].toLong() and 0xFF) shl 8) or (b[3].toLong() and 0xFF)) % 1_000_000
        val digits = n.toString().padStart(6, '0')
        return "${digits.substring(0, 3)} ${digits.substring(3)}"
    }
}
