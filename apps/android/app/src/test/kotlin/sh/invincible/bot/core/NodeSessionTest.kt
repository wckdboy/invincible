package sh.invincible.bot.core

import java.util.concurrent.Executors
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A session's proof of which node it speaks to, held to the rules the review of apps-name-node set (27 November 2026),
 * which core and the Apple app hold too: every new session proves first, and nothing but whoami is sent until its proof
 * holds; Try again keeps the refusal while it asks; once pinned, no proof is a failure; after the cutoff an unpinned
 * pairing proves first; a late proof never writes over a newer pairing; the proof is judged off the main thread, and
 * nothing is taken from the node before it holds. Its proofs here are stand-ins: a node's proof of a challenge is
 * "signed:<node>:<challenge>" (the strict rule itself is NodeProofTest's).
 */
class NodeSessionTest {
    private val a = "n_" + "A".repeat(43)
    private val b = "n_" + "B".repeat(43)
    private val check = NodeProof.Checker { node, challenge, proof -> proof == "signed:$node:$challenge" }

    /** What a node at the address answers whoami with: its id, a proof (or none), and its primary's name. */
    private fun answer(node: String, challenge: String, proof: Json? = Json.Str("signed:$node:$challenge"), name: String = "Keep"): Json =
        Json.Obj(linkedMapOf<String, Json>("node" to Json.Str(node), "primaryName" to Json.Str(name)).also { if (proof != null) it["proof"] = proof })

    private class Seen {
        var asked = 0
        val kept = mutableListOf<String>()
        val names = mutableListOf<String?>()
        val refusals = mutableListOf<NodeError>()
        var reopened = 0
    }

    private fun session(
        pin: NodePin,
        seen: Seen,
        now: () -> Long = { NodeProof.NAMED_FROM - 86_400_000L },
        current: () -> Boolean = { true },
        judging: kotlin.coroutines.CoroutineContext = kotlinx.coroutines.Dispatchers.Default,
        ask: suspend (String) -> Json,
    ) = NodeSession(
        pin,
        ask = { challenge -> seen.asked++; ask(challenge) },
        keep = { seen.kept += it },
        named = { seen.names += it },
        refused = { seen.refusals += it },
        now = now,
        judging = judging,
        reopen = { seen.reopened++ },
        isCurrent = current,
        check = check,
    )

    private val unreachable get() = NodeError(0, "Nothing answers at the node.", unreachable = true)

    // ---- L2, rule 1: a failed whoami is no gate; a session proves when it begins ----

    @Test fun aWhoamiThatFailsOpensNothingAndIsAskedAgainOnlyAfterAPause() = runBlocking {
        var clock = NodeProof.NAMED_FROM - 86_400_000L
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        var reachable = false
        val s = session(pin, seen, now = { clock }) { challenge -> if (reachable) answer(a, challenge) else throw unreachable }
        assertFalse("a whoami that failed proves nothing", s.prove())
        assertFalse("nothing but whoami may be sent", pin.isOpen)
        // (Asked again at once, it isn't: the next whoami waits a while.)
        assertFalse(s.prove())
        assertEquals(1, seen.asked)
        reachable = true
        clock += 60_000
        assertTrue(s.prove())
        assertTrue(pin.isOpen)
        assertEquals(2, seen.asked)
    }

    @Test fun aSessionProvesItselfAgainWhenItsStreamOpensAgain() = runBlocking {
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        var at = a
        val s = session(pin, seen) { challenge -> answer(at, challenge) }
        assertTrue(s.prove())
        assertTrue(s.prove())
        assertEquals("proven once, a session's reads ask nothing more", 1, seen.asked)
        // Another node at the address since: the stream's opening proves again, and finds it.
        at = b
        assertFalse(s.prove(fresh = true))
        assertEquals(2, seen.asked)
        assertNotNull(pin.refused)
    }

    @Test fun aRefusedSessionSendsNothingMoreNotEvenWhoami() = runBlocking {
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        val s = session(pin, seen) { challenge -> answer(b, challenge) }
        assertFalse(s.prove())
        assertFalse(s.prove())
        assertFalse(s.prove(fresh = true))
        assertEquals(1, seen.asked)
        assertFalse(pin.isOpen)
    }

    // ---- L4, rule 5: a late first proof never writes over a newer pairing ----

    @Test fun aLateFirstProofNeverWritesOverANewerPairing() = runBlocking {
        val pin = NodePin(null, proofFirst = true)
        val seen = Seen()
        var current = true
        val answered = CompletableDeferred<Unit>()
        val s = session(pin, seen, current = { current }) { challenge -> answered.await(); answer(a, challenge) }
        val proving = async { s.prove() }
        yield()
        // Forgotten and paired again while its whoami is on its way.
        current = false
        answered.complete(Unit)
        proving.await()
        assertEquals("the old pairing's proof isn't kept with the new one", emptyList<String>(), seen.kept)
    }

    // ---- L5, rule 6: judged off the main thread; nothing taken before the proof holds ----

    @Test fun theProofIsJudgedWhereTheSessionSaysNotWhereItWasAsked() = runBlocking {
        val judging = Executors.newSingleThreadExecutor { Thread(it, "judging") }.asCoroutineDispatcher()
        var judgedOn: String? = null
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        val s = NodeSession(
            pin,
            ask = { challenge -> answer(a, challenge) },
            keep = { seen.kept += it },
            named = { seen.names += it },
            refused = { seen.refusals += it },
            now = { NodeProof.NAMED_FROM - 86_400_000L },
            judging = judging,
            check = NodeProof.Checker { node, challenge, proof -> judgedOn = Thread.currentThread().name; proof == "signed:$node:$challenge" },
        )
        assertTrue(s.prove())
        judging.close()
        // (kotlinx's debug mode, on in tests, names the coroutine after the thread's own name: "judging @coroutine#n".)
        assertEquals("judging", judgedOn?.substringBefore(" @"))
    }

    @Test fun nothingIsTakenFromANodeBeforeItsProofHolds() = runBlocking {
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        val s = session(pin, seen) { challenge -> answer(b, challenge, name = "Another") }
        assertFalse(s.prove())
        assertEquals("a refused node names nothing here", emptyList<String?>(), seen.names)
        val pin2 = NodePin(a, proofFirst = true)
        val seen2 = Seen()
        assertTrue(session(pin2, seen2) { challenge -> answer(a, challenge, name = "Keep") }.prove())
        assertEquals(listOf<String?>("Keep"), seen2.names)
    }

    // ---- L6, rule 4: after the cutoff an unpinned pairing proves first; before it, as today ----

    @Test fun afterTheCutoffAnUnpinnedPairingProvesFirstThenPins() = runBlocking {
        val after = { NodeProof.NAMED_FROM + 60_000L }
        val pin = NodePin(null, proofFirst = true)
        val seen = Seen()
        var reachable = false
        var clock = after()
        val s = session(pin, seen, now = { clock }) { challenge -> if (reachable) answer(a, challenge) else throw unreachable }
        assertFalse("after the cutoff, nothing goes before a proof", s.prove())
        assertFalse(pin.isOpen)
        reachable = true
        clock += 60_000
        assertTrue(s.prove())
        assertTrue(pin.isOpen)
        assertEquals(a, pin.node)
        assertEquals(listOf(a), seen.kept)
    }

    @Test fun afterTheCutoffAnUnpinnedPairingAtANodeThatGivesNoProofIsRefused() = runBlocking {
        // (The lead's word of 27 November 2026: after the cutoff no proof is a failed one, pinned or not; every node of
        // ours proves by then. Before it, a node from before, as today: beforeTheCutoffAnUnpinnedPairingIsAsToday.)
        val pin = NodePin(null, proofFirst = true)
        val seen = Seen()
        val s = session(pin, seen, now = { NodeProof.NAMED_FROM + 60_000L }) { challenge -> answer(a, challenge, proof = null) }
        assertFalse(s.prove())
        assertNotNull(pin.refused)
        assertFalse(pin.isOpen)
        assertNull(pin.node)
        assertEquals(emptyList<String?>(), seen.names)
    }

    @Test fun beforeTheCutoffAnUnpinnedPairingAtANodeThatGivesNoProofIsAsToday() = runBlocking {
        val pin = NodePin(null, proofFirst = true)
        val seen = Seen()
        assertTrue(session(pin, seen) { challenge -> answer(a, challenge, proof = null) }.prove())
        assertTrue(pin.isOpen)
        assertNull(pin.refused)
    }

    // (K1, the re-check of 27 November 2026: this test said an unanswered whoami opened the gate of a pairing with no pin
    // before the cutoff. No answer proves nothing, pinned or not, as on the iPhone: what holds before the cutoff, with no
    // pin, is a node from before, one that answers without a proof: beforeTheCutoffAnUnpinnedPairingAtANodeThatGives….)
    @Test fun aWhoamiThatGetsNoAnswerHoldsEverythingPinnedOrNotBeforeTheCutoffAndPastIt() = runBlocking {
        val signer = object : Signer {
            override val device = "c_" + "D".repeat(43)
            override fun sign(message: ByteArray) = ByteArray(64)
        }
        for (pinned in listOf(null, a)) {
            var clock = NodeProof.NAMED_FROM - 60_000L
            val pin = NodePin(pinned, proofFirst = true)
            val s = session(pin, Seen(), now = { clock }) { throw NodeError(500, "Whatever answers there.") }
            assertFalse("$pinned: no answer proves nothing", s.prove())
            assertFalse("$pinned: nothing but whoami may be sent", pin.isOpen)
            val read = runCatching { NodeClient("https://node.example.test", signer, pin).headers("GET", "/api/team", ByteArray(0)) }.exceptionOrNull()
            assertTrue("$pinned: a read isn't signed", (read as? NodeError)?.unproven == true)
            // Past the cutoff and every pause, whoami still unanswered: still held, and nothing refused (no answer isn't another node's).
            clock = NodeProof.NAMED_FROM + 10 * 60_000L
            assertFalse("$pinned: past the cutoff, still held", s.prove())
            assertFalse("$pinned", pin.isOpen)
            assertNull("$pinned", pin.refused)
        }
    }

    // ---- K3 (the re-check): what the app asks as it comes to the front waits for the first proof, then goes ----

    @Test fun whatTheAppAsksAsItComesToTheFrontWaitsForTheFirstProofThenGoes() = runBlocking {
        val signer = object : Signer {
            override val device = "c_" + "D".repeat(43)
            override fun sign(message: ByteArray) = ByteArray(64)
        }
        java.net.ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress()).use { server ->
            // A node at the address: what it was asked, in order; its whoami answered only when the test says.
            val asked = java.util.Collections.synchronizedList(mutableListOf<String>())
            val whoamiOut = java.util.concurrent.CountDownLatch(1)
            val answerIt = java.util.concurrent.CountDownLatch(1)
            kotlin.concurrent.thread(isDaemon = true) {
                while (true) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    socket.use { s ->
                        val reader = s.getInputStream().bufferedReader()
                        val target = reader.readLine()?.split(" ")?.getOrNull(1) ?: return@use
                        while (!reader.readLine().isNullOrEmpty()) Unit
                        val path = target.substringBefore("?")
                        asked += path
                        val body = if (path == "/api/whoami") {
                            whoamiOut.countDown()
                            answerIt.await(5, java.util.concurrent.TimeUnit.SECONDS)
                            answer(a, target.substringAfter("challenge=")).text()
                        } else "{}"
                        val bytes = body.toByteArray()
                        s.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n".toByteArray())
                            write(bytes)
                            flush()
                        }
                    }
                }
            }
            val pin = NodePin(a, proofFirst = true)
            val c = NodeClient("http://127.0.0.1:${server.localPort}", signer, pin)
            val s = NodeSession(pin, ask = { c.provenWhoami(it) }, keep = {}, named = {}, refused = {}, check = check)
            // A cold start: the stream's first whoami out (live()) as the app comes to the front (inFront()).
            val first = async(kotlinx.coroutines.Dispatchers.IO) { s.prove() }
            assertTrue(whoamiOut.await(5, java.util.concurrent.TimeUnit.SECONDS))
            val front = async(kotlinx.coroutines.Dispatchers.IO) { s.read(c, "/api/notify") }
            kotlinx.coroutines.delay(200)
            answerIt.countDown()
            assertTrue(first.await())
            assertNotNull("asked once the proof held, not dropped", front.await())
            assertEquals(listOf("/api/whoami", "/api/notify"), asked.toList())
        }
    }

    // ---- L7, I1, rule 3: once pinned, no proof is a failure ----

    @Test fun oncePinnedANodeThatGivesNoProofIsRefused() = runBlocking {
        for (proof in listOf<Json?>(null, Json.Null, Json.Num(5.0))) {
            val pin = NodePin(a, proofFirst = true)
            val seen = Seen()
            val s = session(pin, seen) { challenge -> answer(b, challenge, proof = proof) }
            assertFalse("$proof", s.prove())
            assertNotNull("$proof", pin.refused)
            assertFalse("$proof", pin.isOpen)
        }
    }

    // ---- L3, I3, rule 2: Try again keeps the refusal while it asks; the stream opens again on a proof that holds ----

    @Test fun tryAgainKeepsTheRefusalWhileItAsksAndClearsItOnlyOnAProofThatHolds() = runBlocking {
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        var reply: suspend (String) -> Json = { challenge -> answer(b, challenge) }
        val s = session(pin, seen) { challenge -> reply(challenge) }
        assertFalse(s.prove())
        assertNotNull(pin.refused)
        // While Try again's whoami is on its way, the refusal stands: nothing else may go.
        val answered = CompletableDeferred<Unit>()
        reply = { challenge -> answered.await(); answer(a, challenge) }
        val trying = async { s.tryAgain() }
        yield()
        assertNotNull("refused while it asks", pin.refused)
        assertFalse(pin.isOpen)
        answered.complete(Unit)
        assertTrue(trying.await())
        assertNull(pin.refused)
        assertTrue(pin.isOpen)
        assertEquals("its stream is opened again", 1, seen.reopened)
    }

    @Test fun tryAgainAnsweredWithoutAProofKeepsTheRefusal() = runBlocking {
        val pin = NodePin(a, proofFirst = true)
        val seen = Seen()
        var reply: suspend (String) -> Json = { challenge -> answer(b, challenge) }
        val s = session(pin, seen) { challenge -> reply(challenge) }
        assertFalse(s.prove())
        for (next in listOf<suspend (String) -> Json>({ throw NodeError(401, "unknown device") }, { challenge -> answer(a, challenge, proof = null) }, { challenge -> answer(b, challenge) })) {
            reply = next
            assertFalse(s.tryAgain())
            assertNotNull(pin.refused)
            assertFalse(pin.isOpen)
        }
        assertEquals(0, seen.reopened)
    }

    // ---- the lead's word of 27 November 2026: while refused, the reach banner says nothing ----

    @Test fun theReachBannerSaysNothingWhileTheNodeIsRefused() {
        // ("Can't reach Invincible right now" contradicted the refusal, which says what's wrong.)
        assertNull(reachShown(online = false, refused = true))
        assertNull(reachShown(online = true, refused = true))
        assertEquals(false, reachShown(online = false, refused = false))
        assertEquals(true, reachShown(online = true, refused = false))
        assertNull(reachShown(online = null, refused = false))
    }

    // ---- the lead's word of 27 November 2026: while refused, the line over what was kept doesn't say it's asking ----

    @Test fun theLineOverWhatWasKeptSaysNothingOfAskingWhileTheNodeIsRefused() {
        // (Nothing is asked of a refused node, not even whoami, until Try again: "Asking it again" said otherwise.)
        assertEquals("As your node last said it, 28 minutes ago.", keptLine("28 minutes ago", refused = true))
        assertEquals("As your node last said it, just now. Asking it again.", keptLine("just now", refused = false))
    }
}
