package sh.invincible.bot.core

import org.junit.Assert.assertTrue

/** The parity vectors, read once for every test that holds the app to them, and how a number in them is compared. */
internal object Fixture {
    val vectors: Json by lazy { Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText()) }

    /** A number as the vectors hold it: to a billionth of itself (or of 1, for small ones). */
    fun near(want: Double?, got: Double, at: String) {
        requireNotNull(want) { "$at: no number in the vectors" }
        assertTrue("$at: $got ≠ $want", kotlin.math.abs(want - got) <= 1e-9 * maxOf(1.0, kotlin.math.abs(want), kotlin.math.abs(got)))
    }

    fun numbers(j: Json?): List<Double> = j.list.map { it.double!! }
}
