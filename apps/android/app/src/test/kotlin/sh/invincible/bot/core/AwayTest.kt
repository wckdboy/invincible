package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

class AwayTest {
    private fun line(text: String, tone: String) = Json.obj("text" to text, "tone" to tone)
    private fun texts(lines: List<Json>) = lines.map { it["text"].string }

    @Test
    fun theCountOfWhatNeedsYouIsSaidOnceWhereTheConversationSaysItAtItsHead() {
        // (The node's away.ts says it last, in its own words, as "N things need your answer.")
        val lines = listOf(line("3 agents' tasks ended: 2 verified, 1 didn't pass.", "danger"), line("Disk almost full", "warn"), line("9 things need your answer.", "warn"))
        assertEquals(listOf("3 agents' tasks ended: 2 verified, 1 didn't pass.", "Disk almost full"), texts(Away.shown(lines, countShown = true)))
        assertEquals(texts(lines), texts(Away.shown(lines, countShown = false)))
        assertEquals(emptyList<String?>(), texts(Away.shown(listOf(line("1 thing needs your answer.", "warn")), countShown = true)))
        // A notice that only reads like it stays.
        assertEquals(listOf("Your answer is needed on the 9 things in Forge"), texts(Away.shown(listOf(line("Your answer is needed on the 9 things in Forge", "warn")), countShown = true)))
    }
}
