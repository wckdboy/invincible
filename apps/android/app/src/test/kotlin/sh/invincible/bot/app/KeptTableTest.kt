package sh.invincible.bot.app

import sh.invincible.bot.core.Ask
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Snapshot
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string
import sh.invincible.bot.core.text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The last team this phone saw, kept on it (the owner's word, 21 November 2026): drawn again as the node drew it,
 * with no more than the agents show, and never for another node or another key.
 */
class KeptTableTest {
    private val node = PairedNode("https://keep.example.test", "c_device-one", "Phone", "f_fleet", "keep", "homelab")
    private val team = Json.parse(
        """
        {"agents":[{"id":"ada","name":"Ada","role":"engineer","instructions":"Never push to main; my bank PIN is not yours to know.","memory":"Working notes: the staging password rotates on Fridays.",
                       "keys":[{"name":"stripe-live"}],"acp":"goose acp","enabled":true,"dailyTurns":40,"turnsToday":3,"createdBy":"you","avatar":{"look":"coder"},
                       "workspace":{"id":"0123456789","status":"running"},"repository":"https://github.com/wckdboy/invincible"},
                      {"id":"tester","name":"Tester","role":"engineer","instructions":"","memory":"","enabled":false}],
         "rooms":[{"id":"r1","name":"Release room","direct":false,"members":["ada","tester"],"updatedAt":1763700000000,"paused":false}],
         "tasks":[{"id":"t1","title":"Sync survives a dropped connection","goal":"The whole brief, with the customer's address in it","assignee":"ada","status":"running","verified":false,
                   "updatedAt":1763700000000,"progress":"Running · bun test","changes":{"files":3,"patch":"diff --git a/secret.env"},"proposedBy":"operator","room":"r1","dependsOn":["t0"]},
                  {"id":"t2","title":"The importer reads ISO dates","assignee":"tester","status":"failed","verified":false,"updatedAt":1763690000000,"error":"gave up"},
                  {"id":"t3","title":"Release notes","assignee":"ada","status":"done","verified":true,"createdAt":1763600000000,"updatedAt":1763610000000,
                   "shipped":{"url":"https://forge.example.test/private-org/pull/7","pr":7},"gates":["bun test --secret-flag"],"output":"what it said"}],
         "deliveries":[{"id":"d1","agent":"ada","status":"queued","updatedAt":1763700000000,"room":"r1","text":"a message's words"}],"removed":[{"id":"gone","name":"Gone"}],
         "seen":{"ada":1763690000000},
         "outcomes":[{"id":"o1","goal":"Something the agents don't draw"}]}
        """.trimIndent(),
    )
    private val turns = Json.parse("""{"turns":[{"id":"u1","title":"Release notes","text":"words of a chat"},{"id":"u2","text":"a temporary chat's words"}],"unread":[{"id":"c1","title":"The importer","preview":"its answer"}],"chats":"7"}""")
    private val asks = listOf(Ask("arm:team.ada", "forge", "post"))

    @Test fun drawsTheAgentsAgainAsTheNodeDrewIt() {
        val kept = KeptTable.read(Json.parse(KeptTable.of(node, team, turns, asks, waiting = 3, at = 1_763_700_123_000).text()), node)!!
        val now = 1_763_700_200_000
        assertEquals(Roster.rows(Snapshot.of(team), asks, now), Roster.rows(Snapshot.of(kept.team), kept.asks, now))
        // (A temporary chat has no title, and is kept as one: its line still says it is working in it.)
        assertEquals(listOf("Release notes", null), kept.turns)
        assertEquals(listOf("The importer"), kept.unread.map { it["title"].string })
        assertEquals(asks, kept.asks)
        assertEquals(3, kept.waiting)
        assertEquals(1_763_700_123_000, kept.at)
    }

    @Test fun yourAgentsRowCountsWhatWasKeptAsNoAgentsUntilTheNodeAnswers() {
        // Four waited in the Inbox, one of them Ada's ask for approval, which her own row counts: your agent's row counts
        // the other three, and its line says three.
        val adas = listOf(Ask("arm:team.0123456789.ada", "forge", "post"))
        val now = 1_763_700_200_000
        val kept = KeptTable.read(Json.parse(KeptTable.of(node, team, turns, adas, waiting = 5, at = 1, inbox = 4).text()), node)!!
        assertEquals(4, kept.inbox)
        val restored = Table.restored(kept, Snapshot.of(kept.team), now)
        assertEquals(3, restored.primaryNeeds)
        assertEquals(Roster.primaryNow(turns = listOf("Release notes", null), runs = emptyList(), needs = 3, unread = listOf("The importer")), restored.primary)
        // (One kept before the Inbox's count was says nothing of what needs you until the node answers, never the whole count.)
        val older = KeptTable.read(Json.parse(KeptTable.of(node, team, turns, adas, waiting = 5, at = 1).text()), node)!!
        assertNull(older.inbox)
        val before = Table.restored(older, Snapshot.of(older.team), now)
        assertEquals(0, before.primaryNeeds)
        assertEquals(Roster.primaryNow(turns = listOf("Release notes", null), runs = emptyList(), needs = null, unread = listOf("The importer")), before.primary)
    }

    @Test fun keepsNoMoreThanTheAgentsDraws() {
        val text = KeptTable.of(node, team, turns, asks, waiting = 3, at = 1).text()
        // An agent's standing instructions, what the team holds beyond the roster, a chat's words: none of it is kept.
        // An agent's instructions and working notes, the keys it may use, its agent's command, a task's brief and patch,
        // a message's words, what the team holds beyond the roster, a chat's words: none of it is kept.
        for (absent in listOf("instructions", "bank PIN", "memory", "staging password", "stripe-live", "goose acp", "the customer's address", "secret.env",
            "a message's words", "outcomes", "Something the agents", "words of a chat", "a temporary chat's words", "its answer",
            // (A pull request's number is kept for its row, never where it is; a task's gates and what it said are its thread's.)
            "private-org", "--secret-flag", "what it said")) assertFalse(absent, text.contains(absent))
        val kept = KeptTable.read(Json.parse(text), node)!!
        assertEquals(listOf("agents", "rooms", "tasks", "deliveries", "removed", "seen"), (kept.team as Json.Obj).fields.keys.toList())
        assertEquals(Snapshot.of(team), Snapshot.of(kept.team).copy(agents = Snapshot.of(kept.team).agents.map { it.copy(instructions = Snapshot.of(team).agents.first { t -> t.id == it.id }.instructions) }))
        assertEquals(listOf("Ada", "Tester"), kept.team["agents"].list.map { it["name"].string })
        // What the work's rows draw is kept: the project an agent works in, when a task began, its pull request's number.
        val rows = { team: sh.invincible.bot.core.Json -> sh.invincible.bot.core.Work.byAttention(
            sh.invincible.bot.core.Work.attended(Snapshot.of(team).agents, sh.invincible.bot.core.TeamTask.all(team), Snapshot.of(team).seen, emptyList(), asks, 1_763_700_200_000),
        ) }
        assertEquals(rows(team), rows(kept.team))
        assertEquals("PR #7", rows(kept.team).first { it.id == "t3" }.detail)
        assertEquals("invincible", rows(kept.team).first { it.id == "t3" }.project.name)
    }

    @Test fun aListThatIsntOneIsLeftOutNeverKeptWhole() {
        val odd = Json.parse("""{"agents":[],"rooms":[],"tasks":{"t1":{"goal":"a brief, not in a list"}},"deliveries":[]}""")
        val text = KeptTable.of(node, odd, turns, asks, waiting = 0, at = 1).text()
        assertFalse(text.contains("a brief, not in a list"))
        assertEquals(listOf("agents", "rooms", "deliveries"), (KeptTable.read(Json.parse(text), node)!!.team as Json.Obj).fields.keys.toList())
    }

    @Test fun isNeverDrawnForAnotherNodeAnotherKeyOrAnotherVersion() {
        val kept = Json.parse(KeptTable.of(node, team, turns, asks, waiting = 0, at = 1).text())
        assertNull(KeptTable.read(kept, node.copy(origin = "https://other.example.test")))
        assertNull(KeptTable.read(kept, node.copy(device = "c_device-two")))
        val fields = (kept as Json.Obj).fields
        assertNull(KeptTable.read(Json.Obj(fields + ("v" to Json.of(2))), node))
        assertNull(KeptTable.read(Json.Obj(fields - "team"), node))
        assertNull(KeptTable.read(Json.obj(), node))
    }
}
