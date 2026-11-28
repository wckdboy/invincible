package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Every key a chat's list holds is there once: a key used twice in one LazyColumn stops the app as it is drawn (Compose
 * throws), as "asks" did twice on a new chat's welcome (28 November 2026: the asks in the flow, and the welcome's
 * suggestions). ChatScreen and Timeline draw exactly these lists.
 */
class ChatItemsTest {
    private fun assertUnique(what: String, keys: List<String>) = assertEquals("$what: ${keys.groupBy { it }.filter { it.value.size > 1 }.keys}", keys.size, keys.toSet().size)

    @Test fun aNewChatsWelcomeHoldsEachKeyOnce() {
        assertUnique("welcome", ChatItem.of(reading = false, welcome = true, away = true, messages = 0, steers = 0, tasks = emptyList(), looks = emptyList(), queued = false, notice = false, problem = false).map { it.key })
        // (Read as it opens: its latest chat being read, then its welcome.)
        assertUnique("reading", ChatItem.of(reading = true, welcome = false, away = false, messages = 0, steers = 0, tasks = emptyList(), looks = emptyList(), queued = false, notice = false, problem = true).map { it.key })
    }

    @Test fun aChatOfAsksAloneHoldsEachKeyOnce() {
        assertUnique("asks alone", ChatItem.of(reading = false, welcome = false, away = false, messages = 0, steers = 0, tasks = emptyList(), looks = emptyList(), queued = false, notice = false, problem = false).map { it.key })
        assertUnique("an agent's asks alone", TimelineItem.of(entries = emptyList(), problem = false, needs = true).map { it.key })
    }

    @Test fun aFullChatHoldsEachKeyOnce() {
        assertUnique(
            "full",
            ChatItem.of(reading = false, welcome = false, away = false, messages = 40, steers = 2, tasks = listOf("task-a", "task-b"), looks = listOf("look-a"), queued = true, notice = true, problem = true).map { it.key },
        )
        assertUnique("an agent's, full", TimelineItem.of(entries = (1..30).map { "m:$it" } + (1..10).map { "t:task-$it" }, problem = true, needs = true).map { it.key })
    }

    /** (Every kind at once, though no chat shows them all together: no two kinds can ever share a key.) */
    @Test fun noTwoKindsOfItemShareAKey() {
        assertUnique("every kind", ChatItem.of(reading = true, welcome = true, away = true, messages = 3, steers = 3, tasks = listOf("x"), looks = listOf("x"), queued = true, notice = true, problem = true).map { it.key })
        assertUnique("every kind of an agent's", TimelineItem.of(entries = listOf("m:x", "t:x"), problem = true, needs = true).map { it.key })
    }
}
