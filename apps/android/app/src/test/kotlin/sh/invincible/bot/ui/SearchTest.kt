package sh.invincible.bot.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Search finds a place by its title, and Needs you, the Inbox until 27 November 2026, by that name too, as the web's
 * palette and the iPad's and the Mac's do.
 */
class SearchTest {
    @Test fun needsYouIsFoundByItsOldNameTheInboxToo() {
        for (low in listOf("inbox", "inb", "box", "needs you", "")) assertTrue(low, placeFound("p:inbox", "Needs you", low))
        // The old name is Needs you's alone, and a place is still found by its own.
        assertFalse(placeFound("p:agents", "Agents", "inbox"))
        assertTrue(placeFound("p:agents", "Agents", "agent"))
        assertFalse(placeFound("p:inbox", "Needs you", "agents"))
    }
}
