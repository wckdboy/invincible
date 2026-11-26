package sh.invincible.bot.core

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** The two pairing endpoints, which take no signature: the invite's proof is the credential. */
fun interface PairTransport {
    /** POSTs [body] as JSON; nothing answering at all throws [Joining.Stop] (unreachable). */
    suspend fun post(path: String, body: Json.Obj): Pair<Int, ByteArray>
}

/**
 * This phone joining a fleet with one invite, as the PWA's pairing page and the Apple app do it: prove it holds the
 * invite, show the code derived from (secret, fleet, its own key), wait for your approval on the node, and trust that
 * approval only with the proof that only the invite's holder can make. The secret never leaves this phone.
 */
class Joining(val invite: Invite, val device: String, private val transport: PairTransport) {
    /** Why joining stopped, and what that means for what comes next. */
    sealed class Stop(message: String) : Exception(message) {
        /** A definite no: this invite is done with; a fresh one is needed. */
        class Ended(why: String) : Stop(why)
        /** Refused as asked; asking again may do. */
        class Refused(why: String) : Stop(why)
        /** This key is enrolled already (approved earlier, then the app was closed): a signed request will tell. */
        class AlreadyEnrolled : Stop("This phone is already in the fleet.")
        /** Approved while the app was away, or not: the status proof will tell. */
        class AlreadyUsed : Stop("This invite was already used.")
        /** No answer. Nothing is lost: the invite still holds. */
        class Unreachable(why: String) : Stop(why)
    }

    /** The six-digit code this phone shows, which the node shows too when the invite reached it untouched. */
    val code: String get() = PairingMath.sas(invite.secret, invite.f, device)

    /** Step 1: ask to join. The node's code must be this phone's own, or joining stops here. */
    suspend fun ask(name: String) {
        val fields = PairingMath.requestFields(invite.i, device, name)
        val body = Json.Obj(fields.fields + ("proof" to Json.Str(PairingMath.requestProof(invite.secret, fields))))
        val (status, data) = transport.post("/link/pair/request", body)
        if (status != 200) {
            val said = said(status, data)
            if (status == 409 && "already enrolled" in said) throw Stop.AlreadyEnrolled()
            if (status == 409 && "already used" in said) throw Stop.AlreadyUsed()
            throw stop(status, said)
        }
        val sas = runCatching { Json.parse(String(data, Charsets.UTF_8))["sas"].string }.getOrNull()
        if (sas != code) throw Stop.Ended("The node computed a different code. Stopping here, to be safe.")
    }

    /** Step 2: the node's answer now. An approval counts only with its proof, and only for the invite's fleet. */
    suspend fun approved(): Boolean {
        val proof = PairingMath.statusProof(invite.secret, invite.i, device)
        val (status, data) = transport.post("/link/pair/status", Json.obj("invite" to invite.i, "device" to device, "proof" to proof))
        if (status != 200) throw stop(status, said(status, data))
        val answer = runCatching { Json.parse(String(data, Charsets.UTF_8)) }.getOrNull()
        return when (answer["status"].string) {
            "rejected" -> throw Stop.Ended("The pairing was declined on the node.")
            "approved" -> {
                val expected = PairingMath.approvalProof(invite.secret, invite.i, device, invite.f)
                val approval = answer["approval"].string
                if (answer["fleet"].string != invite.f || approval == null || !PairingMath.proofMatches(expected, approval)) {
                    throw Stop.Ended("The approval could not be verified. Stopping here, to be safe.")
                }
                true
            }
            else -> false
        }
    }

    /**
     * Waits for your answer on the node: asks again every 1.5 s, and rides out a lost connection, waiting longer each
     * time (1.5 s × 2ⁿ, at most 10 s). [onRetry] says whether the last ask went unanswered.
     */
    suspend fun approval(sleep: suspend (Long) -> Unit = { delay(it) }, onRetry: (Boolean) -> Unit = {}) {
        var failures = 0
        while (true) {
            try {
                if (approved()) return
                failures = 0
                onRetry(false)
                sleep(1500)
            } catch (_: Stop.Unreachable) {
                failures += 1
                onRetry(true)
                sleep(minOf(10_000L, 1500L shl minOf(failures, 3)))
            }
        }
    }

    companion object {
        /**
         * Where the pairing requests go: the address the link was made for (where the PWA would have been opened), or,
         * for a bare invite, the inviting node's own endpoint. Null when that isn't an http(s) address.
         */
        fun origin(text: String, invite: Invite): String? {
            val trimmed = text.trim()
            val link = if (trimmed.startsWith("gi1.")) invite.e else trimmed
            return try {
                val u = URI(link)
                val scheme = u.scheme?.lowercase()
                if (scheme !in setOf("http", "https") || u.host.isNullOrEmpty()) return null
                URI(scheme, null, u.host, u.port, null, null, null).toString()
            } catch (_: Exception) {
                null
            }
        }

        /**
         * What an `invincible:` link hands this phone to join with: the invite link it carries (`invincible:https://<your node>/#pair=gi1.…`),
         * whose address is where the node is; or the invite alone (`invincible://pair#pair=gi1.…`, `invincible:gi1.…`). Null for
         * any other link, and for one that carries no invite.
         */
        fun handed(link: String): String? {
            if (!link.lowercase().startsWith("invincible:")) return null
            val rest = link.substringAfter(':')
            val carried = runCatching { URI(rest).scheme?.lowercase() }.getOrNull()
            if (carried == "http" || carried == "https") return rest.takeIf { runCatching { Invite.decode(it) }.isSuccess }
            val token = Regex("[#&?]pair=([A-Za-z0-9._-]+)").find(rest)?.groupValues?.get(1) ?: rest.trimStart('/')
            return token.takeIf { runCatching { Invite.decode(it) }.isSuccess }
        }

        private fun said(status: Int, data: ByteArray): String =
            runCatching { Json.parse(String(data, Charsets.UTF_8))["error"].string }.getOrNull() ?: "The node answered $status."

        private fun stop(status: Int, said: String): Stop = when {
            status == 404 || status == 403 -> Stop.Ended("This invite has expired or is no longer valid.")
            status == 409 -> Stop.Ended(said)
            status in listOf(502, 503, 504) -> Stop.Unreachable("Invincible's node isn't answering ($status). It may be restarting.")
            status >= 500 -> Stop.Unreachable(said)
            else -> Stop.Refused(said)
        }
    }
}

/** The pairing endpoints over HTTP, at the address the invite came for. A stalled connection is unreachable after 12 s. */
class HttpPairTransport(private val origin: String) : PairTransport {
    override suspend fun post(path: String, body: Json.Obj): Pair<Int, ByteArray> = withContext(Dispatchers.IO) {
        val host = runCatching { URL(origin).host }.getOrNull() ?: "the node"
        val bytes = body.text().toByteArray(Charsets.UTF_8)
        try {
            val c = URL(origin.trimEnd('/') + path).openConnection() as HttpURLConnection
            try {
                c.requestMethod = "POST"
                c.instanceFollowRedirects = false
                c.useCaches = false
                c.connectTimeout = 12_000
                c.readTimeout = 12_000
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
                val status = c.responseCode
                val data = (if (status in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes() } ?: ByteArray(0)
                // `tailscale serve` answering for a node that's away: the node isn't refusing.
                if (status in listOf(502, 503, 504) && c.getHeaderField("content-type")?.contains("application/json") != true) {
                    throw Joining.Stop.Unreachable("Invincible's node isn't answering ($status). It may be restarting.")
                }
                status to data
            } finally {
                c.disconnect()
            }
        } catch (e: IOException) {
            throw Joining.Stop.Unreachable(if (e is SocketTimeoutException) "No answer from $host within 12 s." else "Can't reach $host.")
        }
    }
}
