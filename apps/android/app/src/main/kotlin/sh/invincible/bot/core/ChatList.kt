package sh.invincible.bot.core

import java.time.Instant
import java.time.ZoneId

/**
 * Your kept chats as the web lists them: grouped by day (apps/web/src/lib/chats.ts groupConversations), found by your
 * words (filterConversations), and each one's state in words with its badge's tone (packages/core/src/turns.ts
 * chatStateWords, the PWA's stateBadge): ChatListVectorsTest holds them to the vectors' `chats`. A chat is the node's
 * summary of it, as /api/conversations gives it.
 */
object ChatList {
    private const val DAY = 24 * 60 * 60_000L

    data class Group(val label: String, val items: List<Json>)

    /**
     * By local midnight, the latest first: Pinned (a pin, whenever), Today, Yesterday, This week (six days back), Earlier;
     * a group with none left out.
     */
    fun groups(list: List<Json>, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<Group> {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
        val labels = listOf("Pinned", "Today", "Yesterday", "This week", "Earlier")
        val items = labels.map { mutableListOf<Json>() }
        for (c in list.sortedByDescending { it["updatedAt"].long ?: 0 }) {
            val at = c["updatedAt"].long ?: 0
            items[if (c["pinned"].bool == true) 0 else if (at >= today) 1 else if (at >= today - DAY) 2 else if (at >= today - 6 * DAY) 3 else 4] += c
        }
        return labels.zip(items).filter { it.second.isNotEmpty() }.map { (label, chats) -> Group(label, chats) }
    }

    /** Every word of [query] in a chat's title or its project (any case); none, all of them. */
    fun filter(list: List<Json>, query: String): List<Json> {
        val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return list
        return list.filter { c ->
            val text = "${c["title"].string ?: ""} ${c["project"].string ?: ""}".lowercase()
            words.all { text.contains(it) }
        }
    }

    /** Why messages queued behind a turn are held, in words. */
    private fun holdWords(held: String): String = when (held) {
        "stopped" -> "you stopped it"
        "error" -> "the turn before them failed"
        "restart" -> "the node restarted"
        else -> "the device that queued the next one is no longer paired, or may not see this chat"
    }

    private fun count(n: Int, one: String, many: String) = if (n == 1) one else "$n $many"

    /** What a chat needs from you, in a few words ("an approval", "2 approvals and a key", "an answer"). */
    private fun needsWords(needs: Json): String {
        val approvals = needs["approvals"].int ?: 0
        val keys = needs["keys"].int ?: 0
        return listOf(
            if (approvals > 0) count(approvals, "an approval", "approvals") else "",
            if (keys > 0) count(keys, "a key", "keys") else "",
            if (needs["question"].bool == true && approvals == 0 && keys == 0) "an answer" else "",
        ).filter { it.isNotEmpty() }.joinToString(" and ")
    }

    /** A chat's state in words, for a list ("" when there's nothing to say: it's done). */
    fun stateWords(c: Json): String {
        val n = c["queued"].int ?: 0
        val held = c["held"].string
        val queued = if (n > 0) "$n queued${held?.let { ", held (${holdWords(it)})" } ?: ""}" else ""
        return when (c["state"].string) {
            "working" -> if (queued.isNotEmpty()) "Working · $queued" else "Working"
            "waiting" -> "Needs you: ${c["needs"]?.takeIf { it is Json.Obj }?.let(::needsWords) ?: "a look"}${if (queued.isNotEmpty()) " · $queued" else ""}"
            "queued" -> queued.replaceFirstChar { it.uppercase() }
            "stopped" -> "Stopped"
            "failed" -> "Failed"
            else -> ""
        }
    }

    enum class Tone { ACCENT, WARN, DANGER, INFO, NEUTRAL }

    /** A chat's badge in a list: its state in words and their tone, a working chat's with its dot. */
    data class Badge(val text: String, val tone: Tone, val live: Boolean)

    /** Its badge, where there is something to say (the PWA's stateBadge): none for a chat that is simply done. */
    fun badge(c: Json): Badge? {
        val text = stateWords(c).takeIf { it.isNotEmpty() } ?: return null
        val tone = when (c["state"].string) {
            "working" -> Tone.ACCENT
            "waiting" -> Tone.WARN
            "failed" -> Tone.DANGER
            "queued" -> if (c["held"].string != null) Tone.WARN else Tone.INFO
            else -> Tone.NEUTRAL
        }
        return Badge(text, tone, live = c["state"].string == "working")
    }
}
