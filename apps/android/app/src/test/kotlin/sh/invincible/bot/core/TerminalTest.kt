package sh.invincible.bot.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

/** A terminal as the Apple app and the PWA hold one: its text, the addresses a sign-in prints, and what's typed, in order. */
class TerminalTest {
    @Test
    fun whatItShowsAsText() {
        assertEquals("hello", Terminals.plain("\u001b[1;32mhello\u001b[0m"))
        assertEquals("prompt$ ", Terminals.plain("\u001b]0;agent@vm: /work\u0007prompt$ "))
        assertEquals("ab", Terminals.plain("a\u001b[2K\u001b[1Gb"))
    }

    @Test
    fun theAddressesASignInPrints() {
        val shown = "Open this to sign in:\r\n\u001b[4mhttps://claude.ai/oauth/authorize?code=true&state=x1\u001b[0m.\r\n" +
            "or (http://localhost:3000) and ftp://elsewhere and https:// alone"
        assertEquals(listOf("https://claude.ai/oauth/authorize?code=true&state=x1", "http://localhost:3000"), Terminals.links(shown))
    }

    private class Sent(val data: String?, val cols: Int?, val rows: Int?)

    @Test
    fun whatIsTypedGoesInOrderTogetherWhileOneIsOnItsWay() = runBlocking<Unit> {
        val sent = mutableListOf<Sent>()
        val gates = ArrayDeque<CompletableDeferred<Unit>>()
        val queue = TerminalInputQueue(this, send = { data, cols, rows ->
            sent += Sent(data, cols, rows)
            CompletableDeferred<Unit>().also { gates.addLast(it) }.await()
        }, failed = { throw AssertionError("nothing failed") })
        queue.type("ls")
        yield()
        queue.type(" -la")
        queue.resize(80, 24)
        queue.type("\r")
        yield()
        assertEquals(listOf("ls"), sent.map { it.data })
        gates.removeFirst().complete(Unit)
        yield()
        yield()
        assertEquals(" -la\r", sent[1].data)
        assertEquals(80 to 24, sent[1].cols to sent[1].rows)
        gates.removeFirst().complete(Unit)
    }

    @Test
    fun aPasteGoesInPiecesNeverSplittingACharacter() = runBlocking<Unit> {
        val sent = mutableListOf<String?>()
        val queue = TerminalInputQueue(this, send = { data, _, _ -> sent += data }, failed = { throw AssertionError("nothing failed") })
        queue.type("x".repeat(TerminalInputQueue.MAX_DATA - 1) + "😀" + "y")
        repeat(4) { yield() }
        assertEquals(listOf(TerminalInputQueue.MAX_DATA - 1, 3), sent.map { it?.length })
        assertEquals("😀y", sent[1])
    }

    @Test
    fun afterARequestFailsNothingMoreIsSent() = runBlocking<Unit> {
        val sent = mutableListOf<String?>()
        val failures = mutableListOf<Exception>()
        val queue = TerminalInputQueue(this, send = { data, _, _ ->
            sent += data
            throw NodeError(404, "that terminal is gone")
        }, failed = { failures += it })
        queue.type("a")
        repeat(3) { yield() }
        queue.type("b")
        repeat(3) { yield() }
        assertEquals(listOf("a"), sent)
        assertEquals(1, failures.size)
    }
}
