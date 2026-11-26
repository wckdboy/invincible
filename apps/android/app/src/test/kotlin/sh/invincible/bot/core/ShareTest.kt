package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Something shared to the primary, as the web app's share target reads it (lib/share.ts). */
class ShareTest {
    @Test
    fun theSubjectThenTheTextEachOnce() {
        assertEquals("A post\n\nhttps://example.com/post", Share.read("A post", "https://example.com/post"))
        assertEquals("A post: https://example.com/post", Share.read("A post", "A post: https://example.com/post"))
        assertEquals("Just words", Share.read(null, "  Just words \r\n"))
    }

    @Test
    fun nothingHiddenAndNoMoreThanTheBoxTakes() {
        assertEquals("ab\nc\td", Share.read(null, "a\u200bb\r\nc\td\u202e"))
        assertEquals(Share.MAX, Share.read(null, "x".repeat(Share.MAX + 50))!!.length)
    }

    @Test
    fun nothingSharedIsNothing() {
        assertNull(Share.read(null, null))
        assertNull(Share.read("  ", "\u200b"))
    }
}
