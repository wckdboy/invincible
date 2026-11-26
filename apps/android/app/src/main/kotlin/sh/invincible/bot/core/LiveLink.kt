package sh.invincible.bot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext

/*
 * The node's live stream (core's live.ts; GET /api/live), kept open while the app is on screen: it says which of what the
 * app shows changed, and only that is read again. The web's lib/live-link.ts and the iPhone's Node/LiveLink.swift, the
 * same rules: neither part touches Android, so both are tested with a clock in hand (LiveLinkTest).
 *
 * LiveLink keeps the stream open. One that ends is opened again at once if it had been open a while, otherwise a second
 * later, then twice as long each time, up to half a minute. One the node refuses (an older node without it, a device that
 * may not read it, a revoked one) is opened again only when told to: the app shown again, the network back. One that says
 * nothing at all for three of the node's beats is taken for dead, said to be lost at once, and opened again; the node says
 * its beat in its hello (an older node, which doesn't, beats every 15 s). `renew` opens a fresh one at once, whatever
 * stands: the network changed under it, so the one open may be dead without a word (Wi-Fi to cellular), and a link that
 * comes back within HELLO_WAIT_MS is never said to have gone.
 *
 * Followers are what the app reads, each for its topics. When the stream comes up, each whose last read began before the
 * stream said hello runs once (what it shows may be from before the node was telling of changes); one read since can't
 * have missed anything. Then each runs only when one of its topics changes. While the stream is down (no hello within
 * HELLO_WAIT_MS, or it can't be opened) each runs at once and then every so often, at its own interval, as the app did
 * before there was a stream. A follower runs one at a time: what comes meanwhile is merged into one more run after it,
 * and runs come no closer together than its gap.
 */

/** Runs `run` after `ms`; returns how to call it off. */
typealias After = (ms: Long, run: () -> Unit) -> () -> Unit

object Live {
    /** A stream that hasn't said hello this long after it was opened is down: what the app shows is asked for meanwhile. */
    const val HELLO_WAIT_MS = 3_000L
    /** The node's beat (core's LIVE_BEAT_MS): a comment this often between events, on this stream and on a turn's. */
    const val BEAT_MS = 1_500L
    /** Three beats of a node of today: a stream silent this long is gone (each link holds to its node's own: LiveLink.silent). */
    const val SILENT_MS = 3 * BEAT_MS
    /** Opening it again after a failure: first after this long, then twice as long each time, up to RETRY_MAX_MS. */
    const val RETRY_FIRST_MS = 1_000L
    const val RETRY_MAX_MS = 30_000L
    /** A stream that was open at least this long is opened again at once when it ends (the node restarting). */
    const val STEADY_MS = 30_000L
    /** Runs of one follower come no closer together than this, unless it says otherwise. */
    const val GAP_MS = 500L
    /** The beat of an older node, whose hello doesn't say its own. */
    const val OLDER_BEAT_MS = 15_000L
}

/** What the stream says: the topics it tells of (read each now), what changed (read again), and that it is ending. */
sealed class LiveEvent {
    data class Hello(val topics: List<String>, val beat: Long?) : LiveEvent()
    data class Changed(val topics: List<String>) : LiveEvent()
    data class Bye(val reason: String) : LiveEvent()

    companion object {
        /** An event as the node sends it (`data: <json>`), read strictly: anything else is no event. */
        fun read(j: Json): LiveEvent? = when (j["type"].string) {
            // (A beat no node would say is no beat: a stream isn't taken for dead after 15 ms, nor kept for an hour.)
            "hello" -> Hello(j["topics"].list.mapNotNull { it.string }, j["beat"].long?.takeIf { it in 250L..60_000L })
            "changed" -> Changed(j["topics"].list.mapNotNull { it.string })
            "bye" -> Bye(j["reason"].string ?: "")
            else -> null
        }
    }
}

/** Who hears where the stream stands. */
interface LinkHandlers {
    /** It is open since `at` (when it said hello), and tells of these topics: read now what was read before then. */
    fun up(topics: List<String>, at: Long)
    fun changed(topics: List<String>)
    /** It isn't open, and hasn't been for a while (or can't be): ask for what is shown on a timer until it is. */
    fun down()
    /** It was up and went silent for three beats: dead, whatever comes next (said at once, not after HELLO_WAIT_MS). */
    fun lost() {}
}

/**
 * Opens the stream: `alive` on everything that arrives (its beats too), `event` for each event, `ended` once when it
 * closes (null: it ended; else why it failed). Returns how to close it, after which `ended` may still come, and is let be.
 */
typealias LiveOpen = (alive: () -> Unit, event: (LiveEvent) -> Unit, ended: (Throwable?) -> Unit) -> () -> Unit

class LiveLink(
    private val open: LiveOpen,
    /** A failure that is the node's refusal: not tried again on a timer. */
    private val refused: (Throwable) -> Boolean,
    private val after: After,
    private val now: () -> Long,
) {
    private var handlers: LinkHandlers? = null
    private var running = false
    /** The stream being opened or open (its own token); null: none. */
    private var current: Any? = null
    var up = false
        private set
    private var upAt = 0L
    private var topics: List<String> = emptyList()
    /** Down has been said since it was last up. */
    private var saidDown = false
    private var delay = Live.RETRY_FIRST_MS
    private var retrying: (() -> Unit)? = null
    private var downing: (() -> Unit)? = null
    private var silence: (() -> Unit)? = null
    /** The stream that went silent, closed for it (its end says it was lost). */
    private var quiet: Any? = null
    /** Up a moment ago: down only if it isn't up again within HELLO_WAIT_MS of then, whatever fresh ones do meanwhile. */
    private var grace = false

    /** The node's beat, as its last hello said (an older node's until one has): three of them silent and a stream is gone. */
    var beat = Live.OLDER_BEAT_MS
        private set

    /** Nothing at all on the stream for this long, its beats included: it is gone. */
    val silent: Long get() = 3 * beat

    private fun goUp(told: List<String>, said: Long?) {
        up = true
        upAt = now()
        saidDown = false
        downing = off(downing)
        grace = false
        topics = told
        beat = said ?: Live.OLDER_BEAT_MS
        handlers?.up(told, upAt)
    }

    private fun goDown() {
        downing = off(downing)
        grace = false
        if (up || saidDown || !running) return
        saidDown = true
        handlers?.down()
    }

    /** A stream opened: down if it says no hello in time; but up a moment ago, the time is still counted from then. */
    private fun waitForHello() {
        if (grace) return
        downing = off(downing)
        if (!saidDown) downing = after(Live.HELLO_WAIT_MS) { goDown() }
    }

    /**
     * It was up a moment ago (its stream ended, or was renewed): down only if it isn't up again within HELLO_WAIT_MS. A
     * fresh one that fails at once meanwhile (a phone between networks) doesn't say it sooner, nor its retries later.
     */
    private fun wasUp() {
        downing = off(downing)
        grace = !saidDown
        if (grace) downing = after(Live.HELLO_WAIT_MS) { goDown() }
    }

    private fun connect() {
        retrying = off(retrying)
        val token = Any()
        current = token
        var helloAt: Long? = null
        var close: (() -> Unit)? = null
        var closed = false
        val abort = {
            if (!closed) {
                closed = true
                close?.invoke()
            }
        }
        closeCurrent = abort
        val watch = {
            silence = off(silence)
            silence = after(silent) {
                // Gone quiet: closed, and its end opens another.
                quiet = token
                abort()
            }
        }
        watch()
        waitForHello()
        val ended = fun(failure: Throwable?) {
            // Closed on purpose (stopped), or another opened since: nothing more of this one.
            if (current !== token) return
            current = null
            closeCurrent = null
            silence = off(silence)
            val was = up
            up = false
            if (was && quiet === token) handlers?.lost()
            quiet = null
            abort()
            if (failure != null && refused(failure)) {
                goDown()
                return
            }
            val opened = helloAt
            val steady = opened != null && now() - opened >= Live.STEADY_MS
            val wait = if (steady) 0L else delay
            delay = if (steady) Live.RETRY_FIRST_MS else minOf(delay * 2, Live.RETRY_MAX_MS)
            // Up a moment ago: down only if it isn't up again soon. Never up (and not up a moment before): down now.
            if (was) wasUp() else if (!grace) goDown()
            retrying = after(wait) { connect() }
        }
        close = open(
            { if (current === token) watch() },
            { event ->
                if (current === token) {
                    when (event) {
                        is LiveEvent.Hello -> {
                            helloAt = now()
                            goUp(event.topics, event.beat)
                            // (The node's beat, now known: three of them silent and it is gone.)
                            watch()
                        }
                        is LiveEvent.Changed -> if (up) handlers?.changed(event.topics)
                        is LiveEvent.Bye -> abort()
                    }
                }
            },
            { failure -> ended(failure) },
        )
        if (closed) close?.invoke()
    }

    /** Opens it, and keeps it open (the app is on screen). */
    fun start() {
        if (running) return
        running = true
        delay = Live.RETRY_FIRST_MS
        connect()
    }

    /** Closes it, and opens it no more until started (the app off screen, or gone). */
    fun stop() {
        running = false
        current = null
        retrying = off(retrying)
        downing = off(downing)
        silence = off(silence)
        val closing = closeCurrent
        closeCurrent = null
        closing?.invoke()
        up = false
        saidDown = false
        grace = false
    }

    /**
     * Opens a fresh one at once, whatever stands: the network changed, and the one open may be dead without a word. Up a
     * moment ago, it is said to be down only if the fresh one says no hello in time.
     */
    fun renew() {
        if (!running) return
        val was = up
        current = null
        val closing = closeCurrent
        closeCurrent = null
        closing?.invoke()
        silence = off(silence)
        retrying = off(retrying)
        up = false
        if (was) wasUp()
        delay = Live.RETRY_FIRST_MS
        connect()
    }

    /** Opens it now if it isn't open, refused or not (the network is back). */
    fun retry() {
        if (!running || current != null) return
        delay = Live.RETRY_FIRST_MS
        connect()
    }

    /** Who is told from now on; they're told at once where it stands, if it is up or down. */
    fun attach(next: LinkHandlers) {
        handlers = next
        if (up) next.up(topics, upAt) else if (saidDown) next.down()
    }

    /** How to close the stream being opened or open now. */
    private var closeCurrent: (() -> Unit)? = null

    private fun off(cancel: (() -> Unit)?): (() -> Unit)? {
        cancel?.invoke()
        return null
    }
}

/** What a follower runs: `changed` names its topics that changed, or is null when everything is to be read; `done` once
 * it has finished (its read answered or failed). */
typealias FollowerRun = (changed: List<String>?, done: () -> Unit) -> Unit

/**
 * `run`, one at a time: what is asked for meanwhile is merged into one more run after it, never closer than `gapMs` to
 * the last (`last`: when it last ran before this, if it did).
 */
class Paced(private val run: FollowerRun, private val gapMs: Long, private val after: After, private val now: () -> Long, private var last: Long = Long.MIN_VALUE / 2) {
    private var running = false
    /** null: nothing; ALL: everything; otherwise these. */
    private var wanted: MutableSet<String>? = null
    private var all = false
    private var waiting: (() -> Unit)? = null

    private fun go() {
        if (running || (wanted == null && !all) || waiting != null) return
        val wait = last + gapMs - now()
        if (wait > 0) {
            waiting = after(wait) {
                waiting = null
                go()
            }
            return
        }
        val changed = if (all) null else wanted?.toList()
        wanted = null
        all = false
        running = true
        last = now()
        var finished = false
        run(changed) {
            if (!finished) {
                finished = true
                running = false
                go()
            }
        }
    }

    fun want(topics: List<String>?) {
        if (topics == null || all) {
            all = true
            wanted = null
        } else (wanted ?: mutableSetOf<String>().also { wanted = it }).addAll(topics)
        go()
    }

    fun cancel() {
        wanted = null
        all = false
        waiting?.invoke()
        waiting = null
    }
}

/** What the app reads, each for its topics, as the stream stands (LiveLink). */
class Followers(private val after: After, private val now: () -> Long) {
    private class Follower(val topics: Set<String>, val everyMs: Long?) {
        lateinit var pace: Paced
        var timer: (() -> Unit)? = null
        /** When what it shows was last read (its owner's read, then each run's start). */
        var since: Long = Long.MIN_VALUE / 2
    }

    private val all = LinkedHashSet<Follower>()
    private var mode = "off"

    /**
     * `run` when one of these topics changes while the stream is up (and once when it comes up, if what it shows was read
     * before); at once and then every `everyMs` while it is down (null: once, and it keeps its own time from there); never
     * while the app is off screen. Not now: it is read when the stream comes up (or goes down), unless `readNow` says its
     * owner has just read it. Returns how to stop following.
     */
    fun follow(topics: List<String>, everyMs: Long?, gapMs: Long = Live.GAP_MS, readNow: Boolean = false, run: FollowerRun): () -> Unit {
        val follower = Follower(topics.toSet(), everyMs)
        val read = if (readNow) now() else Long.MIN_VALUE / 2
        follower.since = read
        follower.pace = Paced({ changed, done ->
            follower.since = now()
            run(changed, done)
        }, gapMs, after, now, read)
        all += follower
        if (mode == "down") {
            follower.pace.want(null)
            poll(follower)
        }
        return {
            all -= follower
            follower.timer?.invoke()
            follower.timer = null
            follower.pace.cancel()
        }
    }

    /** The stream is up, since `at`: each that last read before then runs once now; then each runs when its topics change. */
    fun up(at: Long) {
        mode = "up"
        for (follower in all.toList()) {
            follower.timer?.invoke()
            follower.timer = null
            if (follower.since < at) follower.pace.want(null)
        }
    }

    fun changed(topics: List<String>) {
        if (mode != "up") return
        for (follower in all.toList()) {
            val mine = topics.filter { it in follower.topics }
            if (mine.isNotEmpty()) follower.pace.want(mine)
        }
    }

    /** The stream is down: each runs now, then every so often. */
    fun down() {
        mode = "down"
        for (follower in all.toList()) {
            follower.pace.want(null)
            poll(follower)
        }
    }

    /** Nothing runs: the app is off screen. */
    fun off() {
        mode = "off"
        for (follower in all.toList()) {
            follower.timer?.invoke()
            follower.timer = null
            follower.pace.cancel()
        }
    }

    private fun poll(follower: Follower) {
        follower.timer?.invoke()
        follower.timer = null
        val every = follower.everyMs ?: return
        lateinit var tick: () -> Unit
        tick = {
            follower.pace.want(null)
            follower.timer = after(every, tick)
        }
        follower.timer = after(every, tick)
    }
}

/**
 * LiveLink's opener over a coroutine. `read` opens the stream (on `io`, in `scope`), hands `opened` how to close its
 * connection (a read blocked on a dead link ends only when its connection is closed; cancelling its coroutine never ends
 * it), calls `alive` on everything that arrives and `event` with each payload, and returns or throws when the stream ends.
 * What it says is posted (`post`) to where the link runs. However it ends (closed, failed, cancelled, or cancelled before
 * it began) it ends in `ended`, once, and nothing is thrown out of its coroutine: there it would crash the app.
 */
fun liveOpen(
    scope: CoroutineScope,
    io: CoroutineContext,
    post: (() -> Unit) -> Unit,
    read: suspend (opened: (close: () -> Unit) -> Unit, alive: () -> Unit, event: (Json) -> Unit) -> Unit,
): LiveOpen = { alive, event, ended ->
    val closeIt = AtomicReference<(() -> Unit)?>(null)
    val closed = AtomicBoolean(false)
    val told = AtomicBoolean(false)
    val end = { why: Throwable? -> if (told.compareAndSet(false, true)) post { ended(why) } }
    val job = scope.launch(io) {
        try {
            read(
                { close ->
                    closeIt.set(close)
                    // (Closed while it was connecting: closed as soon as there is a connection to close.)
                    if (closed.get()) close()
                },
                { post(alive) },
            ) { j -> LiveEvent.read(j)?.let { e -> post { event(e) } } }
            end(null)
        } catch (e: CancellationException) {
            end(e)
            throw e
        } catch (e: Throwable) {
            end(e)
        }
    }
    // (Cancelled before it began, it never ran: it ends all the same.)
    job.invokeOnCompletion { end(it) }
    ({
        closed.set(true)
        closeIt.get()?.invoke()
        job.cancel()
    })
}

/**
 * The network under the app, as last seen (ConnectivityManager's default-network callback): whether a change can have left
 * a connection dead without a word (Wi-Fi to cellular, lost, back). The first look is no change. (The iPhone's PathWatch.)
 */
class NetworkWatch<N : Any> {
    private var seen: N? = null
    private var looked = false

    /** The default network is `n` now. True: it moved (another than before, or one back after none). */
    fun available(n: N): Boolean {
        val moved = looked && n != seen
        looked = true
        seen = n
        return moved
    }

    /** `n` went, with none to take its place. True: it was the one in use. */
    fun lost(n: N): Boolean {
        if (n != seen) return false
        seen = null
        return true
    }
}
