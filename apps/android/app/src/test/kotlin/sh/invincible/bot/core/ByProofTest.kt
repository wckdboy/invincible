package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Home's work by proof (the iPhone's ByProof, I9): what is in hand first, then what is proven, then what failed, then the
 * rest of what ended, folded; what needs you is left out (those are decisions, above them). So a running task is one tap
 * from Home: before, it sat under every task that was new to you, a scroll away.
 */
class ByProofTest {
    private fun row(id: String, state: AgentState, attention: Work.Attention, at: Long, verdict: Steps.Verdict? = null) = Work.Row(
        id, "r", id, Work.Project("other", "Other work", ""), "ada", "Ada", null, state, attention, "", state.tone, null, "", false, at,
        verdict?.let { Steps.Said(it.wire, it) },
    )

    @Test fun inHandFirstThenProvenThenFailedThenTheRest() {
        val work = Work.Attended(
            needs = listOf(row("asks", AgentState.NEEDS, Work.Attention.NEEDS, 9)),
            active = listOf(
                row("failed-new", AgentState.FAILED, Work.Attention.ACTIVE, 8, Steps.Verdict.FAILED),
                row("proven-new", AgentState.VERIFIED, Work.Attention.ACTIVE, 7, Steps.Verdict.PROVEN),
            ),
            working = listOf(
                row("queued", AgentState.QUEUED, Work.Attention.WORKING, 6),
                row("running", AgentState.WORKING, Work.Attention.WORKING, 1),
            ),
            done = listOf(
                row("proven-old", AgentState.VERIFIED, Work.Attention.DONE, 5, Steps.Verdict.PROVEN),
                row("gave-up", AgentState.FAILED, Work.Attention.DONE, 4, Steps.Verdict.GAVE_UP),
                row("sent-back", AgentState.FAILED, Work.Attention.DONE, 3, Steps.Verdict.REJECTED),
                row("reviewed", AgentState.RESTING, Work.Attention.DONE, 2, Steps.Verdict.REVIEWED),
                row("stopped", AgentState.PAUSED, Work.Attention.DONE, 2, Steps.Verdict.STOPPED),
            ),
            projects = emptyList(),
        )
        val groups = Work.ByProof(work)
        // At work before queued, however recent; then the latest first.
        assertEquals(listOf("running", "queued"), groups.working.map { it.id })
        assertEquals(listOf("proven-new", "proven-old"), groups.proven.map { it.id })
        assertEquals(listOf("failed-new", "gave-up", "sent-back"), groups.failed.map { it.id })
        // (A tie is broken by its id, so every app orders it the same.)
        assertEquals(listOf("reviewed", "stopped"), groups.done.map { it.id })
    }
}
