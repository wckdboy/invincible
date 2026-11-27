package sh.invincible.bot.core

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * A session with the node this phone is paired with, and its proof of which node it is (NodeProof): whoami, asked with a
 * fresh challenge, judged against the node pinned ([pin]). Held to the rules the review of apps-name-node set (27
 * November 2026), which core and the Apple app hold too:
 * 1. A new session proves first: nothing but whoami is signed (NodePin's gate) until its proof holds for the pinned node,
 *    not its reads, its stream, its posts nor a notification's answer. A proof that fails, or names another node, is
 *    "not your node" ([refused]), and nothing more is sent, not even whoami, until Try again. A whoami that gets no
 *    answer proves nothing: everything else is held, and it is asked again after a pause.
 * 2. Try again keeps the refusal while it asks, and lifts it only on a proof that holds; then the stream opens again
 *    ([reopen]).
 * 3. Once a node is pinned, no proof is a failed one (NodeProof.judge): a node that leaves it out is refused.
 * 4. With no node pinned yet, after the cutoff (NodeProof.NAMED_FROM) it proves first, pins, then signs for the node, and
 *    a node that gives no proof is refused; before the cutoff, a node from before (one that answers without a proof) is
 *    spoken to as before. A whoami that gets no answer holds everything, pinned or not (rule 1; K1 of the re-check).
 * 5. A late proof never writes over a newer pairing: the node it pins is kept with the pairing ([keep]) only while that
 *    pairing is still this phone's ([isCurrent]).
 * 6. The proof is judged off the caller's thread ([judging]: AppModel's is the main one), and nothing is taken from the
 *    node, not even its primary's name ([named]), before it holds.
 *
 * Kept apart from AppModel, which needs an Android Context, so that the JVM tests hold it to these rules.
 */
class NodeSession(
    val pin: NodePin,
    private val ask: suspend (challenge: String) -> Json,
    private val keep: (node: String) -> Unit,
    private val named: (String?) -> Unit,
    private val refused: (NodeError) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val judging: CoroutineContext = Dispatchers.Default,
    private val reopen: () -> Unit = {},
    private val isCurrent: () -> Boolean = { true },
    private val check: NodeProof.Checker = NodeProof.strict,
    /** The node refused this phone's whoami (a 401 or 403): said ([refusal]'s other half), though everything stays held. */
    private val trouble: (NodeError) -> Unit = {},
) {
    /** One whoami at a time: whoever asks meanwhile waits for its judgement. */
    private val asking = Mutex()

    /** Its proof held (or, none pinned, a node from before answered) this session. */
    @Volatile private var proven = false

    /** The last whoami asked held (a proof, or a node from before): the gate may stay open after one that doesn't. */
    @Volatile private var lastHeld = false

    /** When whoami, unanswered, may be asked again, and the pause after the next that goes unanswered. */
    private var retryAt = 0L
    private var pause = FIRST_PAUSE_MS

    /** The node's refusal of whoami last said ([trouble]): the same again, asked after each pause, isn't said again. */
    private var said: NodeError? = null

    /**
     * Whoami, proven, before anything else is sent; [fresh]: asked again though it held (the stream opening anew), so a
     * node that changed at the address since is found; [pastThePause]: asked now, though one went unanswered a moment ago
     * (Try again). False: nothing but whoami may be sent (refused, or not proven yet).
     */
    suspend fun prove(fresh: Boolean = false, pastThePause: Boolean = false): Boolean {
        pin.refused?.let { return refusedNow(it) }
        if (proven && !fresh) return true
        return asking.withLock {
            pin.refused?.let { return@withLock refusedNow(it) }
            if (proven && !fresh) return@withLock true
            // (Asked a moment ago and unanswered: the next whoami waits; nothing else goes meanwhile.)
            if (anew.getAndSet(false)) {
                retryAt = 0L
                pause = FIRST_PAUSE_MS
            }
            if (!pastThePause && now() < retryAt) return@withLock pin.isOpen
            val challenge = NodeProof.challenge()
            val who = try {
                ask(challenge)
            } catch (e: NodeError) {
                // No answer proves nothing, pinned or not (K1 of the re-check): all but whoami waits, asked again after a pause.
                retryAt = now() + pause
                pause = minOf(pause * 2, LONGEST_PAUSE_MS)
                // A refusal is an answer, though: the node doesn't know this phone (or its clock is out). That is said, once.
                lastHeld = false
                if ((e.status == 401 || e.status == 403) && (said?.status != e.status || said?.message != e.message)) {
                    said = e
                    trouble(e)
                }
                return@withLock pin.isOpen
            }
            retryAt = 0L
            pause = FIRST_PAUSE_MS
            when (val said = judged(who, challenge)) {
                is NodeProof.Proven.Pin -> {
                    pinned(said.node)
                    held(who)
                }
                is NodeProof.Proven.Same, NodeProof.Proven.Older -> held(who)
                is NodeProof.Proven.Other -> notYours(NodeError.notYours(said.node))
                NodeProof.Proven.Failed -> notYours(NodeError.notYours(null))
            }
        }
    }

    /**
     * The phone moved to another network (AppModel.moved): the next whoami is asked at once, past any pause, and its pauses
     * start again from the first. A new network is a fresh chance; waiting out the old one's pause only delays live data
     * (the lead's word, 27 November 2026).
     */
    fun newNetwork() = anew.set(true)

    /** Another network came since the last whoami (newNetwork): taken by the next, under [asking]. */
    private val anew = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Try again: whoami asked at once, past any pause an unanswered one set (K2 of the re-check). At a node refused, asked
     * past the refusal, which stands while it is out and after any answer but a proof that holds; one that holds lifts it,
     * and the stream opens again ([reopen]).
     */
    suspend fun tryAgain(): Boolean {
        if (pin.refused == null) return prove(fresh = true, pastThePause = true)
        return asking.withLock {
            val challenge = NodeProof.challenge()
            val who = try {
                ask(challenge)
            } catch (e: NodeError) {
                return@withLock false
            }
            when (val said = judged(who, challenge)) {
                is NodeProof.Proven.Pin, is NodeProof.Proven.Same -> {
                    if (said is NodeProof.Proven.Pin) pinned(said.node)
                    pin.clear()
                    held(who)
                    reopen()
                    true
                }
                is NodeProof.Proven.Other -> notYours(NodeError.notYours(said.node))
                // (No proof at all is no proof that holds: the refusal stands as it was.)
                NodeProof.Proven.Older -> refusedNow(pin.refused ?: NodeError.notYours(null))
                NodeProof.Proven.Failed -> notYours(NodeError.notYours(null))
            }
        }
    }

    /**
     * [c]'s GET of [path] once this session's proof holds, waiting for whoami while it is out: what the app asks as it
     * comes to the front (AppModel.inFront). Asked before the proof, at every cold start beside the stream's first whoami,
     * it was refused as unproven and dropped, and the notification handover, take-downs and collection with it (K3 of the
     * re-check of 27 November 2026). Null: refused, nothing proven, or no answer.
     */
    suspend fun read(c: NodeClient, path: String): Json? = if (c.pin === pin && prove()) runCatching { c.get(path) }.getOrNull() else null

    /**
     * A refusal (401) of anything but whoami ([e]), judged by asking whoami again, fresh and at once. Its proof holding, the
     * node knows this phone and takes how it signs whoami, so what it refused is how this build signs the rest, for a node
     * newer than the build: said as [NodeError.outdated], an update the way out. Whoami refused too, the node no longer
     * knows this phone: [e], said as it was. A phone whose clock is out by a minute or more is that, not this.
     */
    suspend fun refusal(e: NodeError): NodeError {
        if (e.status != 401 || e.serverTime?.let { kotlin.math.abs(now() - it) >= 60_000L } == true) return e
        pin.refused?.let { return it }
        prove(fresh = true, pastThePause = true)
        pin.refused?.let { return it }
        return if (lastHeld) NodeError(401, e.message ?: "", e.serverTime, outdated = true) else e
    }

    /** Whoami's answer judged where [judging] says: never on the thread that asked (AppModel's is the main one). */
    private suspend fun judged(who: Json, challenge: String): NodeProof.Proven = withContext(judging) { NodeProof.judge(pin.node, who, challenge, now = now(), check = check) }

    /** A first proof: this session's client names the node from now on; its pairing keeps it, if still this phone's. */
    private fun pinned(node: String) {
        pin.pin(node)
        if (isCurrent()) keep(node)
    }

    /** Its proof held: what the node said may be taken, and what isn't whoami may be sent. */
    private fun held(who: Json): Boolean {
        proven = true
        said = null
        lastHeld = true
        pin.open()
        named(who["primaryName"].string)
        return true
    }

    /** The node at this address isn't this phone's: said, and nothing more is sent there. */
    private fun notYours(why: NodeError): Boolean {
        proven = false
        lastHeld = false
        pin.refuse(why)
        refused(why)
        return false
    }

    private fun refusedNow(why: NodeError): Boolean {
        refused(why)
        return false
    }

    private companion object {
        /** The pause before an unanswered whoami is asked again, doubled each time it goes unanswered, to a minute. */
        const val FIRST_PAUSE_MS = 2_000L
        const val LONGEST_PAUSE_MS = 60_000L
    }
}

/**
 * What the reach banner says of the link ([online]: null, nothing to say) while this phone's node is refused
 * ([refused]): nothing. The refusal says what's wrong; "Can't reach Invincible right now" beside it said otherwise (the
 * lead's word, 27 November 2026).
 */
fun reachShown(online: Boolean?, refused: Boolean): Boolean? = if (refused) null else online

/**
 * The refusal a screen says at its head, of what went wrong last ([problem]): "not your node", a proof that failed
 * included, and a node that refuses this phone outright (401: removed there, its clock out, or this build outdated). The
 * chat, where the app opens, says it above the conversation, as Work and the agents do at their heads, with the way out;
 * the reach banner keeps quiet only while it is said (the lead's word, 27 November 2026).
 */
fun refusalShown(problem: NodeError?): NodeError? = problem?.takeIf { it.notYourNode != null || it.status == 401 }

/**
 * The line over what this phone kept from its node ([ago]: how long since the node said it). While the node is refused
 * ([refused]) it ends there: nothing is asked of a refused node (rule 1), and "Asking it again" said otherwise (the
 * lead's word, 27 November 2026).
 */
fun keptLine(ago: CharSequence, refused: Boolean): String = "As your node last said it, $ago." + if (refused) "" else " Asking it again."
