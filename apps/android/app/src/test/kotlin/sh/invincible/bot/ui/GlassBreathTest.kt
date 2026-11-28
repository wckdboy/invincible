package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.invincible.bot.core.Glass

/**
 * A working agent's light breathes only on its own page (live) while the phone's animations are on; in rows it is still.
 * On Android each breath is a frame of the app's own work (the iPhone's per-frame breath cost 8 to 10 % of a core at rest
 * on 27 November 2026), so rows stay still until a breath the render thread runs is measured.
 */
class GlassBreathTest {
    @Test fun onlyAWorkingAgentOnItsOwnPageBreathes() {
        assertEquals(true, glassBreathes(Glass.State.WORKING, live = true, motion = true))
        // In a row: still.
        assertEquals(false, glassBreathes(Glass.State.WORKING, live = false, motion = true))
        // The phone's animations off: still.
        assertEquals(false, glassBreathes(Glass.State.WORKING, live = true, motion = false))
        // Anything but work, or no state at all: still.
        for (state in listOf(Glass.State.NEEDS, Glass.State.IDLE, Glass.State.FAILED, null)) {
            assertEquals("$state", false, glassBreathes(state, live = true, motion = true))
        }
    }

    @Test fun aGlassThatWaitsOnYouNudgesWhereItIsInFocusWhileThingsMayMove() {
        // (The lead's word, 28 November 2026: "the avatar's nudge is its motion, not a colour".)
        assertEquals(true, glassNudges(Glass.State.NEEDS, live = true, motion = true))
        assertEquals(false, glassNudges(Glass.State.NEEDS, live = false, motion = true))
        // The phone's animations off: still.
        assertEquals(false, glassNudges(Glass.State.NEEDS, live = true, motion = false))
        for (state in listOf(Glass.State.WORKING, Glass.State.IDLE, Glass.State.FAILED, null)) {
            assertEquals("$state", false, glassNudges(state, live = true, motion = true))
        }
    }
}
