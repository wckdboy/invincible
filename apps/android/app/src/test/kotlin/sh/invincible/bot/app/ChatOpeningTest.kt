package sh.invincible.bot.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import sh.invincible.bot.core.Json

/**
 * The chat the app opens on (the owner's approved structure, 27 November 2026, as the iPhone's): your latest kept chat,
 * read while the chat says so, never its welcome first; the welcome only where nothing is kept yet.
 */
class ChatOpeningTest {
    private fun chat(id: String?, title: String) = Json.obj("id" to id, "title" to title)

    @Test fun theAppOpensOnTheLatestKeptChat() {
        // (The node lists them the latest first.)
        assertEquals("c_3", latestKept(listOf(chat("c_3", "What is left before the release"), chat("c_2", "Plan the week"), chat("c_1", "Hello"))))
    }

    @Test fun aRowWithNoIdIsPassedOver() {
        assertEquals("c_2", latestKept(listOf(chat(null, "Being kept"), chat("c_2", "Plan the week"))))
    }

    @Test fun nothingKeptOpensTheWelcome() {
        assertNull(latestKept(emptyList()))
    }
}
