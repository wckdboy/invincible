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
        assertEquals(13, cases.size)
        for (c in cases) assertEquals("${c["task"]}", c["words"].string, Loops.describeTask(c["task"]?.takeIf { it != Json.Null }))
    }

    @Test fun whatWakesItIsSaidAsTheWebSaysIt() {
        for (c in loops["wakes"].list) assertEquals("${c["wakes"]}", c["words"].string, Loops.describeWakes(c["wakes"].list, c["cooldownMs"].double))
    }

    @Test fun aNumberIsWrittenAsJavaScriptWritesIt() {
        assertEquals(listOf("2", "1.5", "0", "1e+21", "1e-7", "123", "0.1", "0.000001", "12345678.5"), listOf(2.0, 1.5, -0.0, 1e21, 1e-7, 123.0, 0.1, 1e-6, 12345678.5).map(Loops::jsNumber))
    }
}
