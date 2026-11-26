package sh.invincible.bot.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What is under way in a chat (core's `UnderwayView`, the PWA's lib/underway.ts): the tasks it gave agents from it that
 * haven't ended, and the looks it set itself there that wait. In words, word for word as the PWA and the Apple apps say it.
 */
data class UnderwayTask(val id: String, val title: String, val assignee: String, val name: String, val status: String, val progress: String, val room: String)

data class UnderwayLook(val id: String, val at: Long, val note: String)

data class Underway(val tasks: List<UnderwayTask> = emptyList(), val looks: List<UnderwayLook> = emptyList()) {
    val isEmpty: Boolean get() = tasks.isEmpty() && looks.isEmpty()

    companion object {
        /** The node's answer, read leniently: a row without what it needs is left out. */
        fun of(json: Json): Underway = Underway(
            tasks = json["tasks"].list.mapNotNull { t ->
                val id = t["id"].string ?: return@mapNotNull null
                val assignee = t["assignee"].string ?: return@mapNotNull null
                UnderwayTask(id, t["title"].string ?: "", assignee, t["name"].string ?: assignee, t["status"].string ?: "running", t["progress"].string ?: "", t["room"].string ?: "")
            },
            looks = json["looks"].list.mapNotNull { l ->
                val id = l["id"].string ?: return@mapNotNull null
                UnderwayLook(id, l["at"].long ?: return@mapNotNull null, l["note"].string ?: "")
            },
        )
    }
}

/** A look of its come back (a kept message's `look`): when it set it, and its note. Shown as its own, never as yours. */
data class LookNote(val set: Long, val note: String)

object UnderwayWords {
    private val clock = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)
    private val day = DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)

    /** A time as the row says it: "23:07" today, "Wed 25 Nov, 09:00" on another day. */
    fun whenWords(at: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        val then = Instant.ofEpochMilli(at).atZone(zone)
        val today = Instant.ofEpochMilli(now).atZone(zone)
        val time = clock.format(then)
        return if (then.toLocalDate() == today.toLocalDate()) time else "${day.format(then)}, $time"
    }

    /** How a task stands: its first line of progress, or at work; waiting its turn while queued. */
    fun state(task: UnderwayTask): String {
        if (task.status == "queued") return "waiting its turn"
        val first = task.progress.trim().lineSequence().firstOrNull().orEmpty()
        return if (first.isEmpty()) "at work" else first.take(80)
    }

    fun look(look: UnderwayLook, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String =
        "Looking again at ${whenWords(look.at, now, zone)}: ${look.note}"

    fun looked(look: LookNote, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String =
        "It looked again, as it said at ${whenWords(look.set, now, zone)} it would: ${look.note}"

    /**
     * How soon to ask the node again (the PWA's nextLookMs): soon while a task is under way or it is answering; just after
     * a look of its comes due, then soon until the node takes it (it is gone from the row then); else every half minute.
     */
    fun nextAskMs(shown: Underway, answering: Boolean, now: Long = System.currentTimeMillis()): Long {
        if (shown.tasks.isNotEmpty() || answering) return 5_000
        val soonest = shown.looks.minOfOrNull { it.at } ?: return 30_000
        return if (soonest <= now) 5_000 else minOf(30_000, soonest - now + 1_000)
    }
}
