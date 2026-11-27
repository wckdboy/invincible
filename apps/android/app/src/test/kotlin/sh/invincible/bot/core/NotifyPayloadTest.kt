package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A notification's payload, read as strictly as core's readNotifyPayload reads it (and the web app's service worker,
 * whose cases these are): exactly its fields, bounded, nothing hidden in its words. And where a tap opens, and when it is
 * about what the app shows.
 */
class NotifyPayloadTest {
    private val chat = "cv_1234567890123456789012"
    private val finished = Json.obj("v" to 1, "kind" to "finished", "title" to "Your agent has finished", "body" to "A chat you left it working in has its answer.", "open" to "chat", "conversation" to chat, "tag" to "t-AbCdEfGhIjKlMnOpQrStUv")
    private val task = Json.obj("v" to 1, "kind" to "finished", "title" to "Your agent's task: Proven", "body" to "Proven · \$0.31. Its changes are ready to ship.", "open" to "task", "task" to "task-abc123def456", "ship" to true, "tag" to "t-task0123456789abcdefgh")
    private val approval = Json.obj("v" to 1, "kind" to "approval", "title" to "Your agent asks your approval", "body" to "An action is waiting for your answer in Needs you.", "open" to "inbox", "tag" to "t-approval0123456789abcd", "action" to "a_0123456789abcdefghijkl", "approvable" to true)

    private fun with(base: Json.Obj, vararg changes: Pair<String, Any?>): Json.Obj = Json.Obj(LinkedHashMap(base.fields).apply { for ((k, v) in changes) if (v == null) remove(k) else put(k, Json.of(v)) })

    @Test fun aPayloadOfOursIsReadAsItIs() {
        val read = NotifyPayload.read(finished)!!
        assertEquals("Your agent has finished", read.title)
        assertEquals("chat", read.open)
        assertEquals(chat, read.conversation)
        assertNull(read.task)
        val needs = NotifyPayload.read(Json.obj("v" to 1, "kind" to "needs-you", "title" to "Your agent: this needs you", "body" to "It waits in Needs you.", "open" to "inbox", "tag" to "t-0123456789abcdefghijkl"))!!
        assertEquals("needs-you", needs.kind)
        for (kind in listOf("approval", "question", "told", "summary", "limit", "test")) assertNotNull(kind, NotifyPayload.read(with(finished, "kind" to kind, "open" to "inbox", "conversation" to null)))
    }

    @Test fun aTasksEndNamesTheTaskAndWhetherItCanBeShipped() {
        // (26 November 2026: a task's end came through UnifiedPush and was shown as "Something needs you": the app knew no task.)
        val read = NotifyPayload.read(task)
        assertNotNull(read)
        assertEquals("task", read!!.open)
        assertEquals("task-abc123def456", read.task)
        assertTrue(read.ship)
        assertFalse(NotifyPayload.read(with(task, "ship" to null))!!.ship)
    }

    @Test fun anApprovalCarriesItsActionForItsButtons() {
        val read = NotifyPayload.read(approval)!!
        assertEquals("a_0123456789abcdefghijkl", read.action)
        assertTrue(read.approvable)
        // A delete is approved only where its name is typed: Decline alone.
        assertFalse(NotifyPayload.read(with(approval, "approvable" to false))!!.approvable)
    }

    @Test fun anythingThatIsntOneOfOursIsNoPayload() {
        val strange: List<Json?> = listOf(
            null,
            Json.parse("[\"an\",\"array\"]"),
            Json.parse("42"),
            Json.obj("v" to 1, "kind" to "advert", "title" to "Buy now", "body" to "Click here", "open" to "inbox", "tag" to "x"),
            with(finished, "v" to 2),
            with(finished, "open" to "https://evil.example/login"),
            with(finished, "url" to "https://evil.example/login"),
            with(finished, "title" to "x".repeat(500)),
            with(finished, "title" to ""),
            with(finished, "body" to "hidden‮override"),
            with(finished, "body" to "two  spaces"),
            with(finished, "conversation" to "../../evil"),
            with(finished, "open" to "overview"),
            with(finished, "tag" to "a tag with spaces"),
            with(task, "task" to "../../evil"),
            with(task, "open" to "inbox"),
            with(task, "task" to null),
            with(task, "ship" to "yes"),
            with(approval, "kind" to "needs-you"),
            with(approval, "action" to "a_short"),
            with(approval, "action" to null),
        )
        for (s in strange) assertNull(s?.text() ?: "null", NotifyPayload.read(s))
    }

    @Test fun theGeneralOneIsShownForAnythingElse() {
        val g = NotifyPayload.GENERIC
        assertEquals(listOf("needs-you", "Invincible", "Something needs you. Open the app to see it.", "inbox", "primary"), listOf(g.kind, g.title, g.body, g.open, g.tag))
    }

    @Test fun aTapOpensWhereItSays() {
        assertEquals("task:task-abc123def456", NotifyPayload.address(NotifyPayload.read(task)!!))
        assertEquals("chat", NotifyPayload.address(NotifyPayload.read(finished)!!))
        assertEquals("inbox", NotifyPayload.address(NotifyPayload.read(approval)!!))
        assertEquals("settings", NotifyPayload.address(NotifyPayload.read(with(approval, "kind" to "test", "open" to "settings", "action" to null, "approvable" to null))!!))
        // The Overview is the web's: here, Home, where the work is.
        assertEquals("home", NotifyPayload.address(NotifyPayload.read(with(finished, "open" to "overview", "conversation" to null))!!))
        // What a notification's intent carries is read again at the tap: only the app's own places, and a task by its own id.
        assertEquals("task:task-abc123def456", NotifyPayload.addressOf("task", "task-abc123def456"))
        for ((open, task) in listOf("task" to null, "task" to "../evil", "journal" to null, null to null, "https://evil.example" to null)) assertEquals("home", NotifyPayload.addressOf(open, task))
        assertTrue(NotifyPayload.isActionId("a_0123456789abcdefghijkl"))
        assertFalse(NotifyPayload.isActionId("a_short"))
        assertTrue(NotifyPayload.isConversationId(chat))
        assertFalse(NotifyPayload.isConversationId("../evil"))
    }

    @Test fun quietWhileTheAppShowsThatVeryThing() {
        val t = NotifyPayload.read(task)!!
        assertTrue(NotifyPayload.aboutWhatShows(t, "task:task-abc123def456"))
        assertFalse(NotifyPayload.aboutWhatShows(t, "task:task-zzz999zzz999"))
        assertFalse(NotifyPayload.aboutWhatShows(t, "home"))
        assertFalse(NotifyPayload.aboutWhatShows(t, null))
        val a = NotifyPayload.read(approval)!!
        assertTrue(NotifyPayload.aboutWhatShows(a, "inbox"))
        assertFalse(NotifyPayload.aboutWhatShows(a, "home"))
        // A test always shows: it's what you asked to see.
        val test = NotifyPayload.read(with(approval, "kind" to "test", "open" to "settings", "action" to null, "approvable" to null))!!
        assertFalse(NotifyPayload.aboutWhatShows(test, "settings"))
    }

    @Test fun wordsAreCleanedAsCoreCleansThem() {
        assertEquals("a b c", NotifyPayload.clean("a\u0007b​c", 60))
        assertEquals("one line", NotifyPayload.clean("  one\n\t line  ", 60))
        assertEquals("abcd…", NotifyPayload.clean("abcdefgh", 5))
        assertEquals("ab…", NotifyPayload.clean("ab  cdefgh", 4))
    }

    /** Held to core through the vectors (`notifyPayload`), as the Mac app's reader is: each payload read or refused as
     * readNotifyPayload does, the general one, and words cleaned as notifyClean cleans them. */
    @Test fun eachPayloadOfTheVectorsIsReadOrRefusedAsCoreReadsIt() {
        val v = Fixture.vectors["notifyPayload"]
        assertEquals(NotifyPayload.TITLE_MAX, v["titleMax"].int)
        assertEquals(NotifyPayload.BODY_MAX, v["bodyMax"].int)
        val cases = v["read"].list
        assertTrue(cases.size > 40)
        for (item in cases) {
            val want = item["read"]
            val read = NotifyPayload.read(item["raw"])
            if (want == null || want == Json.Null) assertNull("core refuses ${item["raw"]?.text()}", read)
            else assertEquals(item["raw"]?.text(), notice(want), read)
        }
        assertEquals(notice(v["generic"]!!), NotifyPayload.GENERIC)
        for (item in v["clean"].list) assertEquals(item["text"].string, item["clean"].string, NotifyPayload.clean(item["text"].string!!, item["max"].int!!))
    }

    private fun notice(v: Json) = NotifyPayload.Notice(v["kind"].string!!, v["title"].string!!, v["body"].string!!, v["open"].string!!, v["conversation"].string, v["task"].string, v["ship"].bool == true, v["tag"].string!!, v["action"].string, v["approvable"].bool == true)
}
