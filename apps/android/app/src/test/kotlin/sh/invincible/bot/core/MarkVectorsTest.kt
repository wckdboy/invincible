package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An agent's mark, the Grille (AgentMark), held to core's agent-mark.ts through the vectors' `marks`: its palette and
 * the colours of its states, its forms, the marks a node gives fifteen agents in the order they join, a chosen colour,
 * the snap (OKLCH: sRGB's levels in linear light, 53 colours and an 18-level grid), the saved profiles, its sines and
 * cosines, and its slats' geometry and colours in 108 cases (two forms, every state, two sizes, both themes, still and
 * moving, arriving and settled), all to the last bit.
 */
class MarkVectorsTest {
    private val m = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["marks"]

    private fun paired(j: Json?) = AgentMark.Paired(j["light"].string!!, j["dark"].string!!)
    private fun mark(j: Json?) = AgentMark.Mark(j["color"].int!!, j["form"].int!!)

    @Test fun itsPaletteAndItsStatesColoursAreCores() {
        assertEquals(m["palette"].list.map { AgentMark.Hue(it["name"].string!!, it["light"].string!!, it["dark"].string!!) }, AgentMark.PALETTE)
        assertEquals(m["queued"].list.map(::paired), AgentMark.QUEUED)
        assertEquals(paired(m["paused"]), AgentMark.PAUSED)
        assertEquals(paired(m["page"]), AgentMark.PAGE)
        assertEquals(paired(m["ink"]), AgentMark.INK)
        assertEquals(paired(m["red"]), AgentMark.RED)
    }

    @Test fun itsFormsTimingAndStatesAreCores() {
        assertEquals(m["forms"].list.map { AgentMark.Form(it["slots"].int!!, it["angle"].int!!) }, (0 until AgentMark.FORMS).map(AgentMark::form))
        val timing = m["timing"]
        assertEquals(timing["workCycle"].double!!, AgentMark.WORK_CYCLE, 0.0)
        assertEquals(timing["needsBeat"].double!!, AgentMark.NEEDS_BEAT, 0.0)
        assertEquals(timing["doneSettle"].double!!, AgentMark.DONE_SETTLE, 0.0)
        assertEquals(timing["failDrop"].double!!, AgentMark.FAIL_DROP, 0.0)
        assertEquals(m["states"].list.map { it.string }, AgentMark.State.entries.map { it.wire })
        for (c in m["stateOf"].list) assertEquals(c["expression"].string, c["state"].string, AgentMark.state(c["expression"].string).wire)
    }

    @Test fun aNodeGivesFifteenAgentsTheirMarksAsCoreDoesInTheOrderTheyJoin() {
        val given = ArrayList<AgentMark.Mark>()
        for (c in m["given"].list) {
            val id = c["id"].string!!
            assertEquals(id, c["seed"].long, Avatar.handleSeed(id))
            val got = AgentMark.assignMark(id, given.toList())
            assertEquals(id, mark(c), got)
            given += got
        }
        assertEquals(15, given.size)
        for (c in m["chosen"].list) {
            assertEquals(c["id"].string, mark(c["mark"]), AgentMark.assignMark(c["id"].string!!, c["others"].list.map(::mark), c["chosen"].string))
        }
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

    @Test fun itsSinesAndCosinesAreCoresToTheLastBit() {
        for (c in m["trig"].list) {
            val x = c["x"].double!!
            assertEquals("sin $x", c["sin"].double!!, AgentMark.sin(x), 0.0)
            assertEquals("cos $x", c["cos"].double!!, AgentMark.cos(x), 0.0)
        }
    }

    @Test fun aSavedProfileIsReadStrictly() {
        for (c in m["profiles"].list) {
            val profile = c["profile"]?.takeIf { it !is Json.Null }
            val name = "${c["id"].string} ${profile?.text()}"
            assertEquals(name, c["saved"].bool, AgentMark.isMarkProfile(profile))
            assertEquals(name, mark(c["mark"]), AgentMark.markOf(c["id"].string!!, profile))
        }
    }

    @Test fun itsSlatsAndColoursAreCoresInEveryCase() {
        val cases = m["geometry"].list
        assertEquals(108, cases.size)
        for (c in cases) {
            val state = AgentMark.State.entries.first { it.wire == c["state"].string }
            val name = "${c["id"].string} ${state.wire} ${c["size"].double} ${c["theme"].string} t=${c["t"].double} since=${c["since"].double}"
            val got = AgentMark.geometry(mark(c["mark"]), c["seed"].long!!, state, c["size"].double!!, c["t"].double, c["since"].double)
            val want = c["geometry"]
            assertEquals(name, want["angle"].int, got.angle)
            assertEquals(name, want["radius"].double!!, got.radius, 0.0)
            val slats = want["slats"].list
            assertEquals(name, slats.size, got.slats.size)
            slats.forEachIndexed { i, s ->
                val g = got.slats[i]
                val at = "$name slat $i"
                assertEquals(at, s["from"].double!!, g.from, 0.0)
                assertEquals(at, s["to"].double!!, g.to, 0.0)
                assertEquals(at, s["slide"].double!!, g.slide, 0.0)
                assertEquals(at, s["fill"].string == "key", g.key)
                assertEquals(at, s["drop"].double!!, g.drop, 0.0)
                assertEquals(at, s["turn"].double!!, g.turn, 0.0)
                assertEquals(at, s["pivot"].list[0].double!!, g.pivotX, 0.0)
                assertEquals(at, s["pivot"].list[1].double!!, g.pivotY, 0.0)
            }
            val colors = AgentMark.colors(mark(c["mark"]).color, state, c["theme"].string == "dark")
            assertEquals(name, c["colors"]["body"].string, colors.body)
            assertEquals(name, c["colors"]["key"].string, colors.key)
        }
    }
}
