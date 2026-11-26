package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What a task's page says beside its proof, so nothing is said twice and nothing says "0" for a time (the iPhone's I9:
 * TaskThreadTests and its gate line). Seen on the emulator (27 November 2026): a proven task's page said "Writer said
 * Verified." under its own "Proven", "worked for 0s", and its gate "exit 0 · 0:00".
 */
class ProofWordsTest {
    @Test fun anAgentsBareClaimIsNotShownBesideItsProof() {
        for (claim in listOf("Verified.", "verified", "Done.", "DONE", "Proven!", "Passed.", "Complete.", "Finished.", " Verified. ")) {
            assertNull(claim, TaskWords.saidBesideProof(claim))
        }
        // What says more than the verdict is the agent's own account, shown as its words.
        val account = "The gate needs a Postgres this VM does not have: `bun test db/` exits 1 before any work."
        assertEquals(account, TaskWords.saidBesideProof(account))
        assertEquals("Verified: the importer reads both forms now.", TaskWords.saidBesideProof("Verified: the importer reads both forms now."))
        assertNull(TaskWords.saidBesideProof(null))
        assertNull(TaskWords.saidBesideProof("  "))
    }

    @Test fun aGatesTimeIsSaidToThePrecisionItNeedsNever0Colon00() {
        assertEquals("0 ms", TaskWords.took(0))
        assertEquals("340 ms", TaskWords.took(340))
        assertEquals("4.2 s", TaskWords.took(4_200))
        assertEquals("2m 05s", TaskWords.took(125_000))
    }

    @Test fun howAGateStoodBeforeTheWork() {
        assertEquals("failed before the work", TaskWords.before(before = 1, exit = 0))
        assertEquals("failed before the work too", TaskWords.before(before = 1, exit = 1))
        assertEquals("passed before the work too", TaskWords.before(before = 0, exit = 0))
        assertNull(TaskWords.before(before = null, exit = 0))
    }

    @Test fun aRunOfUnderHalfASecondSaysNoTime() {
        assertEquals("Writer worked", TaskWords.worked("Writer", 0))
        assertEquals("Writer worked", TaskWords.worked("Writer", 499))
        assertEquals("Writer worked for 6m 12s", TaskWords.worked("Writer", 372_000))
    }
}
