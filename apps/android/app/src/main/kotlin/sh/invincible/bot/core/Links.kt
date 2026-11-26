package sh.invincible.bot.core

/**
 * An `invincible:` link (`invincible://task/<id>`, `/agent/<handle>`, `/approval/<id>`, `/chat/<id>`), as the app opens it,
 * over Home (the iPhone's Push.link): its exact place, by Nav's address, and nothing more. A link only navigates: no query
 * or fragment is read, so none can answer an approval or ship a task. Anything else is no link of these (an invite link is
 * the join's: Joining.handed). The ids are held to the same patterns a notification's are (NotifyPayload).
 */
object Links {
    /** Where a link opens: Nav's address, and for a chat its conversation, for an approval its card in the Inbox. */
    data class Place(val address: String, val conversation: String? = null, val approval: String? = null)

    private val AGENT = Regex("^[a-z][a-z0-9-]{0,31}$")
    private val LINK = Regex("^invincible://(task|agent|approval|chat)/([^/?#]+)$")

    fun of(link: String): Place? {
        val (kind, id) = LINK.matchEntire(link)?.destructured ?: return null
        return when (kind) {
            "task" -> if (NotifyPayload.isTaskId(id)) Place("task:$id") else null
            "agent" -> if (AGENT.matches(id)) Place("agent:$id") else null
            "approval" -> if (NotifyPayload.isActionId(id)) Place("inbox", approval = id) else null
            else -> if (NotifyPayload.isConversationId(id)) Place("chat", conversation = id) else null
        }
    }
}
