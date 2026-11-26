package sh.invincible.bot.core

/**
 * A notification's payload, as the node sends it to this phone (through UnifiedPush, or kept for it to collect), read as
 * strictly as core's readNotifyPayload reads it (notify-payload.ts; the web app's service worker reads it the same way):
 * exactly its fields, bounded, nothing hidden in its words. Anything else is no payload of ours, and is shown only as
 * [GENERIC]: never as what it says, and never as nothing. And where a tap opens (Nav's own address: the very task, the
 * chat, the Inbox), and whether it is about what the app shows now (then it is told quietly: no sound, no pop-up, as the
 * iPhone shows such a one only in the list).
 */
object NotifyPayload {
    /** A payload of ours. [ship]: the task's work can be shipped from the notification; [action]: an approval's, for its buttons. */
    data class Notice(
        val kind: String,
        val title: String,
        val body: String,
        val open: String,
        val conversation: String?,
        val task: String?,
        val ship: Boolean,
        val tag: String,
        val action: String?,
        val approvable: Boolean,
    )

    const val TITLE_MAX = 60
    const val BODY_MAX = 140
    private val KINDS = setOf("needs-you", "approval", "finished", "question", "told", "summary", "limit", "test")
    private val OPENS = setOf("inbox", "chat", "overview", "settings", "task")
    private val FIELDS = setOf("v", "kind", "title", "body", "open", "conversation", "task", "ship", "tag", "action", "approvable")
    private val CONVERSATION = Regex("^cv_[A-Za-z0-9_-]{22}$")
    private val TASK = Regex("^task-[a-z0-9_-]{12}$")
    private val ACTION = Regex("^a_[A-Za-z0-9_-]{22}$")
    private val TAG = Regex("^[A-Za-z0-9._:-]{1,64}$")

    /** What's shown when a push can't be read as one of ours (core's GENERIC_NOTIFICATION). */
    val GENERIC = Notice("needs-you", "Invincible", "Something needs you. Open the app to see it.", "inbox", null, null, false, "primary", null, false)

    /** Control characters, bidirectional overrides and isolates, zero-width characters: nothing a lock screen should act on. */
    private fun hidden(c: Char): Boolean = c <= '\u001F' || c in '\u007F'..'\u009F' || c in '​'..'‏' || c in '‪'..'‮' || c in '⁠'..'⁩' || c == '﻿'

    /** JavaScript's white space and line ends (what its `\s` and `trim()` take). */
    private fun space(c: Char): Boolean = c == '\t' || c == '\n' || c == '\u000B' || c == '\u000C' || c == '\r' || c == ' ' || c == ' ' || c == ' ' || c in ' '..' ' || c == ' ' || c == ' ' || c == ' ' || c == ' ' || c == '　' || c == '﻿'

    /** Text as a notification may carry it: one line, nothing hidden, cut to [max] (core's notifyClean). */
    fun clean(text: String, max: Int): String {
        val out = StringBuilder(text.length)
        var gap = false
        for (raw in text) {
            val c = if (hidden(raw)) ' ' else raw
            if (space(c)) gap = true
            else {
                if (gap && out.isNotEmpty()) out.append(' ')
                gap = false
                out.append(c)
            }
        }
        val line = out.toString()
        return if (line.length > max) line.substring(0, max - 1).trimEnd(::space) + "…" else line
    }

    /** A payload read strictly: exactly the fields above, bounded, nothing hidden in the text. Anything else is null. */
    fun read(raw: Json?): Notice? {
        val p = raw as? Json.Obj ?: return null
        if (p.fields.keys.any { it !in FIELDS }) return null
        if (p["v"].double != 1.0) return null
        val kind = p["kind"].string?.takeIf { it in KINDS } ?: return null
        val title = p["title"].string ?: return null
        val body = p["body"].string ?: return null
        val tag = p["tag"].string?.takeIf(TAG::matches) ?: return null
        val open = p["open"].string?.takeIf { it in OPENS } ?: return null
        val conversation = p["conversation"]
        if (conversation != null && (conversation.string?.let(CONVERSATION::matches) != true || open != "chat")) return null
        val task = p["task"]
        if (task != null && (task.string?.let(TASK::matches) != true || open != "task")) return null
        val ship = p["ship"]
        if (ship != null && (ship !is Json.Bool || task == null)) return null
        val action = p["action"]
        if (action != null && (action.string?.let(ACTION::matches) != true || kind != "approval")) return null
        val approvable = p["approvable"]
        if (approvable != null && (approvable !is Json.Bool || action == null)) return null
        if (title.isEmpty() || clean(title, TITLE_MAX) != title || clean(body, BODY_MAX) != body) return null
        return Notice(kind, title, body, open, conversation.string, task.string, ship.bool == true, tag, action.string, approvable.bool == true)
    }

    /** Where a tap opens, as Nav's address: the very task, the chat (the kept one is opened by its id), the Inbox, Settings;
     * the Overview (the web's) is Home here, where the work is. */
    fun address(n: Notice): String = addressOf(n.open, n.task)

    /** The same, from what a notification's intent carries (its place, and the task it names): anything else is Home. */
    fun addressOf(open: String?, task: String?): String = when (open) {
        "task" -> task?.takeIf(::isTaskId)?.let { "task:$it" } ?: "home"
        "chat" -> "chat"
        "inbox" -> "inbox"
        "settings" -> "settings"
        else -> "home"
    }

    fun isTaskId(id: String): Boolean = TASK.matches(id)
    fun isConversationId(id: String): Boolean = CONVERSATION.matches(id)
    fun isActionId(id: String): Boolean = ACTION.matches(id)
    fun isTag(tag: String): Boolean = TAG.matches(tag)

    /** Whether the page the app shows ([showing]: Nav's address, while the app is in front) is the very thing a notification
     * is about: a task's end on its own thread, an ask on the Inbox. A test always shows: it's what you asked to see. */
    fun aboutWhatShows(n: Notice, showing: String?): Boolean = when (n.open) {
        "task" -> n.task != null && showing == "task:${n.task}"
        "inbox" -> showing == "inbox"
        else -> false
    }
}
