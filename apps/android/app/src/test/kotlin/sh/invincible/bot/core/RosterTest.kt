package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The team's rows, the primary's line and what each agent is seen doing, held to the vectors the PWA's own code wrote. */
class RosterTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    private fun asks(j: Json?) = j.list.map { Ask(it["by"].string!!, it["connector"].string, it["tool"].string) }

    @Test fun whatAnAgentIsDoingIsReadFromItsStepAsCoreReadsIt() {
        val steps = v["faces"]["steps"].list
        assertTrue(steps.size >= 15)
        for (c in steps) assertEquals(c["line"].string, c["step"].string, Roster.taskStep(c["line"].string!!))
    }

    @Test fun eachRowSaysWhatThePwasSays() {
        val r = v["agents"]
        val rows = Roster.rows(Snapshot.of(r["snapshot"]!!), asks(r["asks"]), r["now"].long!!)
        val want = r["rows"].list
        assertEquals(want.map { it["id"].string }, rows.map { it.id })
        for ((w, got) in want.zip(rows)) {
            assertEquals(w["id"].string, w["line"].string, got.line)
            assertEquals(w["id"].string, w["plain"].string, got.plain)
            assertEquals(w["id"].string, w["needs"].bool, got.needs)
            w["expression"].string?.let { assertEquals(w["id"].string, it, got.expression) }
            w["state"].string?.let { assertEquals(w["id"].string, it, got.state?.wire) }
        }
    }

    @Test fun anApprovalWaitsInTheChatOfTheAgentOfYoursThatAskedTheRestInYourAgents() {
        val asked = asks(v["agents"]["asks"])
        // (What your agent's chat holds is what its row counts, the PWA's primaryNeeds: the Inbox less what agents' chats hold.)
        for (c in v["agents"]["needs"].list) {
            val agents = c["agents"].list.map { it.string!! }
            assertEquals(c["needs"].int, maxOf(0, c["inbox"].int!! - asked.count { Roster.chatOf(it.by, agents) != Primary.HANDLE }))
        }
        assertEquals("max", Roster.chatOf("arm:team.0123456789.max", listOf("max")))
        // (One asked by an agent you removed, or by no agent: your agent's.)
        assertEquals(Primary.HANDLE, Roster.chatOf("arm:team.0123456789.max", listOf("ada")))
        assertEquals(Primary.HANDLE, Roster.chatOf("loop:morning", listOf("max")))
    }

    @Test fun yourAgentsOwnComputerIsReadAsItsSandbox() {
        // (Its own computer, made as an agent's VM is: its screen under its reserved handle, its terminal in its sandbox.)
        val team = Json.parse("""{"agents":[],"rooms":[],"tasks":[],"deliveries":[],"computer":{"node":"homelab","id":"sb-0123456789"}}""")
        assertEquals("sb-0123456789", Snapshot.of(team).computer)
        assertEquals(null, Snapshot.of(Json.parse("""{"agents":[],"rooms":[],"tasks":[],"deliveries":[]}""")).computer)
    }

    @Test fun yourAgentsLineInTheListIsThePwasAndNeverSaysWhatWaitsOnYou() {
        val cases = v["homePrimary"].list
        assertTrue(cases.size >= 15)
        for (c in cases) {
            val line = Roster.homePrimaryLine(
                here = c["answering"].bool!!,
                step = c["step"].string,
                turns = c["turns"].list.map { it.string },
                runs = c["runs"].list.map { it.string!! },
                unread = c["unread"].list.map { it.string },
                latest = c["latest"].string,
                title = c["title"].string,
            )
            assertEquals(c.toString(), c["line"].string, line)
        }
    }

    @Test fun theListThatIsHomeIsThePwasEveryAgentAndRoomTheLatestFirst() {
        val now = v["agents"]["now"].long!!
        for ((name, asked) in listOf("agents" to asks(v["agents"]["asks"]), "rooms" to emptyList(), "unread" to emptyList())) {
            val want = v[name]["home"].list.map { listOf(it["key"].string, it["at"].long, it["count"].int) }
            assertTrue(name, want.size >= 8)
            val got = Roster.homeRows(Snapshot.of(v[name]["snapshot"]!!), asked, now).map { listOf(it.key, it.at, it.count) }
            assertEquals(name, want, got)
        }
    }

    @Test fun aLineBesideItsChipDoesntSayItTwice() {
        for (c in v["agents"]["besides"].list) {
            val state = c["state"].string?.let { s -> AgentState.entries.first { it.wire == s } }
            assertEquals(c["line"].string, c["beside"].string, Roster.besideChip(c["line"].string!!, state))
        }
    }

    @Test fun whatIsNewToYouIsMarkedAsAnEmailIs() {
        val u = v["unread"]
        val rows = Roster.rows(Snapshot.of(u["snapshot"]!!), emptyList(), v["agents"]["now"].long!!)
        for (w in u["rows"].list) {
            val got = rows.first { it.id == w["id"].string }
            assertEquals(w["id"].string, listOf(w["kind"].string, w["line"].string, w["plain"].string, w["needs"].bool, w["unread"].bool, w["state"].string),
                listOf(got.kind, got.line, got.plain, got.needs, got.unread, got.state?.wire))
        }
    }

    @Test fun eachRoomsRowSaysWhatThePwasSaysInBothItsLines() {
        val r = v["rooms"]
        val rows = Roster.rows(Snapshot.of(r["snapshot"]!!), emptyList(), v["agents"]["now"].long!!).filter { it.kind == "room" }
        val want = r["rows"].list
        assertTrue(want.size >= 4)
        assertEquals(want.map { it["id"].string }, rows.map { it.id })
        for ((w, got) in want.zip(rows)) assertEquals(w["id"].string, listOf(w["line"].string, w["plain"].string, w["needs"].bool), listOf(got.line, got.plain, got.needs))
    }

    @Test fun primaryOwnLine() {
        for (c in v["agents"]["primary"].list) {
            val i = c["input"]
            val now = Roster.primaryNow(
                step = i["step"].string, here = i["step"] != null,
                turns = i["turns"].list.map { it["title"].string }, runs = i["runs"].list.map { it["goal"].string ?: "" },
                needs = i["needs"].int, unread = i["unread"].list.map { it["title"].string },
            )
            assertEquals(i!!.text(), listOf(c["text"].string, c["expression"].string, c["tone"].string, c["state"].string), listOf(now.text, now.expression, now.tone, now.state.wire))
            // As every app shows it: what needs you first when there is any (lib/now.ts's needsFirst).
            assertEquals(i.text(), c["needsFirst"].string, now.line)
        }
        for (c in v["agents"]["needs"].list) {
            assertEquals(c["needs"].int, Roster.primaryNeeds(c["inbox"].int!!, asks(v["agents"]["asks"]), c["agents"].list.map { it.string!! }))
        }
    }
}
