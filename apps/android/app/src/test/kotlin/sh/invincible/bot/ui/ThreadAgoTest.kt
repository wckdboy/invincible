package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A task's thread says when it was given and when each message came. Given again on the emulator (26 November 2026), a
 * task read "Given to Writer by name. In 0 minutes": the node's clock was three seconds ahead of the phone's, and Android's
 * words for a moment ahead are "In 0 minutes". The last minute, and a moment a few seconds ahead, is "just now", as Home
 * and the agents already say it.
 */
class ThreadAgoTest {
    private val now = 1_795_673_000_000L

    @Test fun aMomentAheadOfThisPhonesClockIsJustNow() {
        assertEquals("just now", threadAgo(now + 3_000, now).toString())
    }

    @Test fun theLastMinuteIsJustNow() {
        assertEquals("just now", threadAgo(now, now).toString())
        assertEquals("just now", threadAgo(now - 59_000, now).toString())
    }
}
