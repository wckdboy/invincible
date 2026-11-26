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
            assertEquals(w["id"].string, w["needs"].bool, got.needs)
            w["expression"].string?.let { assertEquals(w["id"].string, it, got.expression) }
            w["state"].string?.let { assertEquals(w["id"].string, it, got.state?.wire) }
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
            assertEquals(w["id"].string, listOf(w["kind"].string, w["line"].string, w["needs"].bool, w["unread"].bool, w["state"].string),
                listOf(got.kind, got.line, got.needs, got.unread, got.state?.wire))
        }
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
