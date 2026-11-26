package sh.invincible.bot.core

/**
 * What the message box does while your agent works, and the words around it (the web's lib/turns.ts, the iPhone's
 * ComposerWords; ComposerVectorsTest holds them to the vectors' `composer`): what sending does, a side question typed
 * into it, and what waits above it.
 */
object Composer {
    /** What Return does while it works (steer unless chosen otherwise). */
    enum class Enter { STEER, QUEUE }

    enum class Action(val wire: String) { SEND("send"), STEER("steer"), QUEUE("queue") }

    /** What sending does: with nothing running it sends; while it works, Return does what was chosen and a modifier with it
     * the other; where nothing can be queued (a chat the node doesn't keep yet), both steer. */
    fun action(busy: Boolean, enter: Enter, modifier: Boolean, canQueue: Boolean): Action {
        if (!busy) return Action.SEND
        if (!canQueue) return Action.STEER
        val chosen = if (enter == Enter.STEER) Action.STEER else Action.QUEUE
        return if (modifier) (if (chosen == Action.STEER) Action.QUEUE else Action.STEER) else chosen
    }

    private val ASIDE = Regex("^\\s*/(?:btw|aside)(?:\\s+([\\s\\S]*))?$", RegexOption.IGNORE_CASE)

    /** A side question typed into the box ("/btw how long will this take?"), or null when it isn't one. */
    fun aside(text: String): String? {
        val found = ASIDE.matchEntire(text) ?: return null
        return (found.groups[1]?.value ?: "").trim()
    }

    /** The line over messages sent to steer it that haven't reached it yet. */
    fun steering(count: Int): String =
        "On ${if (count == 1) "its" else "their"} way to it: it's told at its next safe point (a tool that's running finishes first)"

    /** Why a queue is held (core's holdWords). */
    fun holdWords(held: String): String = when (held) {
        "stopped" -> "you stopped it"
        "error" -> "the turn before them failed"
        "restart" -> "the node restarted"
        else -> "the device that queued the next one is no longer paired, or may not see this chat"
    }

    /** The queue's head: how many, and what becomes of them; held, why, and that nothing goes until you resume. */
    fun queueHead(queued: Int, held: String?, busy: Boolean): Pair<String, String> {
        val count = "$queued ${if (queued == 1) "message" else "messages"}"
        if (held != null) return "$count held" to ": ${holdWords(held)}. Nothing is sent until you resume."
        return "$count queued" to if (busy) ": sent in order when it's done with this turn." else ": waiting for room on the node."
    }

    /** Messages of yours that hadn't reached it when its turn ended: queued first and held in a kept chat, back in the box
     * otherwise. */
    fun undelivered(texts: Int, queued: Boolean): Pair<String, String> =
        if (queued) "$texts ${if (texts == 1) "message" else "messages"} didn't reach it before the turn ended" to "Queued, first in line, and held until you resume."
        else "Your message didn't reach it before the turn ended" to "It's back in the message box."

    /** The message box while it works. */
    fun placeholder(canQueue: Boolean): String = if (canQueue) "Steer it, or queue what's next…" else "Steer it…"

    const val JUST_STARTING = "It's only just starting: try again in a moment."
    const val NOT_KEPT = "This chat isn't kept, so nothing is queued behind it."
    const val FILES_WAIT = "Files go with your next message, once it's done: wait for it, or stop it first."

    /** A side question's note: what it's answered from, and that it changes nothing unless brought back. */
    fun asideNote(working: Boolean): String =
        if (working) "Answered apart, from this chat and what it's said and done so far in this turn. It doesn't change what it's doing, and it never sees it unless you bring it back."
        else "Answered apart, from what this chat holds. It isn't added to the chat unless you bring it back."

    /** What Bring back did: steered the turn under way, or kept in the chat. */
    fun broughtBack(how: String): String = if (how == "steered") "Brought back: it reaches it at its next safe point" else "Brought back: it's in the chat now"

    fun asidePlaceholder(working: Boolean): String = if (working) "e.g. What is it waiting on?" else "e.g. Which file was that in?"

    const val ASIDE_ANSWERING = "Answering on the side…"
    const val ASIDE_FAILED = "It couldn't answer on the side"
    const val BRING_BACK_FAILED = "Couldn't bring it back"
    val NOTHING_YET = "Nothing to ask on the side yet" to "A side question is about a chat: ask something first."
}
