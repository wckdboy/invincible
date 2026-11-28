package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/**
 * A new chat's welcome, as the web's (views/chat.ts emptyState and recentChats): your recent chats are your latest kept
 * ones, four at most, as the node lists them (the latest first); each says how many messages it holds and when it last
 * moved, in the web's words (chatRow: "2 messages · just now").
 */
class WelcomeTest {
    private val now = Instant.parse("2026-11-28T02:00:00Z").toEpochMilli()
    private fun chat(id: String, count: Int?, updatedAt: Long?) = Json.parse(
        listOfNotNull("\"id\":\"$id\"", "\"title\":\"Chat $id\"", count?.let { "\"count\":$it" }, updatedAt?.let { "\"updatedAt\":$it" }).joinToString(",", "{", "}"),
    )

    @Test fun theRecentChatsAreTheLatestKeptFourAtMost() {
        val kept = (1..6).map { chat("c$it", 2, now) }
        assertEquals(listOf("c1", "c2", "c3", "c4"), recentChats(kept).map { it["id"].string })
        assertEquals(emptyList<Json>(), recentChats(emptyList()))
    }

    @Test fun aRecentChatSaysHowManyMessagesAndWhenItLastMoved() {
        assertEquals("2 messages · just now", recentLine(chat("a", 2, now - 10_000), now, ZoneOffset.UTC, Locale.US))
        assertEquals("1 message · 5 min ago", recentLine(chat("b", 1, now - 5 * 60_000), now, ZoneOffset.UTC, Locale.US))
        assertEquals("just now", recentLine(chat("c", null, now), now, ZoneOffset.UTC, Locale.US))
    }
}
