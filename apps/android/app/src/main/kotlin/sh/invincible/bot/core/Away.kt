package sh.invincible.bot.core

/**
 * While you were away (the node's away.ts, PLAN #37): its lines as a fresh conversation shows them under its welcome. The
 * line that counts what needs your answer is left out where the conversation's head says that count already, live (the
 * primary's line, Roster.primaryNow, in its "warn" tone): the count is said once (the lead's note, 27 November 2026).
 */
object Away {
    private val waiting = Regex("^\\d+ (thing needs|things need) your answer\\.$")

    /** The node's [lines], less the count of what needs your answer where [countShown] (the head says it already). */
    fun shown(lines: List<Json>, countShown: Boolean): List<Json> = if (!countShown) lines else lines.filterNot { waiting.matches(it["text"].string ?: "") }
}
