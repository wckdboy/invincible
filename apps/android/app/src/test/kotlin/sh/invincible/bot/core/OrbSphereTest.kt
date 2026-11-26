package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * An orb's sphere of glyphs, as the PWA has it (lib/orb-sphere.ts, through the parity vectors' `orb.sphere`): each
 * handle's sphere, its points, its glyphs as they change, what is seen of them at a moment (to a billionth, back to
 * front), its shades on a dark page and on paper, an agent's arcs and the primary's data ring.
 */
class OrbSphereTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["orb"]!!["sphere"]!!

    private fun num(j: Json?): Double = j.double ?: error("not a number: $j")
    private fun close(what: String, theirs: Double, mine: Double) = assertTrue("$what: $theirs ≠ $mine", abs(theirs - mine) <= 1e-9)
    private fun mood(wire: String?): OrbMotion.Mood = OrbMotion.Mood.entries.first { it.wire == wire }
    private fun level(wire: String?): Orb.Level = Orb.Level.entries.first { it.wire == wire }

    @Test fun anAgentsSphereAtEachSizeAndItsGlyphsAreThePWAs() {
        assertEquals(v["agent"].fields.keys, Orb.Level.entries.map { it.wire }.toSet())
        for ((wire, theirs) in v["agent"].fields) {
            val mine = OrbSphere.AGENT.getValue(level(wire))
            assertEquals(wire, theirs["count"].int, mine.count)
            assertEquals(wire, listOf(num(theirs["glyph"]), num(theirs["r"]), num(theirs["nucleus"])), listOf(mine.glyph, mine.r, mine.nucleus))
        }
        assertEquals(num(v["turn"]), OrbSphere.TURN, 0.0)
        assertEquals(v["ladder"].list.map { rung -> rung.list.map { it.string } }, OrbSphere.LADDER)
        assertEquals(v["data"].string, OrbSphere.DATA)
        assertEquals(v["flash"].fields.keys, OrbMotion.Mood.entries.map { it.wire }.toSet())
        for ((wire, flash) in v["flash"].fields) assertEquals(wire, num(flash), OrbSphere.FLASH.getValue(mood(wire)), 0.0)
    }

    @Test fun eachHandleMakesThePWAsSphere() {
        assertTrue(v["spheres"].list.size >= 5)
        for (s in v["spheres"].list) {
            val handle = s["handle"].string!!
            val theirs = s["sphere"]
            val mine = OrbSphere.sphere(handle)
            assertEquals(handle, theirs["seed"].long, mine.seed)
            assertEquals(handle, theirs["spin"].int, mine.spin)
            close("$handle tilt", num(theirs["tilt"]), mine.tilt)
            close("$handle phase", num(theirs["phase"]), mine.phase)
            close("$handle share", num(theirs["share"]), mine.share)
        }
    }

    @Test fun itsPointsAreThePWAs() {
        for (c in v["points"].list) {
            val handle = c["handle"].string!!
            val theirs = c["points"].list
            val mine = OrbSphere.points(OrbSphere.sphere(handle), c["count"].int!!)
            assertEquals(handle, theirs.size, mine.size)
            for ((i, p) in theirs.withIndex()) {
                for ((name, value) in listOf("x" to mine[i].x, "y" to mine[i].y, "z" to mine[i].z, "size" to mine[i].size)) close("$handle point $i $name", num(p[name]), value)
                assertEquals("$handle point $i second", p["second"].bool, mine[i].second)
            }
        }
    }

    @Test fun eachGlyphIsThePWAsAtTheSameMoment() {
        assertTrue(v["glyphs"].list.any { it["glyph"]["data"].bool == true })
        for (g in v["glyphs"].list) {
            val what = g.text()
            val theirs = g["glyph"]
            val mine = OrbSphere.glyph(g["seed"].long!!, g["i"].int!!, g["level"].int!!, num(g["t"]), num(g["flash"]))
            assertEquals(what, theirs["char"].string, mine.char)
            assertEquals(what, theirs["data"].bool, mine.data)
            close("$what fade", num(theirs["fade"]), mine.fade)
        }
    }

    @Test fun eachFrameShowsThePWAsGlyphsBackToFront() {
        val frames = v["frames"].list
        assertTrue(frames.size >= 5)
        // Among them: a failed sphere sagging, one on paper, the primary's own, and data shown.
        assertTrue(frames.any { it["mood"].string == "failed" } && frames.any { it["paper"].bool == true } && frames.any { it["handle"].string == "primary" })
        for (f in frames) {
            val handle = f["handle"].string!!
            val paper = f["paper"].bool == true
            val what = "$handle turned ${num(f["angle"])}, ${f["mood"].string}${if (paper) ", on paper" else ""}"
            val sphere = OrbSphere.sphere(handle)
            val mine = OrbSphere.frame(sphere, OrbSphere.points(sphere, f["count"].int!!), num(f["angle"]), num(f["radius"]), num(f["scale"]), num(f["glyph"]), num(f["t"]), mood(f["mood"].string), paper)
            val theirs = f["shown"].list
            assertEquals(what, theirs.size, mine.size)
            // Back to front; where two neighbours are as near as makes no difference (within a billionth), either may come first.
            var n = 0
            while (n < theirs.size) {
                if (matches(theirs[n], mine[n])) {
                    n += 1
                    continue
                }
                val tied = n + 1 < theirs.size && abs(num(theirs[n]["near"]) - num(theirs[n + 1]["near"])) <= 1e-9
                if (tied && matches(theirs[n], mine[n + 1]) && matches(theirs[n + 1], mine[n])) {
                    n += 2
                    continue
                }
                check("$what glyph $n", theirs[n], mine[n])
                error("$what glyph $n: ${theirs[n].text()} is not ${mine[n]}")
            }
        }
    }

    private fun matches(theirs: Json, mine: OrbSphere.Shown): Boolean =
        listOf(theirs["x"] to mine.x, theirs["y"] to mine.y, theirs["near"] to mine.near, theirs["size"] to mine.size, theirs["alpha"] to mine.alpha).all { (t, m) -> abs(num(t) - m) <= 1e-9 } &&
            theirs["shade"].int == mine.shade && theirs["second"].bool == mine.second && theirs["char"].string == mine.char && theirs["data"].bool == mine.data

    private fun check(what: String, theirs: Json, mine: OrbSphere.Shown) {
        for ((name, value) in listOf("x" to mine.x, "y" to mine.y, "near" to mine.near, "size" to mine.size, "alpha" to mine.alpha)) close("$what $name", num(theirs[name]), value)
        assertEquals("$what shade", theirs["shade"].int, mine.shade)
        assertEquals("$what second", theirs["second"].bool, mine.second)
        assertEquals("$what char", theirs["char"].string, mine.char)
        assertEquals("$what data", theirs["data"].bool, mine.data)
    }

    @Test fun eachColoursShadesAreThePWAs() {
        for (c in v["shades"].list) {
            assertEquals(c.text(), c["shades"].list.map { it.string }, OrbSphere.shades(c["ink"].string!!, c["light"].string!!, c["deep"].string!!))
            assertEquals(c.text(), c["paper"].list.map { it.string }, OrbSphere.paperShades(c["ink"].string!!, c["deep"].string!!))
        }
    }

    @Test fun eachAgentsArcsAreThePWAs() {
        val all = v["arcs"].list
        assertTrue(all.any { it["arcs"].list.size == 2 } && all.any { it["level"].string == "badge" && it["arcs"].list.isEmpty() })
        for (c in all) {
            val what = "${c["handle"].string} ${c["level"].string}"
            val theirs = c["arcs"].list
            val mine = OrbSphere.arcs(OrbSphere.sphere(c["handle"].string!!), level(c["level"].string))
            assertEquals(what, theirs.size, mine.size)
            for ((k, a) in theirs.withIndex()) {
                for ((name, value) in listOf("r" to mine[k].r, "width" to mine[k].width, "from" to mine[k].from, "length" to mine[k].length, "speed" to mine[k].speed)) close("$what arc $k $name", num(a[name]), value)
            }
        }
    }

    @Test fun primaryDataRingIsThePWAs() {
        for (c in v["ring"].list) {
            val what = "${c["seed"].long} at ${num(c["t"])}"
            val places = c["places"].list
            assertEquals(what, 48, places.size)
            assertTrue(what, places.any { it != Json.Null } && places.any { it == Json.Null })
            for ((k, p) in places.withIndex()) {
                val mine = OrbSphere.dataGlyph(c["seed"].long!!, k, num(c["t"]), num(c["share"]))
                if (p == Json.Null) {
                    assertNull("$what place $k", mine)
                } else {
                    assertEquals("$what place $k", p["char"].string, mine?.char)
                    close("$what place $k alpha", num(p["alpha"]), mine!!.alpha)
                }
            }
        }
    }
}
