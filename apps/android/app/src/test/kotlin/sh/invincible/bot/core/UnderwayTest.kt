package sh.invincible.bot.core

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** What is under way in a chat, in words: the PWA's lib/underway.ts, word for word (apps/web/src/lib/underway.test.ts). */
class UnderwayTest {
    private val copenhagen = ZoneId.of("Europe/Copenhagen")
    /** 24 November 2026, 20:07:31 UTC: 21:07 in Copenhagen. */
    private val now = 1_795_550_851_000L

    @Test
    fun aTimeIsTheTimeOfDayTodayWithItsDayOnAnother() {
        assertEquals("23:07", UnderwayWords.whenWords(now + 2 * 3_600_000, now, copenhagen))
        assertEquals("Wed 25 Nov, 09:00", UnderwayWords.whenWords(1_795_593_600_000L, now, copenhagen))
    }

    @Test
    fun aTaskSaysHowItStands() {
        assertEquals("at work", UnderwayWords.state(UnderwayTask("t", "x", "coder", "Coder", "running", "", "r")))
        assertEquals("12 commands · running bun test", UnderwayWords.state(UnderwayTask("t", "x", "coder", "Coder", "running", "12 commands · running bun test\nmore", "r")))
        assertEquals("waiting its turn", UnderwayWords.state(UnderwayTask("t", "x", "ada", "Ada", "queued", "", "r")))
    }

    @Test
    fun aLookSaysWhenAndWhatAtAndComeBackIsHisOwnNote() {
        assertEquals("Looking again at 23:07: Is the site live?", UnderwayWords.look(UnderwayLook("lk_AAAAAAAAAAAAAAAA", now + 2 * 3_600_000, "Is the site live?"), now, copenhagen))
        assertEquals("It looked again, as it said at 21:07 it would: Is the site live?", UnderwayWords.looked(LookNote(now, "Is the site live?"), now + 3_600_000, copenhagen))
    }

    @Test
    fun askedAgainSoonWhileATaskIsUnderWayOrHeIsAnsweringElseEveryHalfMinute() {
        val task = UnderwayTask("task-1", "T", "coder", "Coder", "running", "", "r")
        assertEquals(5_000L, UnderwayWords.nextAskMs(Underway(listOf(task)), answering = false, now = now))
        assertEquals(5_000L, UnderwayWords.nextAskMs(Underway(looks = listOf(look(3_600_000))), answering = true, now = now))
        assertEquals(30_000L, UnderwayWords.nextAskMs(Underway(looks = listOf(look(3_600_000), look(7_200_000))), answering = false, now = now))
        assertEquals(30_000L, UnderwayWords.nextAskMs(Underway(), answering = false, now = now))
    }

    /** Its turn starts within the node's tick of it coming due, and the look is gone from the row then: never half a minute of a Cancel on a look it has already taken. */
    @Test
    fun aLooksRowGoesWhenItComes() {
        assertEquals(13_000L, UnderwayWords.nextAskMs(Underway(looks = listOf(look(3_600_000), look(12_000))), answering = false, now = now))
        assertEquals(5_000L, UnderwayWords.nextAskMs(Underway(looks = listOf(look(12_000))), answering = false, now = now + 12_000))
        assertEquals(5_000L, UnderwayWords.nextAskMs(Underway(looks = listOf(look(12_000))), answering = false, now = now + 20_000))
    }

    private fun look(inMs: Long) = UnderwayLook("lk_AAAAAAAAAAAAAAAA", now + inMs, "N")

    @Test
    fun theNodesAnswerIsReadLeniently() {
        val json = Json.parse("""{"tasks":[{"id":"task-1","title":"T","assignee":"coder","name":"Coder","status":"running","progress":"","room":"room-1"},{"title":"no id"}],"looks":[{"id":"lk_AAAAAAAAAAAAAAAA","at":1795558051000,"note":"N"}]}""")
        val view = Underway.of(json)
        assertEquals(listOf("Coder"), view.tasks.map { it.name })
        assertEquals(listOf("N"), view.looks.map { it.note })
        assertFalse(view.isEmpty)
    }
}
