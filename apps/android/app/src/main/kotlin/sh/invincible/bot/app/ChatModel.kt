package sh.invincible.bot.app

import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import sh.invincible.bot.core.Json
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

    private var watch: Job? = null
    private var turn: String? = null
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
        _live.value = false
    }

    suspend fun loadChats() {
        val c = app.client ?: return
        runCatching { c.get("/api/conversations")["conversations"].list }.onSuccess { _chats.value = it }
    }

    /** A new chat: nothing on screen until you write. */
    fun fresh() {
        leave()
        _conversation.value = null
        _title.value = null
        _bubbles.value = emptyList()
        _problem.value = null
    }

    /** A kept chat, as the node holds it, and its turn in it if it's still answering. */
    fun open(id: String) {
        leave()
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
        stream { c.events("/api/chat", body) }
    }

    private fun attachTo(turnId: String) {
        val c = app.client ?: return
        // (The node replays the turn from its start: its answer is shown as it stands, then goes on live.)
        val shown = _bubbles.value
        val last = shown.lastOrNull()
        _bubbles.value = if (last != null && !last.mine) shown.dropLast(1) + last.copy(text = "", status = "streaming", steps = emptyList()) else shown + Bubble("assistant", "", "streaming")
        stream { c.events("/api/turns/attach", Json.obj("turn" to turnId)) }
    }

    private fun stream(events: () -> kotlinx.coroutines.flow.Flow<Json>) {
        leave()
        _live.value = true
        _problem.value = null
        watch = app.launch {
            try {
                events().collect { e -> take(e) }
                finish("done")
            } catch (e: NodeError) {
                finish("failed", e.message)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                finish("failed", e.message)
            } finally {
                _live.value = false
                turn = null
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
        }
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
