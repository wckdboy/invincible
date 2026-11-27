package sh.invincible.bot.app

import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import sh.invincible.bot.core.Composer
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.Live
import sh.invincible.bot.core.LookNote
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.long
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string

/** One message on screen: yours, or its answer as it stands (its steps are what it did on the way). */
data class Bubble(
    val role: String,
    val text: String,
    val status: String = "done",
    val model: String? = null,
    val steps: List<String> = emptyList(),
    val error: String? = null,
    /** The files a message of yours carried, by name. */
    val files: List<String> = emptyList(),
    /** A look of its come back: a "user" message that isn't yours, shown as its own note. */
    val look: LookNote? = null,
) {
    val mine: Boolean get() = role == "user" && look == null
    val streaming: Boolean get() = status == "streaming"
}

/**
 * Your conversation with the primary, as this app shows it. A chat is kept on the node: opening one shows what it holds,
 * and when it is still answering in it, the app attaches to its turn, which the node replays from its start and then
 * streams live. Leaving a chat ends the watching, never the turn; Stop asks the node to stop it.
 */
/** The chat the app opens on, of your kept chats (the latest first, as the node lists them): the latest; none, the welcome. */
internal fun latestKept(chats: List<Json>): String? = chats.firstNotNullOfOrNull { it["id"].string }

class ChatModel(private val app: AppModel) {
    private val _conversation = MutableStateFlow<String?>(null)
    /** The kept chat on screen (null: a new one, until the node keeps it). */
    val conversation: StateFlow<String?> = _conversation.asStateFlow()

    private val _title = MutableStateFlow<String?>(null)
    val title: StateFlow<String?> = _title.asStateFlow()

    private val _bubbles = MutableStateFlow<List<Bubble>>(emptyList())
    val bubbles: StateFlow<List<Bubble>> = _bubbles.asStateFlow()

    /** A turn of its is being watched here. */
    private val _live = MutableStateFlow(false)
    val live: StateFlow<Boolean> = _live.asStateFlow()

    private val _problem = MutableStateFlow<String?>(null)
    val problem: StateFlow<String?> = _problem.asStateFlow()

    /** Your kept chats, the latest first, when the list was last asked for. */
    private val _chats = MutableStateFlow<List<Json>>(emptyList())
    val chats: StateFlow<List<Json>> = _chats.asStateFlow()

    // ---- while it works: steered, queued, asked on the side (the web's lib/turns.ts and chat-queue.ts) ----

    /** A message of yours queued behind this chat on the node: its id there, its words, the device it came from. */
    data class Queued(val id: Long, val text: String, val by: String?)

    private val _queue = MutableStateFlow<List<Queued>>(emptyList())
    /** What you queued behind this chat, as the node holds it, and why it is held when it is (core's QueueHold). */
    val queue: StateFlow<List<Queued>> = _queue.asStateFlow()
    private val _held = MutableStateFlow<String?>(null)
    val held: StateFlow<String?> = _held.asStateFlow()

    private val _steering = MutableStateFlow<List<String>>(emptyList())
    /** Messages sent to steer it that haven't reached it yet. */
    val steering: StateFlow<List<String>> = _steering.asStateFlow()

    private val _notice = MutableStateFlow<Pair<String, String>?>(null)
    /** What became of something you sent while it worked, or why a change didn't go: a title and its words. */
    val notice: StateFlow<Pair<String, String>?> = _notice.asStateFlow()

    private val _returned = MutableStateFlow<String?>(null)
    /** Words that go back into the message box (they didn't reach it, or weren't sent). */
    val returned: StateFlow<String?> = _returned.asStateFlow()

    /** A side question, answered apart: its question, its answer as it comes, its id once the node named it. */
    data class Aside(val question: String, val answer: String = "", val id: String? = null, val asking: Boolean = true, val problem: String? = null)

    private val _aside = MutableStateFlow<Aside?>(null)
    val aside: StateFlow<Aside?> = _aside.asStateFlow()

    /** A message can be queued behind this chat: the node keeps it (a new chat, once its first answer is kept). */
    val canQueue: Boolean get() = _conversation.value != null

    fun dismissNotice() {
        _notice.value = null
    }

    fun returnedTaken() {
        _returned.value = null
    }

    private fun readQueue(view: Json?) {
        _queue.value = view["queue"].list.mapNotNull { q -> q["id"].long?.let { Queued(it, q["text"].string ?: "", q["by"].string) } }
        _held.value = view["held"].string
    }

    private fun forgetQueue() {
        _queue.value = emptyList()
        _held.value = null
        _steering.value = emptyList()
        _notice.value = null
    }

    private var watch: Job? = null
    /** How the stream watched now is taken for dead at once (null: none is watched). */
    private var quiet: (() -> Unit)? = null
    private var turn: String? = null

    /** The node's beat, as its live stream's hello said (an older node's until one has): a turn's stream beats with it. */
    var beat: Long = Live.OLDER_BEAT_MS
    private var seenChats: String? = null

    fun reset() {
        leave()
        _conversation.value = null
        _title.value = null
        _bubbles.value = emptyList()
        _problem.value = null
        _chats.value = emptyList()
    }

    private fun leave() {
        watch?.cancel()
        watch = null
        quiet = null
        _live.value = false
    }

    /** The node's live stream went silent, or the network changed under it: the turn's stream went the same way. */
    fun linkLost() {
        quiet?.invoke()
    }

    suspend fun loadChats() {
        val c = app.client ?: return
        runCatching { c.get("/api/conversations")["conversations"].list }.onSuccess { _chats.value = it }
    }

    private val _opening = MutableStateFlow(false)
    /** The latest kept chat being read as the app opens on it: the chat says so meanwhile, never its welcome first. */
    val opening: StateFlow<Boolean> = _opening.asStateFlow()
    private var openedOnce = false

    /**
     * As the app opens on the chat (once a session): your latest kept chat, asked for once the node has proved itself;
     * a chat already on screen (a notification's, one shared to the app) stays. None kept, the welcome.
     */
    fun openLatest() {
        if (openedOnce) return
        openedOnce = true
        if (_conversation.value != null || _bubbles.value.isNotEmpty()) return
        _opening.value = true
        app.launch {
            try {
                val c = app.provenClient() ?: return@launch
                val kept = runCatching { c.get("/api/conversations")["conversations"].list }.getOrNull() ?: return@launch
                _chats.value = kept
                val id = latestKept(kept) ?: return@launch
                if (_conversation.value != null || _bubbles.value.isNotEmpty()) return@launch
                _conversation.value = id
                _problem.value = null
                read(id, attach = true)
            } finally {
                _opening.value = false
            }
        }
    }

    /** A new chat: nothing on screen until you write. */
    fun fresh() {
        leave()
        forgetQueue()
        _conversation.value = null
        _title.value = null
        _bubbles.value = emptyList()
        _problem.value = null
    }

    /** A kept chat, as the node holds it, and its turn in it if it's still answering. */
    fun open(id: String) {
        leave()
        forgetQueue()
        _conversation.value = id
        _problem.value = null
        app.launch { read(id, attach = true) }
    }

    private suspend fun read(id: String, attach: Boolean) {
        val c = app.client ?: return
        try {
            val view = c.post("/api/conversations/get", Json.obj("id" to id))["conversation"]
            if (_conversation.value != id) return
            _title.value = view["title"].string
            _bubbles.value = view["messages"].list.map { m ->
                Bubble(
                    role = m["role"].string ?: "assistant",
                    text = m["content"].string ?: "",
                    status = m["status"].string ?: "done",
                    model = m["model"].string,
                    steps = m["steps"].list.mapNotNull { s -> if (s["kind"].string == "tool") s["title"].string ?: s["name"].string else null },
                    error = m["error"].string,
                    files = m["attachments"].list.mapNotNull { it["name"].string },
                    look = m["look"].let { l -> l["note"].string?.let { LookNote(l["set"].long ?: 0L, it) } },
                )
            }
            readQueue(view)
            if (view["unread"].bool == true) runCatching { c.post("/api/conversations/seen", Json.obj("id" to id)) }
            val running = view["turn"]
            if (attach && running != null && running != Json.Null && running["watchable"].bool != false) {
                running["id"].string?.let { attachTo(it) }
            }
        } catch (e: NodeError) {
            _problem.value = e.message
        }
    }

    /**
     * What you wrote, with the files kept on the node for it ([attachments]: their references), sent: a new chat is kept
     * from its first message; a kept one goes on (the node holds what was said).
     */
    fun send(text: String, attachments: List<Json> = emptyList()) {
        val words = text.trim()
        val c = app.client ?: return
        if ((words.isEmpty() && attachments.isEmpty()) || _live.value) return
        val names = attachments.mapNotNull { it["name"].string }
        _bubbles.value = _bubbles.value + Bubble("user", words, files = names) + Bubble("assistant", "", "streaming")
        val id = _conversation.value
        val body = Json.obj(
            "role" to "planner",
            "save" to (if (id == null) true else null),
            "conversation" to id,
            "messages" to listOf(mapOf("role" to "user", "content" to words, "attachments" to attachments.ifEmpty { null })),
        )
        stream { alive -> c.events("/api/chat", body, alive) }
    }

    private fun attachTo(turnId: String) {
        val c = app.client ?: return
        // (The node replays the turn from its start: its answer is shown as it stands, then goes on live.)
        val shown = _bubbles.value
        val last = shown.lastOrNull()
        _bubbles.value = if (last != null && !last.mine) shown.dropLast(1) + last.copy(text = "", status = "streaming", steps = emptyList()) else shown + Bubble("assistant", "", "streaming")
        stream { alive -> c.events("/api/turns/attach", Json.obj("turn" to turnId), alive) }
    }

    /**
     * Watches a turn's stream. It beats as the node's live stream does: silent for three of the node's beats (`beat`), or
     * when the live stream is lost or the network changes under it, it is gone (a half-open link, a node gone from the
     * network), and the turn is attached to again, which replays it from its start; with no turn to attach to yet, it says so.
     */
    private fun stream(events: (alive: () -> Unit) -> kotlinx.coroutines.flow.Flow<Json>) {
        leave()
        _live.value = true
        _problem.value = null
        val heard = java.util.concurrent.atomic.AtomicLong(android.os.SystemClock.elapsedRealtime())
        lateinit var collecting: Job
        collecting = app.launch {
            try {
                events { heard.set(android.os.SystemClock.elapsedRealtime()) }.collect { e -> take(e) }
                finish("done")
            } catch (e: NodeError) {
                finish("failed", e.message)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                finish("failed", e.message)
            } finally {
                // (Only while it is still the one watched: one taken for dead is replaced before it finishes.)
                if (watch === collecting) {
                    _live.value = false
                    turn = null
                    _steering.value = emptyList()
                    // How it ended may have held what's queued, or sent the next of it: the queue as the node holds it now.
                    app.launch { rereadQueue() }
                }
            }
        }
        watch = collecting
        val dead = {
            if (collecting.isActive && watch === collecting) {
                val again = turn
                collecting.cancel()
                quiet = null
                if (again != null) attachTo(again) else {
                    watch = null
                    _live.value = false
                    finish("failed", "Its answer stopped coming: the link to the node went quiet. Open the chat again to read it.")
                }
            }
        }
        quiet = dead
        app.launch {
            while (collecting.isActive && watch === collecting) {
                kotlinx.coroutines.delay(Live.BEAT_MS)
                if (android.os.SystemClock.elapsedRealtime() - heard.get() > 3 * beat) {
                    dead()
                    break
                }
            }
        }
    }

    private fun answer(change: (Bubble) -> Bubble) {
        val shown = _bubbles.value
        val last = shown.lastOrNull() ?: return
        if (last.mine) return
        _bubbles.value = shown.dropLast(1) + change(last)
    }

    private fun finish(status: String, error: String? = null) {
        answer { if (it.streaming) it.copy(status = status, error = error ?: it.error) else it }
        if (error != null) _problem.value = error
    }

    /** One event of its answer (core's ChatStreamEvent); one this app doesn't read passes by. */
    private fun take(e: Json) {
        when (e["type"].string) {
            "turn" -> {
                turn = e["id"].string
                e["conversation"].string?.let { _conversation.value = it }
            }
            "conversation" -> {
                _conversation.value = e["id"].string ?: _conversation.value
                _title.value = e["title"].string ?: _title.value
            }
            "model" -> answer { it.copy(model = e["ref"].string) }
            "text" -> answer { it.copy(text = it.text + (e["text"].string ?: "")) }
            "tool" -> answer { it.copy(steps = it.steps + (e["title"].string ?: e["name"].string ?: "a tool")) }
            "fallback" -> answer { it.copy(steps = it.steps + "${e["from"].string} couldn't answer: the next model did") }
            "stopped" -> finish("stopped", if (e["reason"].string == "you") null else "Stopped (${e["reason"].string})")
            "error" -> finish("failed", e["error"].string ?: "It couldn't answer.")
            "done" -> finish("done")
            // A steer of yours reached it: no longer on its way.
            "steer" -> e["text"].string?.let { t -> _steering.value = _steering.value.toMutableList().also { it.remove(t) } }
            // Messages of yours that hadn't reached it when its turn ended: queued first and held, or back in the box.
            "undelivered" -> {
                val texts = e["texts"].list.mapNotNull { it.string }
                val queued = e["queued"].bool == true
                _steering.value = emptyList()
                _notice.value = Composer.undelivered(texts.size, queued)
                if (!queued && texts.isNotEmpty()) _returned.value = texts.joinToString("\n\n")
            }
        }
    }

    /** The queue behind the chat on screen, as the node holds it now (its next may have begun: attached to then). */
    private suspend fun rereadQueue() {
        val id = _conversation.value ?: return
        val c = app.client ?: return
        val view = runCatching { c.post("/api/conversations/get", Json.obj("id" to id))["conversation"] }.getOrNull() ?: return
        if (_conversation.value != id) return
        readQueue(view)
        val running = view["turn"]
        if (!_live.value && running != null && running != Json.Null && running["watchable"].bool != false) running["id"].string?.let { attachTo(it) }
    }

    /**
     * What's in the box while it works: steered into the turn under way (it's told at its next safe point), or queued on
     * the node behind the chat (sent when it's done). A queue asked of a chat the node doesn't keep steers. True: it went
     * from the box (what didn't go comes back to it).
     */
    fun deliver(how: Composer.Action, text: String): Boolean {
        val words = text.trim()
        val c = app.client ?: return false
        if (words.isEmpty()) return false
        val action = if (how == Composer.Action.QUEUE && !canQueue) Composer.Action.STEER else how
        _notice.value = null
        app.launch {
            try {
                if (action == Composer.Action.QUEUE) {
                    val view = c.post("/api/conversations/queue", Json.obj("conversation" to _conversation.value, "text" to words, "role" to "planner"))
                    readQueue(view)
                    // It'd finished meanwhile, so its turn came at once: watched from here.
                    if (view["started"].let { it != null && it != Json.Null } && !_live.value) rereadQueue()
                } else {
                    val t = turn
                    if (t == null) {
                        _returned.value = words
                        _notice.value = "Not sent yet" to Composer.JUST_STARTING
                        return@launch
                    }
                    c.post("/api/turns/steer", Json.obj("turn" to t, "text" to words))
                    _steering.value = _steering.value + words
                }
            } catch (e: NodeError) {
                // It finished while you typed: it's simply your next message.
                if (e.status == 409 && action == Composer.Action.STEER && !_live.value) send(words)
                else {
                    _returned.value = words
                    _notice.value = "Not sent" to (e.message ?: "")
                }
            }
        }
        return true
    }

    /** A change to the queue (the web's queueActions): the queue as the node holds it after, or why it wasn't made. */
    private fun changeQueue(path: String, body: Json) {
        val c = app.client ?: return
        if (_conversation.value == null) {
            _notice.value = "Not changed" to Composer.NOT_KEPT
            return
        }
        app.launch {
            try {
                readQueue(c.post(path, body))
                // Send now and Resume may have started a turn (or steered the one under way).
                if (!_live.value) rereadQueue()
            } catch (e: NodeError) {
                _notice.value = "Not changed" to (e.message ?: "")
                rereadQueue()
            }
        }
    }

    fun editQueued(id: Long, text: String) = changeQueue("/api/conversations/queue/edit", Json.obj("conversation" to _conversation.value, "id" to id, "text" to text.trim()))
    fun removeQueued(id: Long) = changeQueue("/api/conversations/queue/remove", Json.obj("conversation" to _conversation.value, "id" to id))
    /** Everything queued behind this chat, discarded. */
    fun discardQueue() = changeQueue("/api/conversations/queue/remove", Json.obj("conversation" to _conversation.value))
    /** One queued message now: it steers the turn under way, or starts as a turn at once. */
    fun sendQueued(id: Long) = changeQueue("/api/conversations/queue/send", Json.obj("conversation" to _conversation.value, "id" to id))
    /** A held queue goes on. */
    fun resumeQueue() = changeQueue("/api/conversations/queue/resume", Json.obj("conversation" to _conversation.value))

    /**
     * A side question (the web's chat-aside.ts): answered apart, from what this chat holds and what its turn has said and
     * done so far, without its tools, and added to nothing unless brought back. About the kept chat, or the turn running in
     * a chat the node doesn't keep yet.
     */
    fun askAside(question: String) {
        val q = question.trim()
        val c = app.client ?: return
        val about = _conversation.value?.let { "conversation" to it } ?: turn?.let { "turn" to it }
        if (about == null) {
            _notice.value = Composer.NOTHING_YET
            return
        }
        if (q.isEmpty()) {
            _aside.value = Aside("", asking = false)
            return
        }
        _aside.value = Aside(q)
        app.launch {
            try {
                c.events("/api/turns/aside", Json.obj(about, "question" to q)).collect { e ->
                    val now = _aside.value ?: return@collect
                    when (e["type"].string) {
                        "aside" -> _aside.value = now.copy(id = e["id"].string)
                        "text" -> _aside.value = now.copy(answer = now.answer + (e["text"].string ?: ""))
                        "error" -> _aside.value = now.copy(problem = e["error"].string ?: Composer.ASIDE_FAILED)
                    }
                }
            } catch (e: NodeError) {
                _aside.value = _aside.value?.copy(problem = e.message ?: Composer.ASIDE_FAILED)
            } finally {
                _aside.value = _aside.value?.copy(asking = false)
            }
        }
    }

    /** The side question and its answer, brought back: the turn under way is steered with them, or they join the chat. */
    fun bringBack() {
        val c = app.client ?: return
        val id = _aside.value?.id ?: return
        app.launch {
            try {
                val how = c.post("/api/turns/aside/bring", Json.obj("aside" to id))["how"].string ?: "kept"
                _aside.value = null
                _notice.value = Composer.broughtBack(how) to ""
                if (!_live.value) _conversation.value?.let { read(it, attach = true) }
            } catch (e: NodeError) {
                _aside.value = _aside.value?.copy(problem = "${Composer.BRING_BACK_FAILED}: ${e.message}")
            }
        }
    }

    fun closeAside() {
        _aside.value = null
    }

    /** Stop its answer on the node (leaving the screen never does). */
    fun stop() {
        val c = app.client ?: return
        val id = turn ?: return
        app.launch { runCatching { c.post("/api/turns/stop", Json.obj("turn" to id)) } }
    }

    /** The node's chats moved (another device wrote, or it answered): the chat on screen is read again, unless watched. */
    suspend fun follow(chats: String?) {
        val changed = chats != null && seenChats != null && chats != seenChats
        if (chats != null) seenChats = chats
        val id = _conversation.value ?: return
        if (changed && !_live.value) read(id, attach = true)
    }
}
