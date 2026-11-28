package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * An answer's choices in the chat, as the web's (ui/blocks.ts choicesRow): pills to tap, one answer only. Before one is
 * tapped each is offered; once one is, none is (a second tap sent a second reply), the one chosen keeps its ink and the
 * others step back. An older answer's choices are shown, not offered, in a dashed outline.
 */
class ChoiceLookTest {
    private val ship = "Ship it"
    private val hold = "Hold until Monday"

    @Test fun eachIsOfferedUntilOneIsChosen() {
        assertEquals(ChoiceLook(tappable = true, faded = false, inked = false, dashed = false), choiceLook(ship, chosen = null, offered = true))
        assertEquals(ChoiceLook(tappable = true, faded = false, inked = false, dashed = false), choiceLook(hold, chosen = null, offered = true))
    }

    @Test fun onceOneIsChosenNoneIsOfferedTheChosenKeepsItsInkAndTheOthersStepBack() {
        assertEquals(ChoiceLook(tappable = false, faded = false, inked = true, dashed = false), choiceLook(ship, chosen = ship, offered = true))
        assertEquals(ChoiceLook(tappable = false, faded = true, inked = false, dashed = false), choiceLook(hold, chosen = ship, offered = true))
    }

    @Test fun anOlderAnswersChoicesAreShownNotOffered() {
        assertEquals(ChoiceLook(tappable = false, faded = false, inked = false, dashed = true), choiceLook(ship, chosen = null, offered = false))
    }
}
