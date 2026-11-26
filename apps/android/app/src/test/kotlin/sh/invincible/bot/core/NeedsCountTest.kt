package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What needs you, one count everywhere (Work.needsCount, the iPhone's Session.needsCount). Seen on the emulator (26
 * November 2026): Home said 10 needed you and the menu's Inbox 9, Home counting the node's notices and the facts it
 * noticed about you, the Inbox leaving out the tasks only you can move on. Decisions only, each once.
 */
class NeedsCountTest {
    private fun row(word: String) = Work.Row("t", "r", "A task", Work.Project("other", "Other work", ""), "ada", "Ada", null, AgentState.NEEDS, Work.Attention.NEEDS, word, AgentState.Tone.NEEDS, null, "", false, 0)

    @Test fun decisionsOnlyEachOnce() {
        val now = 1_000_000L
        // Two approvals waiting, one of them an agent's ask (its task's "Allow?" row is that approval, not one more); a
        // proposal and work cut short; a device asking to join; a key asked for; a question still open and one gone by;
        // an ask to use a machine.
        val count = Work.needsCount(
            approvals = 2,
            needs = listOf(row("Allow?"), row("Approve?"), row("Interrupted")),
            pairings = 1,
            keys = 1,
            questionsUntil = listOf(now + 60_000, now - 1, null),
            screens = 1,
            now = now,
        )
        assertEquals(2 + 2 + 1 + 1 + 2 + 1, count)
    }

    @Test fun newsIsCountedNowhere() {
        // Nothing to decide: notices and facts the node noticed aren't among what's counted at all.
        assertEquals(0, Work.needsCount(0, emptyList(), 0, 0, emptyList(), 0, 0))
    }
}
