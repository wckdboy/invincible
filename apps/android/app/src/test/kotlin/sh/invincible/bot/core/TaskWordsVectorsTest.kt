package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A task's words against the vectors' `timelines` section (the PWA's lib/task-card.ts over core's interventions.ts), as
 * the iPhone's TimelineTests holds its own. Run on the emulator (26 November 2026), Android's thread said "You stepped
 * in: again" and "takeover", the node's own keys, where the PWA and the iPhone say "given again" and "its desktop taken
 * over".
 */
class TaskWordsVectorsTest {
    private val t = Fixture.vectors["timelines"]!!
    private val tasks = t["tasks"].list.associate { it["id"].string!! to TeamTask.of(it) }

    /** How each ended, what can be done with it (Ship it among them, where its verified work kept changes) and what it is
     * asked when given again: the PWA's taskEnd, taskActions and againGoal, card for card. */
    @Test fun eachTasksEndActionsAndAgainAreThePwas() {
        val cards = t["cards"].list
        assertEquals(tasks.size, cards.size)
        assertTrue(cards.any { it["actions"].list.any { a -> a.string == "ship" } })
        for (card in cards) {
            val id = card["id"].string!!
            val task = tasks.getValue(id)
            val end = TaskWords.end(task)
            val want = card["end"]
            if (want == null || want == Json.Null) assertEquals("$id end", null, end)
            else {
                assertEquals("$id end.why", want["why"].string, end?.why)
                assertEquals("$id end.said", want["said"].string, end?.said)
            }
            assertEquals("$id actions", card["actions"].list.map { it.string }, TaskWords.actions(task))
            assertEquals("$id again", card["again"].string, TaskWords.againGoal(task))
        }
    }

    @Test fun howYouSteppedInIsSaidAsThePwaSaysIt() {
        val cards = t["cards"].list
        assertTrue(cards.count { it["stepped"].string != null } >= 2)
        for (card in cards) {
            val id = card["id"].string!!
            assertEquals(id, card["stepped"].string, TaskWords.stepped(tasks.getValue(id)))
        }
    }
}
