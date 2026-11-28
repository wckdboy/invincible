package sh.invincible.bot.app

import sh.invincible.bot.core.Json
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Inbox: each thing it shows has its own key (a list given one key twice stops the app), and it holds what the
 * iPhone's holds, counted as the iPhone counts it.
 */
class InboxTest {
    @Test
    fun aDeviceThatAskedTwiceIsTwoRequests() {
        // A phone whose first ask was left unanswered asks again with a new invite, and the node shows both.
        val first = Json.obj("invite" to "inv-1", "device" to "c_same", "sas" to "703369")
        val again = Json.obj("invite" to "inv-2", "device" to "c_same", "sas" to "694782")
        assertNotEquals(Inbox.pairingKey(first), Inbox.pairingKey(again))
    }

    @Test
    fun itCountsWhatTheIPhonesInboxCounts() {
        // Approvals, questions, keys, devices, facts it noticed, notices, and its use of a Mac (Session.swift's inboxCount).
        val one = listOf(Json.obj("id" to "x"))
        val inbox = Inbox(actions = one, questions = one, keys = one, pairings = one, facts = one, notices = one, screens = one)
        assertEquals(7, inbox.count)
    }

    @Test
    fun aDismissedNoticeAndAMacSessionOverAreNotShown() {
        val notices = listOf(Json.obj("key" to "a", "dismissed" to false), Json.obj("key" to "b", "dismissed" to true), Json.obj("key" to "c"))
        assertEquals(listOf("a", "c"), Inbox.open(notices).map { it["key"].string })
        val sessions = listOf("waiting", "allowed", "lapsed", "denied", "over", "ended").map { Json.obj("id" to it, "state" to it) }
        assertEquals(listOf("waiting", "allowed"), Inbox.live(sessions).map { it["id"].string })
    }

    @Test
    fun whereANoticeCameFromIsSaidAsTheIPhoneSaysIt() {
        assertEquals("Your rule pushes", Inbox.from("rule:pushes"))
        assertEquals("The loop nightly", Inbox.from("loop:nightly"))
        assertEquals("The heartbeat", Inbox.from("heartbeat"))
        assertEquals("CI", Inbox.from("ci"))
        assertEquals("Its compute", Inbox.from("compute"))
        assertEquals("Routing", Inbox.from("routing"))
        assertEquals("rule:", Inbox.from("rule:"))
        assertEquals("something else", Inbox.from("something else"))
    }

    @Test
    fun whereANoticeCameFromIsThePwasWordsByTheVectors() {
        // (apps/apple/InvincibleTests/Fixtures/core-vectors.json: the PWA's lib/notices.ts on each source, the iPhone's too.)
        val vectors = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["notices"].list
        assertTrue(vectors.isNotEmpty())
        for (v in vectors) assertEquals(v["source"].string, v["from"].string, Inbox.from(v["source"].string!!))
    }
}
