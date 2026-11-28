package sh.invincible.bot.app

import sh.invincible.bot.core.Ask
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Snapshot
import sh.invincible.bot.core.get
import sh.invincible.bot.core.text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * The agents after each look at the node. A kept one (KeptTable) stays as it was kept until the node answers for the
 * team: on 21 November 2026 a phone whose node was gone redrew it from an empty Inbox, so the primary said nothing needed
 * you, an agent asking for your approval lost its line, and the still line went, as if it were the node's word.
 */
class TableTest {
    private val now = 1_763_700_200_000
    private val team = Snapshot.of(
        Json.parse(
            """{"agents":[{"id":"ada","name":"Ada","role":"engineer","instructions":"","enabled":true,"dailyTurns":40,"turnsToday":0},
                             {"id":"tester","name":"Tester","role":"engineer","instructions":"","enabled":true,"dailyTurns":40,"turnsToday":0}],
                "rooms":[],"tasks":[],"deliveries":[]}""",
        ),
    )
    private val asking = listOf(Ask("arm:team.0123456789.ada", "forge", "post"))
    private val turns = Json.parse("""{"turns":[{"id":"u1","title":"Release notes"}],"unread":[],"chats":"7"}""")

    private fun kept() = Table(
        team,
        Roster.rows(team, asking, now),
        Roster.primaryNow(turns = listOf("Release notes"), runs = emptyList(), needs = Roster.primaryNeeds(4, asking, listOf("ada", "tester"))),
        asOf = 1_763_690_000_000,
    )

    @Test fun aKeptAgentsStaysAsItWasKeptWhileTheNodeCantSayWhoSitsThere() {
        val kept = kept()
        // The node away: no team, no approvals, nothing waiting, no chats. What was kept is what's drawn, and it says so.
        val after = kept.after(team = null, turns = null, asks = emptyList(), inbox = 0, now = now)
        assertSame(kept, after)
        assertEquals(Roster.primaryNow(turns = listOf("Release notes"), runs = emptyList(), needs = 3), after.primary)
        assertEquals(listOf("Asks for approval: forge.post", "engineer"), after.rows.map { it.line })
        assertEquals(1_763_690_000_000, after.asOf)
    }

    @Test fun yourAgentsRowCountsWhatWaitsThatIsNoAgentsAndItsLineSaysAsMuch() {
        // Four wait in the Inbox, one of them Ada's ask for approval, which her own row counts: your agent's row counts
        // the other three, and its line says three, as the PWA's does (lib/roster.ts primaryNeeds).
        val after = Table().after(team = team, turns = turns, asks = asking, inbox = 4, now = now)
        assertEquals(3, after.primaryNeeds)
        assertEquals(Roster.primaryNow(turns = listOf("Release notes"), runs = emptyList(), needs = 3), after.primary)
    }

    @Test fun theNodesAnswerForTheTeamReplacesIt() {
        val after = kept().after(team = team, turns = turns, asks = emptyList(), inbox = 0, now = now)
        assertNull(after.asOf)
        assertEquals(listOf("engineer", "engineer"), after.rows.map { it.line })
        assertEquals(turns["chats"]?.text(), after.chats)
        assertEquals(listOf("Release notes"), after.turns)
    }

    @Test fun anAgentsTheNodeDrewIsDrawnAgainFromItsLastTeamWithWhatsNew() {
        val drawn = kept().after(team = team, turns = turns, asks = emptyList(), inbox = 0, now = now)
        // The team couldn't be read this time, but the approvals could: its last team, with Ada asking.
        val after = drawn.after(team = null, turns = null, asks = asking, inbox = 1, now = now)
        assertNull(after.asOf)
        assertEquals(listOf("Asks for approval: forge.post", "engineer"), after.rows.map { it.line })
        assertEquals(turns["chats"]?.text(), after.chats)
    }
}
