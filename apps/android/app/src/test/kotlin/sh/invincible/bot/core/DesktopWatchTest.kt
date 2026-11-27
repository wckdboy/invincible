package sh.invincible.bot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The way back to the picture (DesktopWatch), on stand-in streams, as the Apple app's DesktopWatchTests hold it: after four
 * ends in a row, said; at once on the node's refusal, saying nothing; never on a node that didn't answer; the last frame
 * kept on screen between tries, and a frame drawn starting the count again.
 */
class DesktopWatchTest {
    /** A stream that gives so many frames (a keyframe first), then ends: as streams end, or with an error. */
    private fun stream(frames: Int, then: Throwable? = null): Flow<DesktopFrame> = flow {
        for (i in 0 until frames) emit(DesktopFrame(if (i == 0) DesktopFrame.KEY else DesktopFrame.DELTA, i.toLong(), byteArrayOf(0, 0, 1, 0x65)))
        if (then != null) throw then
    }

    /** What the watch did, as its stand-ins saw it; and how it stood at each wait (drawing, and its last frame kept). */
    private class Seen {
        var opened = 0
        var ended = 0
        val waits = ArrayList<Long>()
        val during = ArrayList<Pair<Boolean, Boolean>>()
        val said = ArrayList<String>()
    }

    /** The watch run on a script of streams, one for each time it opens one (a stream that ends at once after them). */
    private fun run(vararg script: Flow<DesktopFrame>): Pair<DesktopWatch, Seen> = runBlocking {
        val watch = DesktopWatch()
        val seen = Seen()
        val left = ArrayDeque(script.toList())
        watch.run(
            open = {
                seen.opened += 1
                left.removeFirstOrNull() ?: stream(0)
            },
            show = { true },
            ended = { seen.ended += 1 },
            wait = { ms ->
                seen.waits += ms
                seen.during += watch.state.value.watching to watch.state.value.drawn
            },
            began = { seen.said += "began" },
            stopped = { seen.said += "stopped" },
        )
        watch to seen
    }

    @Test
    fun fourEndsInARowGiveWayToThePictureAndSaySo() {
        val (watch, seen) = run(stream(0), stream(0), stream(0), stream(0))
        assertEquals(DesktopWatch.GivenUp.TRIED, watch.state.value.givenUp)
        assertEquals(listOf(500L, 1000L, 2000L), seen.waits)
        assertEquals(4, seen.opened)
        assertEquals(4, seen.ended)
        assertFalse(watch.state.value.watching || watch.state.value.drawn)
        assertTrue(seen.said.isEmpty())
    }

    @Test
    fun theNodesRefusalGivesWayAtOnceSayingNothing() {
        for (status in listOf(400, 403, 404, 424, 501)) {
            val (watch, seen) = run(stream(0, NodeError(status, "no")))
            assertEquals("$status", DesktopWatch.GivenUp.REFUSED, watch.state.value.givenUp)
            assertTrue("$status", seen.waits.isEmpty() && seen.opened == 1 && seen.ended == 1)
        }
        // Refused after it was drawing: the picture at once, the last frame let go.
        val (watch, seen) = run(stream(2), stream(0, NodeError(404, "gone")))
        assertEquals(DesktopWatch.GivenUp.REFUSED, watch.state.value.givenUp)
        assertFalse(watch.state.value.drawn)
        assertEquals(listOf(500L), seen.waits)
        assertEquals(listOf("began", "stopped"), seen.said)
    }

    @Test
    fun aNodeThatDidntAnswerIsAskedAgainNotRefused() {
        val away = listOf(
            NodeError(0, "nothing answered", unreachable = true),
            NodeError(503, "a proxy for a node that's away", unreachable = true),
            NodeError(500, "it broke"),
            NodeError(504, "a proxy for a node that's away", unreachable = true),
        )
        for (error in away) assertFalse("${error.status}", DesktopWatch.refuses(error))
        // Not answered is never a refusal, whatever status came back in its place.
        assertFalse(DesktopWatch.refuses(NodeError(404, "a proxy's own page", unreachable = true)))
        assertFalse(DesktopWatch.refuses(IllegalStateException("the codec can't go on")))
        // Asked again each time, and given up only after the fourth end in a row, saying so.
        val (watch, seen) = run(*away.map { stream(0, it) }.toTypedArray())
        assertEquals(listOf(500L, 1000L, 2000L), seen.waits)
        assertEquals(4, seen.opened)
        assertEquals(DesktopWatch.GivenUp.TRIED, watch.state.value.givenUp)
    }

    @Test
    fun theLastFrameStaysBetweenTriesAndADrawnFrameStartsTheCountAgain() {
        val (watch, seen) = run(
            stream(3), stream(0), stream(0, NodeError(0, "", unreachable = true)),
            stream(2), stream(0), stream(0), stream(0),
        )
        // Three ends, then frames drawn again: the count starts over, so it takes four more ends to give up.
        assertEquals(listOf(500L, 1000L, 2000L, 500L, 1000L, 2000L), seen.waits)
        // At every wait it isn't drawing, and the last frame is still what the box shows.
        assertEquals(6, seen.during.size)
        assertTrue(seen.during.all { (watching, drawn) -> !watching && drawn })
        assertEquals(listOf("began", "stopped", "began", "stopped"), seen.said)
        // Given up: the picture, not the last frame.
        assertEquals(DesktopWatch.GivenUp.TRIED, watch.state.value.givenUp)
        assertFalse(watch.state.value.drawn)
    }

    @Test
    fun leftItStopsWithNothingCountedOrGivenUp() {
        runBlocking {
            val watch = DesktopWatch()
            val job = launch { watch.run(open = { stream(0) }, show = { true }, ended = {}, wait = { delay(60_000) }) }
            // (Wherever the cancel finds it, before its first stream or in its first wait, it stops there.)
            delay(50)
            job.cancel()
            job.join()
            assertNull(watch.state.value.givenUp)
            assertFalse(watch.state.value.watching)
        }
    }

    @Test
    fun aSurfaceMadeAgainForgetsTheLastFrame() {
        runBlocking {
            val watch = DesktopWatch()
            val job = launch { watch.run(open = { stream(1) }, show = { true }, ended = {}, wait = { delay(60_000) }) }
            delay(50)
            assertTrue(watch.state.value.drawn)
            watch.forget()
            assertFalse(watch.state.value.drawn)
            job.cancel()
            job.join()
        }
    }
}
