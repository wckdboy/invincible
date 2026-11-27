package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A loop it drafted, in Needs you: its task and what wakes it in the web's words (lib/loops.ts, lib/wakes.ts), held to
 * the vectors' `loops`.
 */
class LoopsVectorsTest {
    private val loops = Fixture.vectors["loops"]

    @Test fun aTaskIsSaidAsTheWebSaysIt() {
        val cases = loops["tasks"].list
        assertEquals(17, cases.size)
        for (c in cases) assertEquals("${c["task"]}", c["words"].string, Loops.describeTask(c["task"]?.takeIf { it != Json.Null }))
    }

    @Test fun whatWakesItIsSaidAsTheWebSaysIt() {
        for (c in loops["wakes"].list) assertEquals("${c["wakes"]}", c["words"].string, Loops.describeWakes(c["wakes"].list, c["cooldownMs"].double))
    }

    @Test fun aNumberIsWrittenAsJavaScriptWritesIt() {
        assertEquals(listOf("2", "1.5", "0", "1e+21", "1e-7", "123", "0.1", "0.000001", "12345678.5"), listOf(2.0, 1.5, -0.0, 1e21, 1e-7, 123.0, 0.1, 1e-6, 12345678.5).map(Loops::jsNumber))
        // Past 2^53 its shortest digits and zeros, never its exact value; from 1e-6 to 1e-4 in figures (the vectors' calls
        // hold more).
        assertEquals(listOf("12345678901234567000", "18446744073709552000", "0.00001", "0.0000015", "-0.00005"), listOf(1.2345678901234567890e19, 18446744073709551616.0, 1e-5, 1.5e-6, -5e-5).map(Loops::jsNumber))
    }
}
