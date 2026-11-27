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
 * comes back within HELLO_WAIT_MS is never said to have gone. Each is opened from where the last left off: the last
 * cursor its node gave (a hello's or a change's `at`), and that hello says what changed since (core's live.ts). That is
 * trusted only from a stream opened from a cursor whose hello tells of the same topics as the stream before it; otherwise
 * the device's scopes changed, and it is read as a fresh hello.
 *
 * Followers are what the app reads, each for its topics. When a fresh stream comes up, each whose last read began before
 * the stream said hello runs once (what it shows may be from before the node was telling of changes); one read since
 * can't have missed anything. When a resumed one comes up, only those whose topics changed since run, with any that
 * never read and any owed a run: one whose run failed, one the app's going off screen called off, or one told of a change
 * meanwhile. Then each runs only when one of its topics changes. While the stream is down (no hello within HELLO_WAIT_MS,
 * or it can't be opened) each runs at once and then every so often, at its own interval, as the app did before there was
 * a stream. A follower runs one at a time: what comes meanwhile is merged into one more run after it, and runs come no
 * closer together than its gap. A run that failed is owed, never tried again by itself (a node refusing it would be
 * asked again and again): it runs with the follower's next, and when the stream is up again. One under way when the
 * stream came up again (a read hung on a network that went) that then failed runs once more at once, as nothing else
 * would read it.
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

    /** What a cursor of the stream is (core's LIVE_CURSOR): short, and only what a URL carries as it is. */
    val CURSOR = Regex("^[A-Za-z0-9_.-]{1,64}$")

    /** The stream's path, opened again from where the last left off when there is a cursor (core's livePath). */
    fun path(since: String?): String = if (since != null && CURSOR.matches(since)) "/api/live?since=$since" else "/api/live"
}

/**
 * What the stream says: the topics it tells of (read each now; or, with [Hello.changed], only those that changed since the
 * cursor it was opened from), what changed (read again), and that it is ending. `at`: where things stand, to open it
 * again from (absent from an older node).
 */
sealed class LiveEvent {
    data class Hello(val topics: List<String>, val beat: Long?, val at: String? = null, val changed: List<String>? = null) : LiveEvent()
    data class Changed(val topics: List<String>, val at: String? = null) : LiveEvent()
    data class Bye(val reason: String) : LiveEvent()

    companion object {
        /** An event as the node sends it (`data: <json>`), read strictly: anything else is no event. */
        fun read(j: Json): LiveEvent? = when (j["type"].string) {
            // (A beat no node would say is no beat: a stream isn't taken for dead after 15 ms, nor kept for an hour.)
            "hello" -> Hello(j["topics"].list.mapNotNull { it.string }, j["beat"].long?.takeIf { it in 250L..60_000L }, j["at"].string, (j["changed"] as? Json.Arr)?.items?.mapNotNull { it.string })
            "changed" -> Changed(j["topics"].list.mapNotNull { it.string }, j["at"].string)
            "bye" -> Bye(j["reason"].string ?: "")
            else -> null
        }
    }
}

/** Who hears where the stream stands. */
interface LinkHandlers {
    /** It is open since `at` (when it said hello), and tells of these topics: read now what was read before then; or,
     * resumed ([changed]), only what changed since the last stream left off (and what was never read, or is owed). */
    fun up(topics: List<String>, at: Long, changed: List<String>?)
    fun changed(topics: List<String>)
    /** It isn't open, and hasn't been for a while (or can't be): ask for what is shown on a timer until it is. */
    fun down()
    /** It was up and went silent for three beats: dead, whatever comes next (said at once, not after HELLO_WAIT_MS). */
    fun lost() {}
}

/**
 * Opens the stream (from `since`, the last cursor its node gave, when there is one: Live.path): `alive` on everything that
 * arrives (its beats too), `event` for each event, `ended` once when it closes (null: it ended; else why it failed).
 * Returns how to close it, after which `ended` may still come, and is let be.
 */
typealias LiveOpen = (since: String?, alive: () -> Unit, event: (LiveEvent) -> Unit, ended: (Throwable?) -> Unit) -> () -> Unit

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
    /** The last cursor the node gave (a hello's or a change's): the next stream is opened from it. */
    private var cursor: String? = null

    private fun keep(at: String?): String? = at?.takeIf { Live.CURSOR.matches(it) }

    /** The node's beat, as its last hello said (an older node's until one has): three of them silent and a stream is gone. */
    var beat = Live.OLDER_BEAT_MS
        private set

    /** Nothing at all on the stream for this long, its beats included: it is gone. */
    val silent: Long get() = 3 * beat

    private fun goUp(told: List<String>, said: Long?, changed: List<String>?) {
        up = true
        upAt = now()
        saidDown = false
        downing = off(downing)
        grace = false
        topics = told
        beat = said ?: Live.OLDER_BEAT_MS
        handlers?.up(told, upAt, changed)
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
        val since = cursor
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
            since,
            { if (current === token) watch() },
            { event ->
                if (current === token) {
                    when (event) {
                        is LiveEvent.Hello -> {
                            helloAt = now()
                            val told = event.topics
                            // What changed since, trusted from a stream opened from a cursor that tells of what the last told of.
                            val same = told.size == topics.size && told.all { it in topics }
                            val changed = if (since != null && same && event.changed != null) event.changed.filter { it in told } else null
                            cursor = keep(event.at)
                            goUp(told, event.beat, changed)
                            // (The node's beat, now known: three of them silent and it is gone.)
                            watch()
                        }
                        is LiveEvent.Changed -> if (up) {
                            cursor = keep(event.at) ?: cursor
                            handlers?.changed(event.topics)
                        }
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
        // (Read as a fresh hello: what changed before it was told to whoever was attached then.)
        if (up) next.up(topics, upAt, null) else if (saidDown) next.down()
    }

    /** How to close the stream being opened or open now. */
    private var closeCurrent: (() -> Unit)? = null

    private fun off(cancel: (() -> Unit)?): (() -> Unit)? {
        cancel?.invoke()
        return null
    }
}

/** What a follower runs: `changed` names its topics that changed, or is null when everything is to be read; `done` once
 * it has finished, saying whether its read was answered (false: it failed, and what it read is owed). */
typealias FollowerRun = (changed: List<String>?, done: (ok: Boolean) -> Unit) -> Unit

/** What a follower is asked to read: everything ([all]), or these topics (none: only what it is owed). */
private class Wanted(val all: Boolean, val topics: Set<String>) {
    fun plus(other: Wanted?): Wanted = if (other == null) this else if (all || other.all) ALL else Wanted(false, topics + other.topics)

    companion object {
        val ALL = Wanted(true, emptySet())
        fun of(topics: Collection<String>) = Wanted(false, LinkedHashSet(topics))
    }
}

private fun merged(a: Wanted?, b: Wanted?): Wanted? = a?.plus(b) ?: b

/**
 * `run`, one at a time: what is asked for meanwhile is merged into one more run after it, never closer than `gapMs` to
 * the last (`last`: when it last ran before this, if it did). A run that failed, or was called off before it ran
 * ([shelve]), is owed: run with the next, never by itself.
 */
class Paced(private val run: FollowerRun, private val gapMs: Long, private val after: After, private val now: () -> Long, private var last: Long = Long.MIN_VALUE / 2) {
    private var running = false
    private var wanted: Wanted? = null
    private var owing: Wanted? = null
    private var waiting: (() -> Unit)? = null

    /** Something failed or was called off, and is to be read with the next run. */
    val owed: Boolean get() = owing != null

    private fun go() {
        if (running || wanted == null || waiting != null) return
        val wait = last + gapMs - now()
        if (wait > 0) {
            waiting = after(wait) {
                waiting = null
                go()
            }
            return
        }
        val taking = merged(wanted, owing)!!
        val changed = if (taking.all) null else taking.topics.toList()
        wanted = null
        owing = null
        running = true
        last = now()
        var finished = false
        run(changed) { ok ->
            if (!finished) {
                finished = true
                running = false
                if (!ok) owing = merged(owing, taking)
                go()
            }
        }
    }

    fun want(topics: List<String>?) {
        wanted = merged(wanted, if (topics == null) Wanted.ALL else Wanted.of(topics))
        go()
    }

    /** What changed while nothing may run: read with the next run. */
    fun owe(topics: List<String>) {
        owing = merged(owing, Wanted.of(topics))
    }

    /** Nothing runs for now (the app off screen): what was asked for and hadn't run is owed. */
    fun shelve() {
        owing = merged(owing, wanted)
        wanted = null
        waiting?.invoke()
        waiting = null
    }

    fun cancel() {
        wanted = null
        owing = null
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
        var since: Long = NEVER
    }

    private val all = LinkedHashSet<Follower>()
    private var mode = "off"
    /** How many times the stream has come up. */
    private var ups = 0

    /**
     * `run` when one of these topics changes while the stream is up (and once when it comes up, if what it shows was read
     * before); at once and then every `everyMs` while it is down (null: once, and it keeps its own time from there); never
     * while the app is off screen. Not now: it is read when the stream comes up (or goes down), unless `readNow` says its
     * owner has just read it. Returns how to stop following.
     */
    fun follow(topics: List<String>, everyMs: Long?, gapMs: Long = Live.GAP_MS, readNow: Boolean = false, run: FollowerRun): () -> Unit {
        val follower = Follower(topics.toSet(), everyMs)
        val read = if (readNow) now() else NEVER
        follower.since = read
        follower.pace = Paced({ changed, done ->
            follower.since = now()
            val ups = this.ups
            run(changed) { ok ->
                // Up again while it read, so nothing else will read it: it reads once more (once: a second failure is owed).
                if (!ok && mode == "up" && this.ups != ups) follower.pace.want(changed)
                done(ok)
            }
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

    /**
     * The stream is up, since `at`. Fresh ([changed] null): each that last read before then runs once now. Resumed: only
     * those of whose topics something changed since, those that never read, and those owed a run. Then each runs when its
     * topics change.
     */
    fun up(at: Long, changed: List<String>? = null) {
        ups += 1
        mode = "up"
        for (follower in all.toList()) {
            follower.timer?.invoke()
            follower.timer = null
            if (changed == null) {
                if (follower.since < at) follower.pace.want(null)
                else if (follower.pace.owed) follower.pace.want(emptyList())
                continue
            }
            val mine = changed.filter { it in follower.topics }
            if (follower.since == NEVER) follower.pace.want(null)
            else if (mine.isNotEmpty() || follower.pace.owed) follower.pace.want(mine)
        }
    }

    /** These changed: each that follows one of them runs (while the app is off screen, it is owed a run instead). */
    fun changed(topics: List<String>) {
        if (mode == "down") return
        for (follower in all.toList()) {
            val mine = topics.filter { it in follower.topics }
            if (mine.isEmpty()) continue
            if (mode == "up") follower.pace.want(mine) else follower.pace.owe(mine)
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

    /** Nothing runs: the app is off screen. What was asked for and hadn't run is owed. */
    fun off() {
        mode = "off"
        for (follower in all.toList()) {
            follower.timer?.invoke()
            follower.timer = null
            follower.pace.shelve()
        }
    }

    private companion object {
        /** A follower's last read, never. */
        const val NEVER = Long.MIN_VALUE / 2
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
    read: suspend (since: String?, opened: (close: () -> Unit) -> Unit, alive: () -> Unit, event: (Json) -> Unit) -> Unit,
): LiveOpen = { since, alive, event, ended ->
    val closeIt = AtomicReference<(() -> Unit)?>(null)
    val closed = AtomicBoolean(false)
    val told = AtomicBoolean(false)
    val end = { why: Throwable? -> if (told.compareAndSet(false, true)) post { ended(why) } }
    val job = scope.launch(io) {
        try {
            read(
                since,
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
