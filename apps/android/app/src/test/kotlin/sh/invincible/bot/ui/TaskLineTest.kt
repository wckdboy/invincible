package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * An agent's tasks, each a line shorter (AgentScreen's TaskCard): its title and how it stands in a word on one line, then
 * its latest step, or how it ended, and what it kept. On the emulator (27 November 2026) each of a fleet's gave-up tasks
 * said "Gave up" beside its title and "gave up" again in red under it: the run's error ("gave-up") in words, the same as
 * its word. It is said once; where the word says how it ended, the line under it is what is left to say, its latest step,
 * as where a task ended with no error given.
 */
class TaskLineTest {
    @Test fun aTaskThatGaveUpSaysSoOnce() {
        assertNull(taskLine("failed", "Gave up", "gave-up", null, null))
        assertEquals(TaskLine("Ran bun test db/", failed = false), taskLine("failed", "Gave up", "gave-up", "Ran bun test db/\nand what it printed", null))
        assertEquals(TaskLine("2 files kept", failed = false), taskLine("failed", "Gave up", "gave-up", null, 2))
    }

    @Test fun whyItEndedIsSaidInRedWhereItsWordDoesntSayIt() {
        assertEquals(TaskLine("the gate's database refused the connection", failed = true), taskLine("failed", "Failed", "the gate's database refused the connection\nat connect", "Ran bun test db/", null))
        assertEquals(TaskLine("not verified · 1 file kept", failed = true), taskLine("stopped", "Stopped", "unverified", null, 1))
    }

    @Test fun workUnderWaySaysItsLatestStepAndWhatItKept() {
        assertEquals(TaskLine("Ran printf done · 2 files kept", failed = false), taskLine("running", "Working", null, "Ran printf done", 2))
        assertNull(taskLine("queued", "Queued", null, "  ", null))
    }
}
