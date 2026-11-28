package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneOffset

/**
 * Your chats as the web lists them (apps/web/src/lib/chats.ts, packages/core/src/turns.ts), held to the vectors' `chats`
 * (made in UTC): grouped by local midnight, the latest first (Pinned, Today, Yesterday, This week, Earlier); each one's
 * state in words for the list, as its badge says it ("" where it is simply done); and the search, every word of it in its
 * title or its project.
 */
class ChatListVectorsTest {
    private val c = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["chats"]

    @Test fun aChatIsMarkedWhereItWentOnAsTheWebMarksIt() {
        val marks = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["chatMarks"]
        val ats = marks["ats"].list.map { it.long }
        assertEquals(marks["marked"].list.map { it.int }, ChatList.timeMarks(ats, java.time.ZoneId.of(marks["zone"].string!!)))
        assertEquals(emptyList<Int>(), ChatList.timeMarks(emptyList(), ZoneOffset.UTC))
    }

    @Test fun theyAreGroupedAsTheWebGroupsThem() {
        val groups = ChatList.groups(c["list"].list, c["now"].long!!, ZoneOffset.UTC)
        assertEquals(c["groups"].list.map { it["label"].string }, groups.map { it.label })
        assertEquals(c["groups"].list.map { g -> g["ids"].list.map { it.string } }, groups.map { g -> g.items.map { it["id"].string } })
    }

    @Test fun eachStateIsSaidAsTheWebSaysIt() {
        for (case in c["states"].list) assertEquals(case.text(), case["words"].string, ChatList.stateWords(case))
        // A badge only where there is something to say, never the wire's word.
        assertEquals(null, ChatList.badge(Json.parse("""{"state":"done","queued":0,"held":null,"needs":null}""")))
        assertEquals(ChatList.Badge("Working", ChatList.Tone.ACCENT, live = true), ChatList.badge(Json.parse("""{"state":"working","queued":0,"held":null,"needs":null}""")))
        assertEquals(ChatList.Tone.DANGER, ChatList.badge(Json.parse("""{"state":"failed","queued":0,"held":null,"needs":null}"""))?.tone)
    }

    @Test fun theSearchKeepsTheChatsWithEveryWordInTheirTitleOrProject() {
        val list = listOf(
            Json.parse("""{"id":"a","title":"Release notes for 0.4","project":null}"""),
            Json.parse("""{"id":"b","title":"Sync engine","project":"example.test/app"}"""),
        )
        assertEquals(listOf("a", "b"), ChatList.filter(list, "  ").map { it["id"].string })
        assertEquals(listOf("a"), ChatList.filter(list, "RELEASE 0.4").map { it["id"].string })
        assertEquals(listOf("b"), ChatList.filter(list, "sync example.test").map { it["id"].string })
        assertEquals(emptyList<String?>(), ChatList.filter(list, "release sync").map { it["id"].string })
    }
}
