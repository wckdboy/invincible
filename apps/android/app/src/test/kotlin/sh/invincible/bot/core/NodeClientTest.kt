package sh.invincible.bot.core

import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A node that can't be reached is said so in words: never the network library's own text, which names its classes and
 * objects ("unexpected end of stream on com.android.okhttp.Address@fd1bb28f" reached the screen once).
 */
class NodeClientTest {
    private val signer = object : Signer {
        override val device = "c_" + "A".repeat(87)
        override fun sign(message: ByteArray) = ByteArray(64)
    }

    @Test
    fun aConnectionDroppedBeforeAnAnswerIsSaidInWords() = runBlocking<Unit> {
        ServerSocket(0).use { server ->
            // Takes each request, then hangs up without a word (Java's own client asks a second time).
            thread { runCatching { while (true) server.accept().use { it.getInputStream().read(ByteArray(1024)) } } }
            val e = runCatching { NodeClient("http://127.0.0.1:${server.localPort}", signer).get("/api/team") }.exceptionOrNull() as NodeError
            assertEquals("Lost the connection to 127.0.0.1.", e.message)
            assertTrue(e.unreachable)
        }
    }

    @Test
    fun eachRequestSaysThisDevicesTimeZoneBesideItsSignature() = runBlocking<Unit> {
        ServerSocket(0).use { server ->
            var head = ""
            thread {
                runCatching {
                    server.accept().use { socket ->
                        val bytes = ByteArray(8192)
                        head = String(bytes, 0, socket.getInputStream().read(bytes))
                        socket.getOutputStream().write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".toByteArray())
                    }
                }
            }
            NodeClient("http://127.0.0.1:${server.localPort}", signer).get("/api/team")
            val zone = head.lines().firstOrNull { it.startsWith("x-invincible-tz:", ignoreCase = true) }?.substringAfter(":")?.trim()
            assertEquals(java.util.TimeZone.getDefault().id, zone)
        }
    }

    /** A node that says one event, then nothing: a half-open link, as a dead network leaves one. */
    private fun silentAfterOne(server: ServerSocket) = thread(isDaemon = true) {
        runCatching {
            server.accept().use { socket ->
                socket.getInputStream().read(ByteArray(8192))
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: {\"type\":\"hello\",\"topics\":[]}\r\n\r\n".toByteArray())
                    flush()
                }
                Thread.sleep(60_000)
            }
        }
    }

    /**
     * The silent node's one event, waited for as long as a stream waits for anything (its read timeout, a minute): it comes
     * in a millisecond or two, so this holds the test to nothing but its stream opening. What these tests hold to time is
     * the close after it. A 5 s wait here failed once (27 November 2026) on a Mac deep in swap, as a stop of the test's own
     * process for 6 s between the stream opening and its event fails it every time.
     */
    private fun opened(got: CountDownLatch) = assertTrue("the stream opened: its first event came", got.await(60, TimeUnit.SECONDS))

    // Seen on the emulator (26 November 2026): with the link dead, the stream taken for dead was cancelled but its read
    // went on blocking, and the app never said it couldn't reach its node. A cancelled read must end at once.
    @Test
    fun aSilentAnswerStreamIsClosedAtOnceWhenItsReaderGoes() {
        ServerSocket(0).use { server ->
            silentAfterOne(server)
            val got = CountDownLatch(1)
            val done = CountDownLatch(1)
            val job = CoroutineScope(Dispatchers.IO).launch {
                try {
                    NodeClient("http://127.0.0.1:${server.localPort}", signer).events("/api/chat", Json.obj()).collect { got.countDown() }
                } finally {
                    done.countDown()
                }
            }
            opened(got)
            job.cancel()
            assertTrue("closed within two seconds of its reader going", done.await(2, TimeUnit.SECONDS))
        }
    }

    // Seen on the mini under load (26 November 2026): the answer stream's reader went, and its read went on blocking. The
    // watch that closes its connection is a coroutine of its own, and one cancelled before it ever ran never runs its
    // `finally`: nothing closed the connection.
    @Test
    fun aWatchCancelledBeforeItRanStillClosesItsConnection() {
        val closed = CountDownLatch(1)
        runBlocking {
            launch(Dispatchers.IO) {
                // (Its reader gone before the watch could begin.)
                kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]!!.cancel()
                closeOnCancel { closed.countDown() }
            }.join()
        }
        assertTrue("closed though cancelled before it began", closed.await(2, TimeUnit.SECONDS))
    }

    @Test
    fun aSilentLiveStreamIsClosedAtOnceByWhoOpenedIt() {
        ServerSocket(0).use { server ->
            silentAfterOne(server)
            val got = CountDownLatch(1)
            val done = CountDownLatch(1)
            var close: () -> Unit = {}
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    NodeClient("http://127.0.0.1:${server.localPort}", signer).stream("/api/live", opened = { close = it }, alive = {}) { got.countDown() }
                } catch (_: NodeError) {
                } finally {
                    done.countDown()
                }
            }
            opened(got)
            // As LiveLink does when it hears nothing for three beats: from its own thread, not the reader's.
            close()
            assertTrue("closed within two seconds", done.await(2, TimeUnit.SECONDS))
        }
    }

    /** A node that beats on its stream as one of today does (every 100 ms here), for as long as it is read. */
    private fun beating(server: ServerSocket) = thread(isDaemon = true) {
        runCatching {
            server.accept().use { socket ->
                socket.getInputStream().read(ByteArray(8192))
                val out = socket.getOutputStream()
                out.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: {\"type\":\"hello\",\"topics\":[]}\r\n\r\n".toByteArray())
                out.flush()
                while (true) {
                    Thread.sleep(100)
                    out.write(": beat\r\n\r\n".toByteArray())
                    out.flush()
                }
            }
        }
    }

    // A close asked before there is a connection to close (the network changed, or the app went off screen, just as a
    // stream was being opened) must hold. A connection's own close does nothing before it connects, and the stream was
    // read on, unseen, for as long as its node beat.
    @Test
    fun aLiveStreamClosedBeforeItsConnectionIsMadeIsNeverRead() {
        ServerSocket(0).use { server ->
            beating(server)
            val heard = java.util.concurrent.atomic.AtomicInteger(0)
            val done = CountDownLatch(1)
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    NodeClient("http://127.0.0.1:${server.localPort}", signer).stream("/api/live", opened = { close -> close() }, alive = { heard.incrementAndGet() }) {}
                } catch (_: NodeError) {
                } finally {
                    done.countDown()
                }
            }
            assertTrue("ended within two seconds", done.await(2, TimeUnit.SECONDS))
            assertEquals(0, heard.get())
        }
    }

    @Test
    fun nothingListeningIsSaidInWords() = runBlocking<Unit> {
        val port = ServerSocket(0).use { it.localPort }
        val e = runCatching { NodeClient("http://127.0.0.1:$port", signer).get("/api/team") }.exceptionOrNull() as NodeError
        assertEquals("Nothing answers at 127.0.0.1. Is the node running?", e.message)
        assertTrue(e.unreachable)
    }

    // The slice 8 note's item 11: what this phone signs names the node it proved to be, and never whoami's proof.
    @Test
    fun aPinnedClientSignsForItsNodeWhoamisProofForNoneAndNothingOnceItProvedToBeAnother() {
        val inputs = mutableListOf<String>()
        val recording = object : Signer {
            override val device = "c_" + "A".repeat(87)
            override fun sign(message: ByteArray): ByteArray = ByteArray(64).also { inputs += String(message, Charsets.UTF_8) }
        }
        val node = Fixture.vectors["nodeProofs"].list.first()["node"].string!!
        val pin = NodePin()
        val client = NodeClient("http://127.0.0.1:7778", recording, pin)
        client.headers("GET", "/api/team", ByteArray(0))
        assertTrue(inputs.last().startsWith("${RequestAuth.DOMAIN}\n"))
        pin.pin(node)
        client.headers("GET", "/api/team", ByteArray(0))
        assertTrue(inputs.last().startsWith("${RequestAuth.DOMAIN_NAMED}\n") && inputs.last().endsWith("\n$node"))
        client.headers("GET", "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", ByteArray(0), named = false)
        assertTrue(inputs.last().startsWith("${RequestAuth.DOMAIN}\n"))
        // Proved to be another: nothing is made but whoami's own ask (Try again's, whoami = true, past the refusal:
        // refusedWhoamiIsStillAskedAndNothingElseIs), not even a whoami made as any other request is.
        val other = Fixture.vectors["nodeProofs"].list.first()["anotherNode"].string!!
        pin.refuse(NodeError.notYours(other))
        val refused = runCatching { client.headers("POST", "/api/chat", "{}".toByteArray()) }.exceptionOrNull() as NodeError
        assertEquals(other, refused.notYourNode)
        assertEquals("It proved to be another node (${other.drop(2).take(8)}), not the one this phone paired with.", refused.message)
        assertTrue(runCatching { client.headers("GET", "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", ByteArray(0), named = false) }.isFailure)
        assertEquals("", NodeError.notYours(null).notYourNode)
        pin.clear()
        client.headers("GET", "/api/team", ByteArray(0))
        assertTrue(inputs.last().endsWith("\n$node"))
    }

    /** The shared rule 1 (27 November 2026): until the session's proof holds, nothing but whoami is signed at all. */
    @Test
    fun nothingButWhoamiIsSignedUntilTheSessionsProofHolds() {
        val pin = NodePin("n_" + "A".repeat(43), proofFirst = true)
        val client = NodeClient("http://127.0.0.1:9", signer, pin)
        val before = runCatching { client.headers("GET", "/api/team", ByteArray(0)) }.exceptionOrNull() as? NodeError
        assertTrue("a read before the proof isn't signed", before?.unproven == true)
        assertTrue(runCatching { client.headers("POST", "/api/actions/decide", ByteArray(0)) }.isFailure)
        assertTrue(runCatching { client.headers("GET", "/api/whoami?challenge=x", ByteArray(0), named = false, whoami = true) }.isSuccess)
        pin.open()
        assertTrue(runCatching { client.headers("GET", "/api/team", ByteArray(0)) }.isSuccess)
    }

    /** The shared rule 2: refused, whoami is still asked (Try again's), and nothing else. */
    @Test
    fun refusedWhoamiIsStillAskedAndNothingElseIs() {
        val pin = NodePin("n_" + "A".repeat(43), proofFirst = true).also { it.open() }
        val client = NodeClient("http://127.0.0.1:9", signer, pin)
        pin.refuse(NodeError.notYours("n_" + "B".repeat(43)))
        assertTrue(runCatching { client.headers("GET", "/api/whoami?challenge=x", ByteArray(0), named = false, whoami = true) }.isSuccess)
        assertTrue(runCatching { client.headers("GET", "/api/team", ByteArray(0)) }.isFailure)
    }
}
