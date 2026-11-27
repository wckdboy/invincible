package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The node's live stream as the app keeps it (LiveLink.kt), held to the web's lib/live-link.test.ts case for case: open
 * while the app is on screen, opened again when it ends (at once after a long one, backing off after failures, never on a
 * timer once the node refused it), taken for dead when it says nothing; and what the app reads, run once when it comes
 * up, then only for what changed, polled only while it is down.
 */
class LiveLinkTest {
    /** A clock in hand: `advance` runs what comes due, in order. */
    private class Clock {
        var now = 0L
        private class Timer(val at: Long, val run: () -> Unit) { var off = false }
        private val timers = ArrayList<Timer>()
        val after: After = { ms, run ->
            val timer = Timer(now + ms, run)
            timers += timer
            { timer.off = true }
        }
        fun advance(ms: Long) {
            val end = now + ms
            while (true) {
                val due = timers.filter { !it.off && it.at <= end }.minByOrNull { it.at } ?: break
                due.off = true
                now = due.at
                due.run()
            }
            now = end
        }
        fun pending(): List<Long> = timers.filter { !it.off }.map { it.at - now }
    }

    /** Streams the test opens and feeds: each `open` is one, with its events pushed and its end or failure said. */
    private class Stream(val since: String?, val alive: () -> Unit, val event: (LiveEvent) -> Unit, val ended: (Throwable?) -> Unit) {
        var closed = false
        private var over = false
        fun push(e: LiveEvent) { alive(); event(e) }
        fun beat() = alive()
        fun end() { if (!over) { over = true; ended(null) } }
        fun fail(error: Throwable) { if (!over) { over = true; ended(error) } }
        fun close() { closed = true; fail(Exception("closed")) }
    }

    private class Refused : Exception("refused")

    private class Setup {
        val clock = Clock()
        val opened = ArrayList<Stream>()
        var refuseWith: Throwable? = null
        val told = ArrayList<String>()
        val link = LiveLink(
            open = { since, alive, event, ended ->
                val stream = Stream(since, alive, event, ended)
                opened += stream
                refuseWith?.let { stream.fail(it) }
                ({ stream.close() })
            },
            refused = { it is Refused },
            after = clock.after,
            now = { clock.now },
        )
        init {
            link.attach(object : LinkHandlers {
                override fun up(topics: List<String>, at: Long, changed: List<String>?) { told += "up ${topics.joinToString(",")}" + (changed?.let { " changed:${it.joinToString(",")}" } ?: "") }
                override fun changed(topics: List<String>) { told += "changed ${topics.joinToString(",")}" }
                override fun down() { told += "down" }
                override fun lost() { told += "lost" }
            })
        }
        fun last() = opened.last()
    }

    private fun hello(vararg topics: String) = LiveEvent.Hello(topics.toList(), 1_500)
    private fun changed(vararg topics: String) = LiveEvent.Changed(topics.toList())

    @Test fun itsHelloSaysWhatItTellsOfAndEachChangeAfterIsPassedOn() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("actions", "team"))
        s.last().push(changed("actions"))
        assertEquals(listOf("up actions,team", "changed actions"), s.told)
        assertTrue(s.link.up)
    }

    @Test fun oneThatCantBeOpenedIsDownAtOnceAndTriedAgainBackingOffToHalfAMinute() {
        val s = Setup()
        s.link.start()
        s.last().fail(java.io.IOException("no route"))
        assertEquals(listOf("down"), s.told)
        val gaps = ArrayList<Long>()
        repeat(7) {
            gaps += s.clock.pending().min()
            val before = s.opened.size
            s.clock.advance(gaps.last())
            assertEquals(before + 1, s.opened.size)
            s.last().fail(java.io.IOException("no route"))
        }
        assertEquals(listOf(Live.RETRY_FIRST_MS, 2_000L, 4_000L, 8_000L, 16_000L, Live.RETRY_MAX_MS, Live.RETRY_MAX_MS), gaps)
        // Down was said once, not at every failure.
        assertEquals(listOf("down"), s.told)
    }

    @Test fun oneOpenAWhileIsOpenedAgainAtOnceWhenItEndsAndIsntDownIfBackSoon() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        var at = 0L
        while (at < Live.STEADY_MS) {
            s.clock.advance(Live.BEAT_MS)
            s.last().beat()
            at += Live.BEAT_MS
        }
        s.last().push(LiveEvent.Bye("stopping"))
        s.clock.advance(0)
        assertEquals(2, s.opened.size)
        s.clock.advance(Live.HELLO_WAIT_MS - 1)
        s.last().push(hello("fleet"))
        assertEquals(listOf("up fleet", "up fleet"), s.told)
    }

    @Test fun oneThatEndsSoonAfterOpeningWaitsASecondAndIsDownIfNotBackInTime() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.last().end()
        assertEquals(1, s.opened.size)
        s.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals(2, s.opened.size)
        s.clock.advance(Live.HELLO_WAIT_MS)
        assertEquals(listOf("up fleet", "down"), s.told)
    }

    @Test fun oneTheNodeRefusesIsDownAndNotTriedAgainOnATimer() {
        val s = Setup()
        s.refuseWith = Refused()
        s.link.start()
        assertEquals(listOf("down"), s.told)
        assertEquals(emptyList<Long>(), s.clock.pending())
        s.clock.advance(10 * 60_000L)
        assertEquals(1, s.opened.size)
        // The network back, or the app shown again: tried again then.
        s.refuseWith = null
        s.link.retry()
        s.last().push(hello("notices"))
        assertEquals(listOf("down", "up notices"), s.told)
    }

    @Test fun oneSilentForThreeOfItsNodesBeatsIsTakenForDeadAndOpenedAgainItsBeatsKeepItAlive() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        assertEquals(4_500L, s.link.silent)
        repeat(5) {
            s.clock.advance(s.link.silent - 1)
            s.last().beat()
        }
        assertEquals(1, s.opened.size)
        s.clock.advance(s.link.silent)
        assertTrue(s.opened[0].closed)
        s.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals(2, s.opened.size)
    }

    @Test fun anOlderNodesStreamWhoseHelloSaysNoBeatIsGivenItsOld15sBeat() {
        val s = Setup()
        s.link.start()
        s.last().push(LiveEvent.Hello(listOf("fleet"), null))
        assertEquals(45_000L, s.link.silent)
        s.clock.advance(44_999)
        assertFalse(s.opened[0].closed)
        s.clock.advance(1)
        assertTrue(s.opened[0].closed)
    }

    @Test fun aDeadLinkIsSaidLostAtOnceNotAfterWaitingForAnotherHello() {
        // Up, then silent for three beats: dead, whatever comes next. Said then, within 5 s of the link going (its last
        // beat came at most a beat before), not after the fresh stream's HELLO_WAIT on top.
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.clock.advance(s.link.silent - 1)
        assertEquals(listOf("up fleet"), s.told)
        s.clock.advance(1)
        assertEquals(listOf("up fleet", "lost"), s.told)
        assertFalse(s.link.up)
        // And the fresh one, if it says no hello in time, is down as any is.
        s.clock.advance(Live.RETRY_FIRST_MS + Live.HELLO_WAIT_MS)
        assertEquals(listOf("up fleet", "lost", "down"), s.told)
    }

    @Test fun oneThatEndsIsNeverSaidLostOnlyOneThatWentSilent() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.last().end()
        s.clock.advance(Live.RETRY_FIRST_MS)
        s.last().push(hello("fleet"))
        assertEquals(listOf("up fleet", "up fleet"), s.told)
    }

    @Test fun renewedAfterTheNetworkChangedAFreshOneIsOpenedAtOnceAndTheOldClosedWithoutSayingDown() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.link.renew()
        assertEquals(2, s.opened.size)
        assertTrue(s.opened[0].closed)
        s.clock.advance(Live.HELLO_WAIT_MS - 1)
        s.last().push(hello("fleet"))
        assertEquals(listOf("up fleet", "up fleet"), s.told)
        // And one that doesn't come back in time is down, then retried as any failure is.
        s.link.renew()
        s.clock.advance(Live.HELLO_WAIT_MS)
        assertEquals(listOf("up fleet", "up fleet", "down"), s.told)
        // Stopped, it isn't renewed.
        s.link.stop()
        val opened = s.opened.size
        s.link.renew()
        assertEquals(opened, s.opened.size)
    }

    // Seen on the emulator (26 November 2026): Wi-Fi off, the network was lost, then cellular came 0.2 s later. On a phone, a
    // fresh stream opened in that gap fails at once, and down was said at once: "can't reach" at every handover. Up a
    // moment ago, it is down only if it isn't up again within HELLO_WAIT, whatever its fresh ones do meanwhile.
    @Test fun renewedWhereTheFreshOneFailsAtOnceItIsntDownIfUpAgainWithinHelloWait() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.refuseWith = java.io.IOException("no network")
        s.link.renew()
        assertEquals(listOf("up fleet"), s.told)
        s.refuseWith = null
        s.clock.advance(Live.RETRY_FIRST_MS)
        s.last().push(hello("fleet"))
        assertEquals(listOf("up fleet", "up fleet"), s.told)
    }

    @Test fun upAMomentAgoAndFailingSinceItIsDownWhenHelloWaitEndsNotLater() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.refuseWith = java.io.IOException("no network")
        s.link.renew()
        s.clock.advance(Live.HELLO_WAIT_MS - 1)
        assertEquals(listOf("up fleet"), s.told)
        // (Its retries meanwhile don't push it later.)
        assertTrue(s.opened.size >= 3)
        s.clock.advance(1)
        assertEquals(listOf("up fleet", "down"), s.told)
        // And one that ended on its own, as one does when its node restarts, is held to the same.
        val t = Setup()
        t.link.start()
        t.last().push(hello("fleet"))
        t.refuseWith = java.io.IOException("node restarting")
        t.last().end()
        t.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals(listOf("up fleet"), t.told)
        t.clock.advance(Live.HELLO_WAIT_MS - Live.RETRY_FIRST_MS)
        assertEquals(listOf("up fleet", "down"), t.told)
    }

    @Test fun itsTimingIsTheWebAppsAndTheIPhones() {
        val live = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["live"]
        assertEquals(live["helloWaitMs"].long, Live.HELLO_WAIT_MS)
        assertEquals(live["retryFirstMs"].long, Live.RETRY_FIRST_MS)
        assertEquals(live["retryMaxMs"].long, Live.RETRY_MAX_MS)
        assertEquals(live["steadyMs"].long, Live.STEADY_MS)
        assertEquals(live["gapMs"].long, Live.GAP_MS)
        assertEquals(live["beatMs"].long, Live.BEAT_MS)
        // A node of today beats every LIVE_BEAT_MS and says so: three silent are gone within five seconds.
        assertEquals(live["silentMs"].long, Live.SILENT_MS)
        assertTrue(Live.SILENT_MS <= 5_000)
    }

    @Test fun oneOpenButSayingNoHelloIsDownAfterAWhileAndStaysOpen() {
        val s = Setup()
        s.link.start()
        s.clock.advance(Live.HELLO_WAIT_MS)
        assertEquals(listOf("down"), s.told)
        assertFalse(s.last().closed)
        s.last().push(hello("turns"))
        assertEquals(listOf("down", "up turns"), s.told)
    }

    @Test fun stoppedItIsClosedAndOpenedNoMoreUntilStarted() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        s.link.stop()
        s.clock.advance(10 * 60_000L)
        assertEquals(1, s.opened.size)
        assertTrue(s.opened[0].closed)
        assertEquals(listOf("up fleet"), s.told)
        s.link.start()
        assertEquals(2, s.opened.size)
    }

    @Test fun whoAttachesLaterIsToldAtOnceWhereItStands() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("pairings"))
        val late = ArrayList<String>()
        s.link.attach(object : LinkHandlers {
            override fun up(topics: List<String>, at: Long, changed: List<String>?) { late += "up ${topics.joinToString(",")}" }
            override fun changed(topics: List<String>) {}
            override fun down() { late += "down" }
        })
        assertEquals(listOf("up pairings"), late)
    }

    // ---- what the app reads ----

    private class Reads {
        val clock = Clock()
        val f = Followers(clock.after) { clock.now }
        val runs = ArrayList<String>()
        fun follow(name: String, topics: List<String>, everyMs: Long?, owner: Boolean = true, gapMs: Long = Live.GAP_MS): () -> Unit =
            f.follow(topics, everyMs, gapMs, readNow = owner) { changed, done ->
                runs += name + (changed?.let { " ${it.joinToString(",")}" } ?: "")
                done(true)
            }
    }

    @Test fun whenTheStreamComesUpWhatWasReadBeforeItsHelloIsReadOnceAndNothingAtRest() {
        val r = Reads()
        r.follow("inbox", listOf("actions", "notices"), 15_000, owner = false)
        r.follow("fleet", listOf("fleet"), 15_000)
        r.clock.advance(200)
        r.follow("team", listOf("team"), 2_000)
        r.f.up(100)
        r.clock.advance(Live.GAP_MS)
        assertEquals(listOf("inbox", "fleet"), r.runs)
        r.clock.advance(60_000)
        assertEquals(2, r.runs.size)
        r.f.changed(listOf("notices", "team"))
        r.clock.advance(Live.GAP_MS)
        assertEquals(listOf("inbox", "fleet", "inbox notices", "team team"), r.runs)
    }

    @Test fun oneItsOwnerJustReadWaitsItsGapBeforeAChangeRunsItAgain() {
        val r = Reads()
        r.f.up(0)
        r.clock.advance(1_000)
        r.follow("team", listOf("team"), 2_000, owner = true, gapMs = 2_000)
        r.f.changed(listOf("team"))
        r.clock.advance(1_999)
        assertEquals(emptyList<String>(), r.runs)
        r.clock.advance(1)
        assertEquals(listOf("team team"), r.runs)
    }

    @Test fun whileTheStreamIsDownEachRunsAtOnceThenAtItsPaceAndUpAgainThePollingStops() {
        val r = Reads()
        r.follow("fleet", listOf("fleet"), 15_000)
        r.follow("room", listOf("team"), 2_000)
        r.f.down()
        r.clock.advance(15_000)
        assertEquals(2, r.runs.count { it == "fleet" })
        assertEquals(8, r.runs.count { it == "room" })
        r.runs.clear()
        r.clock.advance(500)
        r.f.up(r.clock.now)
        r.clock.advance(60_000)
        assertEquals(listOf("fleet", "room"), r.runs.sorted())
    }

    @Test fun changesWhileOneRunsAreMergedIntoOneMoreRunAfterItNoCloserThanItsGap() {
        val clock = Clock()
        val f = Followers(clock.after) { clock.now }
        val runs = ArrayList<List<String>?>()
        var finish: (Boolean) -> Unit = {}
        f.follow(listOf("actions", "notices", "questions"), null, 1_000, readNow = false) { changed, done ->
            runs += changed
            finish = done
        }
        f.up(clock.now)
        f.changed(listOf("actions"))
        f.changed(listOf("notices"))
        f.changed(listOf("actions"))
        clock.advance(5_000)
        assertEquals(listOf<List<String>?>(null), runs)
        finish(true)
        clock.advance(999)
        assertEquals(listOf(null, listOf("actions", "notices")), runs)
    }

    @Test fun oneThatKeepsItsOwnTimeWhileDownRunsOnceAndIsntPolled() {
        val r = Reads()
        r.follow("underway", listOf("team", "turns"), null)
        r.f.down()
        r.clock.advance(60_000)
        assertEquals(listOf("underway"), r.runs)
    }

    @Test fun offNothingRunsWhateverChangesAndOneThatStoppedFollowingIsNeverRun() {
        val r = Reads()
        val stop = r.follow("gone", listOf("fleet"), 1_000)
        r.follow("inbox", listOf("actions"), 1_000)
        stop()
        r.f.down()
        r.clock.advance(1_500)
        r.f.off()
        r.runs.clear()
        r.f.changed(listOf("actions"))
        r.clock.advance(60_000)
        assertEquals(emptyList<String>(), r.runs)
    }

    // ---- the stream, opened again from where it left off (core's live.ts since 9c8d7fb; the web's 35832bc, case for case) ----

    /** A node's of today: where things stand, and from a hello opened from a cursor, what changed since. */
    private fun helloAt(at: String, topics: List<String>, since: List<String>? = null) = LiveEvent.Hello(topics, 1_500, at, since)
    private fun changedAt(at: String, vararg topics: String) = LiveEvent.Changed(topics.toList(), at)

    @Test fun itIsOpenedAgainFromTheLastCursorItsNodeGaveAndThatHelloSaysOnlyWhatChangedSince() {
        val s = Setup()
        s.link.start()
        assertEquals(null, s.last().since)
        s.last().push(helloAt("b00t.4", listOf("actions", "notices")))
        s.last().push(changedAt("b00t.5", "actions"))
        s.last().end()
        s.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals("b00t.5", s.last().since)
        s.last().push(helloAt("b00t.7", listOf("actions", "notices"), listOf("notices")))
        // Nothing changed since: nothing to read but the stream.
        s.last().end()
        s.clock.advance(2 * Live.RETRY_FIRST_MS)
        assertEquals("b00t.7", s.last().since)
        s.last().push(helloAt("b00t.7", listOf("actions", "notices"), emptyList()))
        assertEquals(listOf("up actions,notices", "changed actions", "up actions,notices changed:notices", "up actions,notices changed:"), s.told)
    }

    @Test fun stoppedAndStartedAgainItOpensFromWhereItLeftOffAndRenewedAsItWentSilentToo() {
        val s = Setup()
        s.link.start()
        s.last().push(helloAt("b00t.3", listOf("fleet")))
        s.link.stop()
        s.link.start()
        assertEquals("b00t.3", s.last().since)
        s.last().push(helloAt("b00t.3", listOf("fleet"), emptyList()))
        s.clock.advance(s.link.silent)
        s.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals(3, s.opened.size)
        assertEquals("b00t.3", s.last().since)
    }

    @Test fun withNoCursorFromItsNodeOrOneThatIsntOneItOpensAfreshAndOneOpenedAfreshIsReadAsFresh() {
        val s = Setup()
        s.link.start()
        s.last().push(hello("fleet"))
        // Each ends soon after it opened, and is opened again after its wait (a second, then twice as long each time).
        var wait = Live.RETRY_FIRST_MS
        fun again() {
            s.last().end()
            s.clock.advance(wait)
            wait = minOf(wait * 2, Live.RETRY_MAX_MS)
        }
        again()
        assertEquals(null, s.last().since)
        for (notOne in listOf("a b", "", "b00t.1?x=1", "x".repeat(65))) {
            s.last().push(helloAt(notOne, listOf("fleet")))
            again()
            assertEquals(notOne, null, s.last().since)
        }
        // (What a hello says changed means nothing from a stream not opened from a cursor.)
        s.last().push(helloAt("b00t.2", listOf("fleet"), emptyList()))
        assertEquals("up fleet", s.told.last())
    }

    @Test fun aHelloThatTellsOfOtherTopicsThanTheStreamBeforeItIsReadAsAFreshOne() {
        val s = Setup()
        s.link.start()
        s.last().push(helloAt("b00t.1", listOf("actions", "secretRequests")))
        s.last().end()
        s.clock.advance(Live.RETRY_FIRST_MS)
        assertEquals("b00t.1", s.last().since)
        s.last().push(helloAt("b00t.2", listOf("actions"), emptyList()))
        // And what one says changed is held to what it tells of.
        s.last().end()
        s.clock.advance(2 * Live.RETRY_FIRST_MS)
        s.last().push(helloAt("b00t.3", listOf("actions"), listOf("actions", "pairings")))
        assertEquals(listOf("up actions,secretRequests", "up actions", "up actions changed:actions"), s.told)
    }

    @Test fun theStreamsPathCarriesOnlyACursor() {
        assertEquals("/api/live", Live.path(null))
        assertEquals("/api/live?since=b00t.5", Live.path("b00t.5"))
        for (notOne in listOf("a b", "", "b00t.1?x=1", "x".repeat(65), "b00t/5")) assertEquals(notOne, "/api/live", Live.path(notOne))
    }

    @Test fun resumedOnlyWhatChangedSinceRunsWithWhatNeverReadWhatNothingChangedOfRunsNotAtAll() {
        val r = Reads()
        r.follow("inbox", listOf("actions", "notices"), 15_000)
        r.follow("fleet", listOf("fleet"), 15_000)
        r.follow("team", listOf("team"), 2_000, owner = false)
        r.clock.advance(1_000)
        r.f.up(r.clock.now, listOf("notices", "pairings"))
        r.clock.advance(Live.GAP_MS)
        assertEquals(listOf("inbox notices", "team"), r.runs.sorted())
        r.runs.clear()
        r.f.up(r.clock.now, emptyList())
        r.clock.advance(60_000)
        assertEquals(emptyList<String>(), r.runs)
    }

    @Test fun whatGoingOffScreenCalledOffIsOwedAndRunsOnceTheStreamIsUpAgain() {
        val r = Reads()
        r.follow("inbox", listOf("actions"), 15_000, owner = true, gapMs = 2_000)
        r.follow("fleet", listOf("fleet"), 15_000, owner = true, gapMs = 2_000)
        r.f.up(r.clock.now)
        r.clock.advance(100)
        // Told of a change it waits its gap to read, and the app off screen before it did.
        r.f.changed(listOf("actions"))
        r.f.off()
        r.clock.advance(10_000)
        assertEquals(emptyList<String>(), r.runs)
        r.f.up(r.clock.now, emptyList())
        r.clock.advance(Live.GAP_MS)
        assertEquals(listOf("inbox actions"), r.runs)
    }

    @Test fun toldOfAChangeWhileOffScreenItIsOwedAndRunsOnceTheStreamIsUpAgain() {
        val r = Reads()
        r.follow("notices", listOf("notices"), 15_000)
        r.f.off()
        r.f.changed(listOf("notices"))
        r.clock.advance(60_000)
        assertEquals(emptyList<String>(), r.runs)
        r.f.up(r.clock.now, emptyList())
        r.clock.advance(Live.GAP_MS)
        assertEquals(listOf("notices notices"), r.runs)
    }

    @Test fun aRunThatFailedIsOwedNeverTriedAgainOnItsOwnRunOnceTheStreamIsUpAgainWithWhatChangesMeanwhile() {
        val clock = Clock()
        val f = Followers(clock.after) { clock.now }
        val runs = ArrayList<List<String>?>()
        var failing = true
        f.follow(listOf("actions", "notices"), 15_000, Live.GAP_MS, readNow = true) { changed, done ->
            runs += changed
            done(!failing)
        }
        f.up(clock.now)
        clock.advance(Live.GAP_MS)
        f.changed(listOf("actions"))
        clock.advance(60_000)
        assertEquals(listOf<List<String>?>(listOf("actions")), runs)
        failing = false
        f.up(clock.now, emptyList())
        clock.advance(Live.GAP_MS)
        assertEquals(listOf<List<String>?>(listOf("actions"), listOf("actions")), runs)
        // Paid: nothing owed now.
        f.up(clock.now, emptyList())
        clock.advance(60_000)
        assertEquals(2, runs.size)
        // Owed, and told of another change: both in the one run.
        failing = true
        f.changed(listOf("actions"))
        clock.advance(Live.GAP_MS)
        failing = false
        f.changed(listOf("notices"))
        clock.advance(Live.GAP_MS)
        assertEquals(listOf("notices", "actions"), runs.last())
    }

    @Test fun aRunUnderWayWhenTheStreamComesUpAgainThatThenFailsRunsOnceMoreAtOnce() {
        val clock = Clock()
        val f = Followers(clock.after) { clock.now }
        val runs = ArrayList<List<String>?>()
        var finish: (Boolean) -> Unit = {}
        f.follow(listOf("actions"), 15_000, Live.GAP_MS, readNow = true) { changed, done ->
            runs += changed
            finish = done
        }
        f.up(clock.now)
        clock.advance(Live.GAP_MS)
        f.changed(listOf("actions"))
        // Its read hangs on the network that went; the stream renewed meanwhile says nothing changed since (it told this).
        clock.advance(1_000)
        f.up(clock.now, emptyList())
        assertEquals(listOf<List<String>?>(listOf("actions")), runs)
        finish(false)
        clock.advance(Live.GAP_MS)
        assertEquals(listOf<List<String>?>(listOf("actions"), listOf("actions")), runs)
        // Once: one that fails again is owed, as any is.
        finish(false)
        clock.advance(60_000)
        assertEquals(2, runs.size)
    }

    // ---- the opener: the stream read in a coroutine ----

    private fun scope(escaped: java.util.concurrent.atomic.AtomicReference<Throwable?>) = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.CoroutineExceptionHandler { _, e -> escaped.set(e) },
    )

    private fun lostConnection() = NodeError(0, "Lost the connection to the node.", unreachable = true)

    // Seen on the emulator (26 November 2026): a dead link's stream, closed, ended in "Lost the connection", which was
    // thrown out of its coroutine and crashed the app. However a stream ends, it ends in `ended`, and nothing escapes.
    @Test fun aStreamThatFailsEndsInWordsNeverAsACrash() {
        val escaped = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val ended = java.util.concurrent.LinkedBlockingQueue<Any>()
        val events = java.util.Collections.synchronizedList(ArrayList<LiveEvent>())
        val open = liveOpen(scope(escaped), kotlinx.coroutines.Dispatchers.IO, post = { it() }) { _, _, alive, event ->
            alive()
            event(Json.parse("""{"type":"hello","topics":["team"]}"""))
            throw lostConnection()
        }
        open(null, {}, { events += it }) { ended.put(it ?: "ended") }
        val why = ended.poll(5, java.util.concurrent.TimeUnit.SECONDS)
        assertTrue(why is NodeError)
        assertEquals("Lost the connection to the node.", (why as NodeError).message)
        assertEquals(listOf<LiveEvent>(LiveEvent.Hello(listOf("team"), null)), events.toList())
        // (Nothing reached the scope's handler, which is where an app's crash begins; and it ended once.)
        assertEquals(null, escaped.get())
        assertEquals(null, ended.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS))
    }

    @Test fun aStreamClosedByItsOpenerIsClosedThroughItsConnectionAndEnds() {
        val escaped = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val ended = java.util.concurrent.LinkedBlockingQueue<Any>()
        val reading = java.util.concurrent.CountDownLatch(1)
        val open = liveOpen(scope(escaped), kotlinx.coroutines.Dispatchers.IO, post = { it() }) { _, opened, _, _ ->
            // A read blocked until its connection is closed: cancelling its coroutine alone never ends it.
            val gate = java.util.concurrent.CountDownLatch(1)
            opened { gate.countDown() }
            reading.countDown()
            gate.await()
            throw lostConnection()
        }
        val close = open(null, {}, {}) { ended.put(it ?: "ended") }
        assertTrue(reading.await(5, java.util.concurrent.TimeUnit.SECONDS))
        close()
        assertTrue(ended.poll(5, java.util.concurrent.TimeUnit.SECONDS) is NodeError)
        assertEquals(null, escaped.get())
    }

    @Test fun oneClosedBeforeItsConnectionIsMadeIsClosedAsSoonAsItIs() {
        val escaped = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val ended = java.util.concurrent.LinkedBlockingQueue<Any>()
        val connecting = java.util.concurrent.CountDownLatch(1)
        val asked = java.util.concurrent.CountDownLatch(1)
        val open = liveOpen(scope(escaped), kotlinx.coroutines.Dispatchers.IO, post = { it() }) { _, opened, _, _ ->
            connecting.countDown()
            // (Connecting while the close is asked: the connection is handed over only after.)
            asked.await()
            val gate = java.util.concurrent.CountDownLatch(1)
            opened { gate.countDown() }
            gate.await()
            throw lostConnection()
        }
        val close = open(null, {}, {}) { ended.put(it ?: "ended") }
        assertTrue(connecting.await(5, java.util.concurrent.TimeUnit.SECONDS))
        close()
        asked.countDown()
        assertTrue(ended.poll(5, java.util.concurrent.TimeUnit.SECONDS) != null)
        assertEquals(null, escaped.get())
    }

    @Test fun anEventIsReadStrictly() {
        assertEquals(LiveEvent.Hello(listOf("team", "fleet"), 1_500), LiveEvent.read(Json.parse("""{"type":"hello","topics":["team","fleet"],"beat":1500}""")))
        assertEquals(LiveEvent.Changed(listOf("actions")), LiveEvent.read(Json.parse("""{"type":"changed","topics":["actions"]}""")))
        assertEquals(LiveEvent.Bye("revoked"), LiveEvent.read(Json.parse("""{"type":"bye","reason":"revoked"}""")))
        assertEquals(null, LiveEvent.read(Json.parse("""{"type":"other"}""")))
        assertEquals(LiveEvent.Hello(listOf("team"), null), LiveEvent.read(Json.parse("""{"type":"hello","topics":["team"]}""")))
        assertEquals(LiveEvent.Hello(listOf("team"), 1_500, "b00t.7", listOf("team")), LiveEvent.read(Json.parse("""{"type":"hello","topics":["team"],"beat":1500,"at":"b00t.7","changed":["team"]}""")))
        assertEquals(LiveEvent.Changed(listOf("actions"), "b00t.8"), LiveEvent.read(Json.parse("""{"type":"changed","topics":["actions"],"at":"b00t.8"}""")))
        // A beat no node would say is no beat (the iPhone's rule): a stream isn't taken for dead after 15 ms.
        assertEquals(LiveEvent.Hello(emptyList(), null), LiveEvent.read(Json.parse("""{"type":"hello","topics":[],"beat":5}""")))
        assertEquals(LiveEvent.Hello(emptyList(), null), LiveEvent.read(Json.parse("""{"type":"hello","topics":[],"beat":600000}""")))
    }

    // ---- the network under the app ----

    @Test fun theFirstLookAtTheNetworkIsNoChangeAnotherOrOneBackIs() {
        val w = NetworkWatch<String>()
        assertFalse(w.available("wifi"))
        assertFalse(w.available("wifi"))
        // Wi-Fi to cellular: the stream open on Wi-Fi may be dead without a word.
        assertTrue(w.available("cellular"))
        // Lost with none to take its place, then back.
        assertFalse(w.lost("wifi"))
        assertTrue(w.lost("cellular"))
        assertTrue(w.available("cellular"))
    }

    @Test fun aNetworkThatComesWhenThereWasNoneAtFirstIsNoChangeTheLinkIsRetriedAsItWould() {
        val w = NetworkWatch<String>()
        assertFalse(w.available("wifi"))
        assertTrue(w.lost("wifi"))
    }
}
