package sh.invincible.bot.core

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext

/** What went wrong, in the node's own words where it said any. */
class NodeError(
    /** The HTTP status; 0 when nothing answered. */
    val status: Int,
    message: String,
    /** The node's clock (its Date header): a phone's clock a minute off is refused, which isn't a revoked key. */
    val serverTime: Long? = null,
    /** Nothing answered, or a proxy answered for a node that's away: try again later; it isn't a refusal. */
    val unreachable: Boolean = false,
) : Exception(message) {
    companion object {
        fun from(status: Int, contentType: String?, date: String?, body: ByteArray): NodeError {
            val serverTime = date?.let { runCatching { httpDate().parse(it)?.time }.getOrNull() }
            if (status in listOf(502, 503, 504) && contentType?.contains("application/json") != true) {
                return NodeError(status, "Invincible's node isn't answering ($status). It may be restarting.", serverTime, unreachable = true)
            }
            val said = runCatching { Json.parse(String(body, Charsets.UTF_8))["error"].string }.getOrNull()
            return NodeError(status, said ?: "The node answered $status.", serverTime)
        }

        /** A long-running answer has already sent 200 when its work fails: the failure arrives as exactly `{error, status}`. */
        fun late(body: Json): NodeError? {
            val f = body.fields
            if (f.size != 2) return null
            val error = f["error"].string ?: return null
            val status = f["status"].int ?: return null
            return NodeError(status, error)
        }

        private fun httpDate() = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }
    }
}

/**
 * This phone talking to its node. Every /api request is signed with the device key over (method, path, time, nonce,
 * body hash) and sent with exactly those bytes, as the PWA's signedFetch and the Apple app do. Nothing is cached, and
 * a redirect is never followed: a signed request goes only where it was meant to go. Nothing is retried either: a
 * nonce is spent once, so a request is only ever signed afresh.
 */
class NodeClient(val origin: String, private val signer: Signer) {
    private val host: String = runCatching { URL(origin).host }.getOrNull() ?: "the node"

    private fun open(method: String, path: String, body: ByteArray?, readTimeoutMs: Int): HttpURLConnection {
        require(path.startsWith("/")) { "$path isn't a path on the node" }
        val c = URL(origin.trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.instanceFollowRedirects = false
        c.useCaches = false
        c.connectTimeout = 15_000
        c.readTimeout = readTimeoutMs
        for ((name, value) in RequestAuth.headers(signer, method, path, body ?: ByteArray(0))) c.setRequestProperty(name, value)
        c.setRequestProperty(RequestAuth.ZONE, java.util.TimeZone.getDefault().id)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.setFixedLengthStreamingMode(body.size)
            c.outputStream.use { it.write(body) }
        }
        return c
    }

    /** The node couldn't be reached, in words: never the network library's own text, which names its classes and objects. */
    private fun unreachable(e: IOException): NodeError = NodeError(
        0,
        when (e) {
            is SocketTimeoutException -> "No answer from $host in time."
            is java.net.ConnectException -> "Nothing answers at $host. Is the node running?"
            is java.net.UnknownHostException -> "$host can't be found from this phone. Is it on your tailnet?"
            is javax.net.ssl.SSLException -> "$host's certificate wasn't accepted."
            else -> "Lost the connection to $host."
        },
        unreachable = true,
    )

    private suspend fun send(method: String, path: String, body: Json?): Json = withContext(Dispatchers.IO) {
        val bytes = body?.text()?.toByteArray(Charsets.UTF_8)
        val c = try {
            open(method, path, bytes, 60_000)
        } catch (e: IOException) {
            throw unreachable(e)
        }
        try {
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val data = stream?.use { it.readBytes() } ?: ByteArray(0)
            if (status !in 200..299) throw NodeError.from(status, c.getHeaderField("content-type"), c.getHeaderField("date"), data)
            val json = if (data.isEmpty()) Json.Obj(emptyMap()) else try {
                Json.parse(String(data, Charsets.UTF_8))
            } catch (e: JsonError) {
                throw NodeError(200, "The node's answer wasn't what this app reads (${e.message}).")
            }
            if (method == "POST") NodeError.late(json)?.let { throw it }
            json
        } catch (e: IOException) {
            throw unreachable(e)
        } finally {
            c.disconnect()
        }
    }

    suspend fun get(path: String): Json = send("GET", path, null)

    suspend fun post(path: String, body: Json): Json = send("POST", path, body)

    /**
     * A POST answered with server-sent events (the primary's chat): each payload as it arrives. Ending the collection ends the
     * watching and nothing else: a turn the node owns runs on to its end, and can be attached to again.
     */
    fun events(path: String, body: Json): Flow<Json> = flow {
        val bytes = body.text().toByteArray(Charsets.UTF_8)
        val c = try {
            open("POST", path, bytes, 120_000)
        } catch (e: IOException) {
            throw unreachable(e)
        }
        // Closing the connection is how a blocked read ends when the collector goes.
        val watching = currentCoroutineContext()[Job]?.invokeOnCompletion { c.disconnect() }
        try {
            val status = c.responseCode
            if (status !in 200..299) {
                val said = c.errorStream?.use { it.readBytes() } ?: ByteArray(0)
                throw NodeError.from(status, c.getHeaderField("content-type"), c.getHeaderField("date"), said)
            }
            val reader = BufferedReader(InputStreamReader(c.inputStream, Charsets.UTF_8))
            val block = ArrayList<String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) {
                    for (payload in block) runCatching { Json.parse(payload) }.getOrNull()?.let { emit(it) }
                    block.clear()
                } else if (line.startsWith("data:")) {
                    block += line.substring(5).trimStart()
                }
            }
        } catch (e: IOException) {
            throw unreachable(e)
        } finally {
            watching?.dispose()
            c.disconnect()
        }
    }.flowOn(Dispatchers.IO)
}
