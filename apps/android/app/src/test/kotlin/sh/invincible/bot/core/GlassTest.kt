package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.invincible.bot.ui.GlassBlur

/**
 * An agent's glass (Glass, GlassData.kt) held to core's glass.ts through the vectors' `glass`: its shapes path for path,
 * and every point of each as this app reads it; its ramps and the Guardian's; its paint, glow and dot; an agent's glass
 * read from what it has; the glass a node gives fifteen agents in the order they join, and a colour chosen; and the blur
 * its pictures are drawn with, SVG's.
 */
class GlassTest {
    private val g = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["glass"]

    private fun glass(j: Json?) = Glass(j["color"].int!!, j["shape"].int!!)
    private fun stops(j: Json?) = Glass.Stops(j["highlight"].string!!, j["a"].string!!, j["b"].string!!, j["accent"].string!!, j["deep"].string!!)
    private fun ramp(j: Json?) = Glass.Ramp(j["id"].string!!, j["name"].string!!, stops(j["light"]), stops(j["dark"]))
    private fun shape(j: Json?) = Glass.Shape(j["id"].string!!, j["name"].string!!, j["family"].string!!, j["kind"].string == "tube", j["width"].double!!.toFloat(), j["smallWidth"].double!!.toFloat(), j["d"].string!!)
    private fun floats(j: Json?) = j.list.map { it.double!!.toFloat() }

    @Test fun itsShapesAreCoresPathForPath() {
        assertEquals(g["shapes"].list.map(::shape), Glass.SHAPES)
        assertEquals(22, Glass.SHAPES.size)
        assertEquals(shape(g["ibeam"]["glass"]), Glass.IBEAM)
    }

    @Test fun itsPathsAreReadToEveryPointCoreNames() {
        val cases = g["shapes"].list.zip(Glass.SHAPES) + (g["ibeam"]["glass"]!! to Glass.IBEAM)
        for ((core, shape) in cases) {
            val points = Glass.segments(shape.d).flatMap {
                when (it) {
                    is Glass.Segment.Move -> listOf(it.x to it.y)
                    is Glass.Segment.Line -> listOf(it.x to it.y)
                    is Glass.Segment.Quad -> listOf(it.x1 to it.y1, it.x to it.y)
                    is Glass.Segment.Cubic -> listOf(it.x1 to it.y1, it.x2 to it.y2, it.x to it.y)
                    Glass.Segment.Close -> emptyList<Pair<Float, Float>>()
                }
            }
            val box = listOf(points.minOf { it.first }, points.minOf { it.second }, points.maxOf { it.first }, points.maxOf { it.second })
            val bounds = floats(core["bounds"])
            for (n in 0 until 4) assertEquals("${shape.id}: $box against $bounds", bounds[n], box[n], 0.005f)
            // And none left out: a point for every two of its numbers.
            val numbers = Regex("-?\\d*\\.?\\d+").findAll(shape.d).count()
            assertEquals(shape.id, numbers, points.size * 2)
        }
    }

    @Test fun itsRampsAreCores() {
        assertEquals(g["ramps"].list.map(::ramp), Glass.RAMPS)
        assertEquals(AgentMark.PALETTE.size, Glass.RAMPS.size)
        assertEquals(ramp(g["pearl"]), Glass.PEARL)
        assertEquals(g["pearlTile"]["light"].string, Glass.PEARL_TILE)
        assertTrue(g["pearlTile"]["dark"] is Json.Null)
    }

    @Test fun itsPaintItsGlowAndItsDotAreCores() {
        val paint = g["paint"]
        assertEquals(listOf(0f, 0f), floats(paint["blend"]["from"]))
        assertEquals(listOf(100f, 100f), floats(paint["blend"]["to"]))
        val p = Glass.Paint
        fun f(j: Json?) = j.double!!.toFloat()
        assertEquals(floats(paint["accent"]["at"]) + f(paint["accent"]["r"]) + f(paint["accent"]["opacity"]), listOf(p.ACCENT_X, p.ACCENT_Y, p.ACCENT_R, p.ACCENT_OPACITY))
        assertEquals(floats(paint["highlight"]["at"]) + f(paint["highlight"]["r"]), listOf(p.HIGHLIGHT_X, p.HIGHLIGHT_Y, p.HIGHLIGHT_R))
        assertEquals(paint["highlight"]["stops"].list.map { floats(it).let { (at, a) -> at to a } }, p.HIGHLIGHT_STOPS)
        assertEquals(floats(paint["shade"]["at"]) + f(paint["shade"]["r"]), listOf(p.SHADE_X, p.SHADE_Y, p.SHADE_R))
        assertEquals(paint["shade"]["opacity"]["light"].double!!.toFloat(), p.shadeOpacity(false), 0f)
        assertEquals(paint["shade"]["opacity"]["dark"].double!!.toFloat(), p.shadeOpacity(true), 0f)

        val glow = g["glow"]
        val G = Glass.Glow
        val pool = glow["pool"]
        assertEquals(listOf(pool["minSize"], pool["spread"], pool["opacity"]["dark"], pool["opacity"]["light"], pool["breathe"]).map { it.double!!.toFloat() }, listOf(G.POOL_FROM, G.POOL_SPREAD, G.POOL_OPACITY, 0f, G.POOL_BREATHE))
        assertEquals(pool["stops"].list.map { Triple(it.list[0].double!!.toFloat(), it.list[1].string == "b", it.list[2].double!!.toFloat()) }, G.POOL_STOPS)
        val shadow = glow["shadow"]
        assertEquals(listOf(shadow["minSize"], shadow["opacity"]["light"], shadow["opacity"]["dark"], shadow["breathe"]).map { it.double!!.toFloat() }, listOf(G.SHADOW_FROM, G.SHADOW_OPACITY, 0f, G.SHADOW_BREATHE))
        assertEquals(listOf("left", "right", "top", "bottom").map { shadow["box"][it].double!!.toFloat() }, listOf(G.SHADOW_LEFT, G.SHADOW_RIGHT, G.SHADOW_TOP, G.SHADOW_BOTTOM))
        assertEquals(shadow["stops"].list.map { it.list[0].double!!.toFloat() to it.list[2].double!!.toFloat() }, G.SHADOW_STOPS)
        assertTrue(shadow["stops"].list.all { it.list[1].string == "b" })
        val blur = glow["blur"]
        assertEquals(listOf(blur["minSize"], blur["radius"], blur["opacity"]["light"], blur["opacity"]["dark"], blur["dy"]["light"], blur["dy"]["dark"]).map { it.double!!.toFloat() }, listOf(G.BLUR_FROM, G.BLUR_RADIUS, G.blurOpacity(false), G.blurOpacity(true), G.blurDrop(false), G.blurDrop(true)))
        assertEquals(glow["period"].double!!, G.PERIOD, 0.0)

        val dot = g["dot"]
        for (state in Glass.State.entries) assertEquals(state.wire, AgentMark.Paired(dot["colors"][state.wire]["light"].string!!, dot["colors"][state.wire]["dark"].string!!), Glass.Dot.COLORS[state])
        assertEquals(dot["idleRing"].double!!.toFloat(), Glass.Dot.IDLE_RING, 0f)
        assertEquals(dot["sizes"].list.map { Glass.Dot.Size(it["upTo"].double!!.toFloat(), it["size"].double!!.toFloat(), it["out"].double!!.toFloat(), it["cut"].double!!.toFloat()) }, Glass.Dot.SIZES)
        assertEquals(Glass.Dot.SIZES[1], Glass.Dot.size(20f))
        assertEquals(Glass.Dot.SIZES[3], Glass.Dot.size(96f))
    }

    @Test fun anAgentsGlassIsReadAsCoreReadsIt() {
        for (c in g["reads"].list) {
            val profile = c["profile"]?.takeIf { it !is Json.Null }
            val name = "${c["id"].string} ${profile?.text()}"
            assertEquals(name, glass(c["glass"]), Glass.of(c["id"].string!!, profile))
            assertEquals(name, c["own"].bool, Glass.isGlassProfile(profile))
        }
        assertEquals(g["states"].list.map { it["glass"].string }, AgentMark.State.entries.map { Glass.state(it).wire })
        assertEquals(g["states"].list.map { it["state"].string }, AgentMark.State.entries.map { it.wire })
        // What it saves is what it reads.
        val mine = Glass(5, 12)
        assertEquals(mine, Glass.read(Glass.profile(mine)))
    }

    @Test fun aNodeGivesFifteenAgentsTheirGlassAsCoreDoesInTheOrderTheyJoin() {
        val given = ArrayList<Glass>()
        for (c in g["given"].list) {
            val id = c["id"].string!!
            assertEquals(id, c["seed"].long, Avatar.handleSeed(id))
            val got = Glass.assign(id, given.toList())
            assertEquals(id, glass(c["glass"]), got)
            given += got
        }
        assertEquals(15, given.size)
        // Every family and every colour worn, and no two in a row the same colour.
        assertEquals(Glass.SHAPES.map { it.family }.toSet(), given.map { Glass.SHAPES[it.shape].family }.toSet())
        assertEquals(AgentMark.PALETTE.indices.toSet(), given.map { it.color }.toSet())
        for (c in g["chosen"].list) {
            val chosen = c["chosen"]
            val got = Glass.assign(c["id"].string!!, c["others"].list.map(::glass), chosen.string, if (chosen is Json.Num) chosen.int else null)
            assertEquals("${c["id"].string} ${chosen?.text()}", glass(c["glass"]), got)
        }
    }

    @Test fun itsBlurIsSvgsThreeBoxesEachWayOverPremultipliedColour() {
        // SVG's box width for its standard deviation: 6.5 in a 40 dp avatar's box at 3 pixels a dp.
        assertEquals(15, GlassBlur.width(6.5f * 1.2f))
        assertEquals(12, GlassBlur.width(6.5f))
        assertEquals(1, GlassBlur.width(0.2f))
        for (sigma in listOf(4f, 4.8f)) { // (an even box, 8, and an odd one, 9)
            assertEquals(if (sigma == 4f) 8 else 9, GlassBlur.width(sigma))
            val w = 61
            val h = 61
            // A red square in the middle, on nothing (a green no one sees: its alpha 0, which must not bleed in).
            val src = IntArray(w * h) { i -> if (i % w in 25..35 && i / w in 25..35) 0xffff0000.toInt() else 0x0000ff00 }
            val out = GlassBlur.gaussian(src, w, h, sigma)
            // Its colour stays its own wherever it reaches (no dark fringe), its alpha spread and kept whole, evenly.
            var mass = 0L
            for (i in out.indices) {
                val a = out[i] ushr 24
                mass += a
                if (a > 0) assertEquals("pixel $i", 0xff0000, out[i] and 0xffffff)
            }
            assertEquals(121.0 * 255, mass.toDouble(), 121.0 * 255 * 0.01)
            for (y in 0 until h) for (x in 0 until w) assertEquals("($x, $y)", (out[y * w + x] ushr 24).toDouble(), (out[y * w + (w - 1 - x)] ushr 24).toDouble(), 1.0)
            assertTrue((out[30 * w + 30] ushr 24) in 1..254)
            assertTrue((out[30 * w + 20] ushr 24) > 0 && (out[30 * w + 2] ushr 24) == 0)
        }
    }
}
