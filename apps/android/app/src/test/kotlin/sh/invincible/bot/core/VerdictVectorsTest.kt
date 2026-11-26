package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A task's verdict in words that follow its proof (the PWA's verdictOf, the iPhone's Steps.verdict; the owner's word, 26
 * November 2026: never "Verified" above a warning that its gates proved nothing), held to the vectors' `verdicts`: each
 * task as the node sends it, its record's proof read as the facts it keeps, and the word and verdict core gives.
 */
class VerdictVectorsTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    @Test fun eachTaskIsJudgedAsCoreJudgesIt() {
        val cases = v["verdicts"].list
        assertTrue(cases.size >= 15)
        for (case in cases) {
            val task = TeamTask.of(case["task"]!!)
            val got = Steps.verdict(task.status, task.verified, task.error, task.record, Steps.facts(task.record))
            val want = case["verdict"]
            val name = "${task.status} ${case["task"]["record"]?.text()}"
            if (want["word"].string == null) {
                assertNull(name, got)
            } else {
                assertEquals(name, want["word"].string, got?.word)
                assertEquals(name, want["verdict"].string, got?.verdict?.wire)
            }
        }
    }

    @Test fun whatAVerdictRestsOnIsNeverItsWordAgain() {
        // The iPhone's TaskThreadTests, case for case.
        assertNull(TaskWords.because("It gave up.", "Gave up"))
        assertNull(TaskWords.because("Stopped.", "Stopped"))
        assertEquals("Its gates or the independent review did not pass.", TaskWords.because("Not verified: its gates or the independent review did not pass.", "Not verified"))
        assertEquals("bun test db/ exited 1 at the end", TaskWords.because("bun test db/ exited 1 at the end", "Failed · gate 1"))
        assertNull(TaskWords.because(null, "Proven"))
        assertNull(TaskWords.because("", "Failed"))
    }

    @Test fun aTaskWhoseGatesProvedNothingIsNeverSaidToBeProven() {
        // Every gate passing before the work as after it: the reviewer's pass is all there is.
        val record = TeamTask.Record(0, 1_000, "done", emptyList(), TeamTask.Record.Proof(listOf(0, 0), listOf(0, 0), "pass", false))
        assertEquals("Reviewed, not proven", Steps.verdict("done", true, null, record, Steps.facts(record))?.word)
    }
}
