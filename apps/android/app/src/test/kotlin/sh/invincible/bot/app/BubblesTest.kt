package sh.invincible.bot.app

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.list

/**
 * A kept chat's messages as the app shows them (bubblesOf): each of yours says when you said it, and a look of its when it
 * came back; an answer says nothing of when, and is said under what it answers (ChatList.timeMarks, the PWA's).
 */
class BubblesTest {
    @Test fun yoursSayWhenTheyWereSaidAndAnAnswerNever() {
        val messages = Json.parse(
            """[{"role":"user","content":"Plan the week","createdAt":1795855260000},
                {"role":"assistant","content":"## Done","status":"done","createdAt":1795855320000},
                {"role":"user","content":"","look":{"set":1795850000000,"note":"Check the build"},"createdAt":1795858000000}]""",
        ).list
        val bubbles = bubblesOf(messages)
        assertEquals(listOf("Plan the week", "## Done", ""), bubbles.map { it.text })
        assertEquals(listOf(1_795_855_260_000L, null, 1_795_858_000_000L), bubbles.map { it.at })
    }
}
