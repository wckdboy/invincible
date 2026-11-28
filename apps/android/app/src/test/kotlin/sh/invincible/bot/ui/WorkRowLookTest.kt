package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Steps
import sh.invincible.bot.core.Work

/**
 * A task's row on Work, as the web's (views/work-rows.ts workRow, lib/work.ts namesProjects): its project named only where
 * the work is in more than one (with one, "Other work" and its dashed box on every row said nothing; the row is then two
 * lines, its title with how it stands and its age, then its agent with what it is doing); how it stands, a tick for proven
 * work alone and else a dot of its tone, before its word; what it came to, unless its word says it already. The word, its
 * tone, the age and the detail are core's, held to the web's by WorkVectorsTest.
 */
class WorkRowLookTest {
    private fun row(word: String, detail: String, tone: AgentState.Tone, verdict: Steps.Said? = null) = Work.Row(
        id = "t1", room = "r1", title = "Sync survives a dropped connection", project = Work.OTHER, agent = "builder", agentName = "Builder",
        avatar = null, state = AgentState.WORKING, attention = Work.Attention.WORKING, word = word, tone = tone, age = null,
        detail = detail, mono = false, at = 0, verdict = verdict,
    )

    private fun attended(vararg projects: String) =
        Work.Attended(emptyList(), emptyList(), emptyList(), emptyList(), projects.map { Work.Counted(it, it, it.take(1).uppercase(), 1) })

    @Test fun projectsAreNamedOnlyWhereTheWorkIsInMoreThanOne() {
        assertFalse(Work.namesProjects(attended()))
        assertFalse(Work.namesProjects(attended("other")))
        assertTrue(Work.namesProjects(attended("other", "example.test/app")))
    }

    @Test fun aRowIsTwoLinesWhereProjectsArentNamedAndThreeWhereTheyAre() {
        assertFalse(rowLook(row("Queued", "", AgentState.Tone.NEUTRAL), named = false).projectLine)
        assertTrue(rowLook(row("Queued", "", AgentState.Tone.NEUTRAL), named = true).projectLine)
    }

    @Test fun howItStandsIsADotOfItsToneBeforeItsWordAndATickForProvenWorkAlone() {
        assertFalse(rowLook(row("Working · 4m", "", AgentState.Tone.WORK), named = false).tick)
        assertTrue(rowLook(row("Proven", "", AgentState.Tone.OK, Steps.Said("Proven", Steps.Verdict.PROVEN)), named = false).tick)
        assertFalse(rowLook(row("Gave up", "gave up", AgentState.Tone.FAILED, Steps.Said("Gave up", Steps.Verdict.GAVE_UP)), named = false).tick)
    }

    @Test fun whatItCameToIsSaidUnlessItsWordSaysItAlready() {
        assertEquals("", rowLook(row("Gave up", "gave up", AgentState.Tone.FAILED, Steps.Said("Gave up", Steps.Verdict.GAVE_UP)), named = false).detail)
        assertEquals("3 files kept", rowLook(row("Reviewed, not proven", "3 files kept", AgentState.Tone.NEUTRAL, Steps.Said("Reviewed, not proven", Steps.Verdict.REVIEWED)), named = false).detail)
    }
}
