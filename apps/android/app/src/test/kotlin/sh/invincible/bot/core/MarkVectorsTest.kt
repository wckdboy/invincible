package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the Grille leaves an agent's glass (AgentMark), held to core's agent-mark.ts through the vectors' `marks`: its
 * palette, each expression's state, the snap of a colour you pick (OKLCH: sRGB's levels in linear light, 53 colours and
 * an 18-level grid), and a saved mark read strictly, all to the last bit.
 */
class MarkVectorsTest {
    private val m = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["marks"]

    private fun mark(j: Json?) = AgentMark.Mark(j["color"].int!!, j["form"].int!!)

    @Test fun itsPaletteAndItsStatesAreCores() {
        assertEquals(m["palette"].list.map { AgentMark.Hue(it["name"].string!!, it["light"].string!!, it["dark"].string!!) }, AgentMark.PALETTE)
        assertEquals(m["states"].list.map { it.string }, AgentMark.State.entries.map { it.wire })
        for (c in m["stateOf"].list) assertEquals(c["expression"].string, c["state"].string, AgentMark.state(c["expression"].string).wire)
    }

    @Test fun aColourSnapsToTheNearestHueOfTheEightNeverToRed() {
        // What it's reckoned from, to the last bit: sRGB's levels in linear light, and the chroma under which it's a grey.
        assertEquals(m["linear"].list.map { it.double!! }, AgentMark.LINEAR.toList())
        assertEquals(m["grey"].double!!, AgentMark.GREY, 0.0)
        val snaps = m["snaps"].list
        assertTrue(snaps.size >= 50)
        for (c in snaps) assertEquals(c["hex"].string, c["color"].int, AgentMark.snapColor(c["hex"].string!!))
        // Every colour of an 18-level grid, red slowest, its snap a digit each (core checks all 2^24; this, the grid).
        val grid = StringBuilder()
        for (r in 0 until 256 step 15) for (g in 0 until 256 step 15) for (b in 0 until 256 step 15) grid.append(AgentMark.snapColor("#%02x%02x%02x".format(r, g, b)))
        assertEquals(m["snapGrid"].string, grid.toString())
    }

    @Test fun aSavedProfileIsReadStrictly() {
        for (c in m["profiles"].list) {
            val profile = c["profile"]?.takeIf { it !is Json.Null }
            val name = "${c["id"].string} ${profile?.text()}"
            assertEquals(name, c["saved"].bool, AgentMark.isMarkProfile(profile))
            assertEquals(name, c["mark"]?.takeIf { it !is Json.Null }?.let(::mark), AgentMark.readMarkProfile(profile))
        }
    }
}
