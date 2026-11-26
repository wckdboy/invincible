package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Reads the parity vectors where they are (apps/apple/InvincibleTests/Fixtures/core-vectors.json), as VectorsTest does. */
internal object Fixture {
    val vectors: Json by lazy { Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText()) }

    /** A number as the vectors hold it: to a billionth of itself (or of 1, for small ones). */
    fun near(want: Double?, got: Double, at: String) {
        requireNotNull(want) { "$at: no number in the vectors" }
        assertTrue("$at: $got ≠ $want", kotlin.math.abs(want - got) <= 1e-9 * maxOf(1.0, kotlin.math.abs(want), kotlin.math.abs(got)))
    }

    fun numbers(j: Json?): List<Double> = j.list.map { it.double!! }
}

/**
 * The orbs as fields (the PWA's lib/field.ts and lib/field-orb.ts) against the vectors' `field` section: the lights,
 * whose field each orb is, a field's lines and points at given turns, where they fall on a picture, each size's look,
 * its beam, how a field moves in each mood, its embers, tints, tone and inks. Numbers to a billionth, all else exactly.
 */
class FieldVectorsTest {
    private val f = Fixture.vectors["field"]!!
    private fun near(want: Json?, got: Double, at: String) = Fixture.near(want.double, got, at)

    private fun colours(j: Json?): Field.Colours = Field.Colours(j["key"].list.map { it.string!! }, j["rim"].string!!)

    private fun identity(who: String): FieldOrb.Identity = when (who) {
        "primary" -> FieldOrb.PRIMARY
        "ada, chosen" -> FieldOrb.agent("ada", Json.obj("v" to 2, "color" to "#3ABEFF"))
        else -> FieldOrb.agent(who)
    }

    private fun mood(name: String): OrbMotion.Mood = OrbMotion.Mood.valueOf(name.uppercase())

    private fun assertMotion(want: Json?, got: FieldOrb.Motion, at: String) {
        near(want["turn"], got.turn, "$at.turn")
        near(want["glow"], got.glow, "$at.glow")
        near(want["rim"], got.rim, "$at.rim")
        assertEquals("$at.embers", want["embers"].bool, got.embers)
        val breath = want["breath"]
        if (breath == null || breath == Json.Null) assertEquals("$at.breath", null, got.breath)
        else {
            near(breath["period"], got.breath!!.period, "$at.breath.period")
            near(breath["depth"], got.breath.depth, "$at.breath.depth")
        }
    }

    private fun clockOf(j: Json?) = FieldOrb.Clock(
        j["turn"].double!!, j["speed"].double!!, j["glow"].double!!, j["rim"].double!!, j["depth"].double!!, j["breath"].double!!, j["period"].double!!, j["embers"].double!!,
    )

    private fun assertClock(want: Json?, got: FieldOrb.Clock, at: String) {
        for ((name, value) in listOf("turn" to got.turn, "speed" to got.speed, "glow" to got.glow, "rim" to got.rim, "depth" to got.depth, "breath" to got.breath, "period" to got.period, "embers" to got.embers)) {
            near(want[name], value, "$at.$name")
        }
    }

    private fun assertFrame(want: Json?, got: FieldOrb.Frame, at: String) {
        near(want["turn"], got.turn, "$at.turn")
        near(want["glow"], got.glow, "$at.glow")
        near(want["rim"], got.rim, "$at.rim")
        val embers = want["embers"].list
        assertEquals("$at.embers", embers.size, got.embers.size)
        embers.forEachIndexed { i, e ->
            near(e["x"], got.embers[i].x, "$at.embers[$i].x")
            near(e["y"], got.embers[i].y, "$at.embers[$i].y")
            near(e["r"], got.embers[i].r, "$at.embers[$i].r")
            near(e["alpha"], got.embers[i].alpha, "$at.embers[$i].alpha")
        }
    }

    @Test fun theLightsAreThePwas() {
        val lights = f["lights"]
        Fixture.numbers(lights["key"]).forEachIndexed { i, v -> Fixture.near(v, Field.KEY[i], "key[$i]") }
        Fixture.numbers(lights["rim"]).forEachIndexed { i, v -> Fixture.near(v, Field.RIM[i], "rim[$i]") }
        near(lights["exposure"], FieldOrb.EXPOSURE, "exposure")
    }

    @Test fun whoseFieldEachOrbIs() {
        val g = f["primary"]
        assertEquals(g["seed"].long, FieldOrb.PRIMARY.seed)
        assertEquals(g["lines"].int, FieldOrb.PRIMARY.lines)
        Fixture.numbers(g["tilt"]).forEachIndexed { i, v -> Fixture.near(v, FieldOrb.PRIMARY.tilt[i], "primary.tilt[$i]") }
        assertEquals(colours(g["colours"]), FieldOrb.PRIMARY.colours)
        for (k in f["agents"].list) {
            val handle = k["handle"].string!!
            val profile = k["profile"].takeIf { it != Json.Null }
            val got = FieldOrb.agent(handle, profile)
            val want = k["field"]
            assertEquals(handle, want["seed"].long, got.seed)
            assertEquals(handle, want["lines"].int, got.lines)
            Fixture.numbers(want["tilt"]).forEachIndexed { i, v -> Fixture.near(v, got.tilt[i], "$handle.tilt[$i]") }
            assertEquals(handle, colours(want["colours"]), got.colours)
        }
    }

    @Test fun linearLightAndShades() {
        for (c in f["linear"].list) {
            val got = Field.linear(c["hex"].string!!)
            Fixture.numbers(c["rgb"]).forEachIndexed { i, v -> Fixture.near(v, got[i], "${c["hex"].string}[$i]") }
        }
        f["shades"].list.forEachIndexed { at, c ->
            val n = Fixture.numbers(c["n"])
            val s = Field.shade(n[0], n[1], n[2], Field.light(colours(c["colours"])))
            val want = c["shade"]
            val rgb = Fixture.numbers(want["rgb"])
            Fixture.near(rgb[0], s.r, "shades[$at].r")
            Fixture.near(rgb[1], s.g, "shades[$at].g")
            Fixture.near(rgb[2], s.b, "shades[$at].b")
            near(want["k"], s.k, "shades[$at].k")
            near(want["lit"], s.lit, "shades[$at].lit")
            near(want["rim"], s.rim, "shades[$at].rim")
        }
    }

    @Test fun eachSeedsLinesAreThePwas() {
        for (m in f["models"].list) {
            val model = Field.model(lines = m["lines"].int!!, steps = 4, seed = m["seed"].long!!)
            Fixture.numbers(m["phi"]).forEachIndexed { i, v -> Fixture.near(v, model.phi[i], "phi[$i] of ${m["seed"].long}") }
            Fixture.numbers(m["width"]).forEachIndexed { i, v -> Fixture.near(v, model.width[i], "width[$i] of ${m["seed"].long}") }
        }
    }

    @Test fun aFieldsPointsAtATurnAreThePwas() {
        for (p in f["points"].list) {
            val who = p["who"].string!!
            val id = identity(who)
            val size = p["size"].double!!
            val primary = p["primary"].bool!!
            val rim = p["rim"].double!!
            val options = p["options"]
            // Its look at its size, and its colours in its rim's light, as the PWA chose them.
            val look = FieldOrb.look(id, size, primary)
            assertEquals(who, options["lines"].int, look.lines)
            near(options["weight"], look.weight, "$who.weight")
            assertEquals(who, colours(options["colours"]), id.colours)
            Fixture.numbers(options["tilt"]).forEachIndexed { i, v -> Fixture.near(v, id.tilt[i], "$who.tilt[$i]") }
            assertEquals(who, options["seed"].long, id.seed)
            val tinted = FieldOrb.colours(id.colours, rim)
            assertEquals(who, colours(p["colours"]), tinted)
            val model = Field.model(look.lines, options["steps"].int!!, id.tilt.toDoubleArray(), look.weight, id.colours, id.seed)
            val out = Field.buffer(model)
            val count = Field.at(model, p["turn"].double!!, out, Field.light(tinted))
            val points = p["points"].list
            assertEquals("$who: how many points", points.size, count)
            points.forEachIndexed { i, q ->
                val at = "$who points[$i]"
                assertEquals(at, q["at"].int, out.at[i])
                near(q["x"], out.x[i], "$at.x")
                near(q["y"], out.y[i], "$at.y")
                near(q["z"], out.z[i], "$at.z")
                val rgb = Fixture.numbers(q["rgb"])
                Fixture.near(rgb[0], out.r[i], "$at.r")
                Fixture.near(rgb[1], out.g[i], "$at.g")
                Fixture.near(rgb[2], out.b[i], "$at.b")
                near(q["size"], out.size[i], "$at.size")
                near(q["lit"], out.lit[i], "$at.lit")
                near(q["rim"], out.rim[i], "$at.rim")
            }
        }
    }

    @Test fun whereAPointFallsOnAPicture() {
        // (The first three sets of points, three sizes each, in order: two of them are the primary's.)
        val points = f["points"].list
        f["projections"].list.forEachIndexed { n, pr ->
            val who = pr["who"].string!!
            val set = points[n / 3]
            assertEquals(who, set["who"].string)
            val source = set["points"].list
            val size = pr["size"].double!!
            val zoom = pr["zoom"].double!!
            pr["shown"].list.forEachIndexed { i, want ->
                val p = source[i]
                val got = Field.project(p["x"].double!!, p["y"].double!!, p["z"].double!!, p["size"].double!!, size, zoom = zoom)
                val at = "$who at $size/$zoom [$i]"
                near(want["x"], got.x, "$at.x")
                near(want["y"], got.y, "$at.y")
                near(want["d"], got.d, "$at.d")
                assertEquals(at, want["visible"].bool, got.visible)
            }
        }
    }

    @Test fun eachSizesLook() {
        for (l in f["looks"].list) {
            val who = l["who"].string!!
            val got = FieldOrb.look(identity(who), l["size"].double!!, l["primary"].bool!!)
            val want = l["look"]
            val at = "$who at ${l["size"].double}"
            assertEquals(at, want["lines"].int, got.lines)
            assertEquals(at, want["steps"].int, got.steps)
            near(want["weight"], got.weight, "$at.weight")
            near(want["zoom"], got.zoom, "$at.zoom")
        }
    }

    @Test fun hisBeamAndTheStrokes() {
        val l = f["beam"]
        near(l["from"], FieldOrb.Beam.FROM, "beam.from")
        near(l["to"], FieldOrb.Beam.TO, "beam.to")
        near(l["width"], FieldOrb.Beam.WIDTH, "beam.width")
        assertEquals(l["steps"].int, FieldOrb.Beam.STEPS)
        near(l["glow"]["width"], FieldOrb.Beam.GLOW_WIDTH, "beam.glow.width")
        near(l["glow"]["alpha"], FieldOrb.Beam.GLOW_ALPHA, "beam.glow.alpha")
        near(l["ink"]["width"], FieldOrb.Beam.INK_WIDTH, "beam.ink.width")
        near(l["ink"]["alpha"], FieldOrb.Beam.INK_ALPHA, "beam.ink.alpha")
        near(l["ink"]["least"], FieldOrb.Beam.INK_LEAST, "beam.ink.least")
        near(l["ink"]["fade"], FieldOrb.Beam.INK_FADE, "beam.ink.fade")
        near(l["ink"]["glow"]["width"], FieldOrb.Beam.INK_GLOW_WIDTH, "beam.ink.glow.width")
        near(l["ink"]["glow"]["alpha"], FieldOrb.Beam.INK_GLOW_ALPHA, "beam.ink.glow.alpha")
        assertEquals(3, l["lines"].list.size)
        for (line in l["lines"].list) {
            val zoom = line["zoom"].double!!
            val got = FieldOrb.beamLine(FieldOrb.PRIMARY, zoom)
            val halves = line["halves"].list
            assertEquals("halves at $zoom", 2, halves.size)
            assertEquals("halves at $zoom", halves.size, got.size)
            halves.forEachIndexed { i, half ->
                Fixture.numbers(half["root"]).forEachIndexed { k, v -> Fixture.near(v, got[i].root[k], "beam at $zoom [$i].root[$k]") }
                Fixture.numbers(half["tip"]).forEachIndexed { k, v -> Fixture.near(v, got[i].tip[k], "beam at $zoom [$i].tip[$k]") }
            }
        }
        assertTrue(l["along"].list.size >= 5)
        for (a in l["along"].list) {
            val u = a["u"].double!!
            val got = FieldOrb.beamAt(u)
            near(a["width"], got.width, "beam at u $u: width")
            near(a["light"], got.light, "beam at u $u: light")
            near(a["hue"], got.hue, "beam at u $u: hue")
        }
        val s = f["stroke"]
        near(s["least"], FieldOrb.Stroke.LEAST, "least")
        near(s["more"], FieldOrb.Stroke.MORE, "more")
        near(s["glow"]["width"], FieldOrb.Stroke.GLOW_WIDTH, "glow.width")
        near(s["glow"]["alpha"], FieldOrb.Stroke.GLOW_ALPHA, "glow.alpha")
        near(s["ink"], FieldOrb.Stroke.INK, "ink")
        near(s["inkLeast"], FieldOrb.Stroke.INK_LEAST, "inkLeast")
        near(s["light"], FieldOrb.Stroke.LIGHT, "light")
        near(s["full"], FieldOrb.Stroke.FULL, "full")
        for (l in s["lights"].list) near(l["light"], FieldOrb.strokeLight(l["size"].double!!), "light at ${l["size"].double}")
    }

    @Test fun howAFieldMovesInEachMood() {
        val motion = f["motion"].fields
        assertEquals(motion.keys, OrbMotion.Mood.entries.map { it.wire }.toSet())
        for ((name, want) in motion) assertMotion(want, FieldOrb.motion(mood(name), agent = false), "motion.$name")
        for ((name, want) in f["agentMotion"].fields) assertMotion(want, FieldOrb.motion(mood(name), agent = true), "agentMotion.$name")
        near(f["ease"], FieldOrb.EASE, "ease")
        val e = f["embers"]
        assertEquals(e["count"].int, FieldOrb.Embers.COUNT)
        for ((key, pair) in listOf("life" to (FieldOrb.Embers.LIFE_FROM to FieldOrb.Embers.LIFE_TO), "from" to (FieldOrb.Embers.FROM_FROM to FieldOrb.Embers.FROM_TO), "drift" to (FieldOrb.Embers.DRIFT_FROM to FieldOrb.Embers.DRIFT_TO), "size" to (FieldOrb.Embers.SIZE_FROM to FieldOrb.Embers.SIZE_TO))) {
            near(e[key][0], pair.first, "embers.$key[0]")
            near(e[key][1], pair.second, "embers.$key[1]")
        }
        near(e["rise"], FieldOrb.Embers.RISE, "embers.rise")
        near(e["fadeIn"], FieldOrb.Embers.FADE_IN, "embers.fadeIn")
        near(e["spread"], FieldOrb.Embers.SPREAD, "embers.spread")
        near(e["rimAngle"], FieldOrb.RIM_ANGLE, "rimAngle")
    }

    @Test fun clocksStepsAndFrames() {
        for (c in f["clocks"].list) {
            val m = FieldOrb.MOTION.getValue(mood(c["mood"].string!!))
            assertClock(c["clock"], FieldOrb.clock(m), "clock ${c["mood"].string}")
            assertFrame(c["still"], FieldOrb.still(m), "still ${c["mood"].string}")
        }
        // A clock taken through moods a step at a time, its and an agent's, from idle.
        var clock: FieldOrb.Clock? = null
        var agent: Boolean? = null
        f["steps"].list.forEachIndexed { i, s ->
            val k = s["agent"].bool!!
            if (k != agent) {
                agent = k
                clock = FieldOrb.clock(FieldOrb.motion(OrbMotion.Mood.IDLE, k))
            }
            val motion = FieldOrb.motion(mood(s["mood"].string!!), k)
            clock = FieldOrb.step(clock!!, motion, s["dt"].double!!)
            assertClock(s["clock"], clock, "steps[$i]")
            assertEquals("steps[$i].fps", s["fps"].int, FieldOrb.fps(clock, motion))
        }
        f["frames"].list.forEachIndexed { i, fr ->
            val got = FieldOrb.frame(clockOf(fr["clock"]), fr["t"].double!!, fr["seed"].long!!, fr["embers"].bool!!)
            assertFrame(fr["frame"], got, "frames[$i]")
        }
    }

    @Test fun tintsToneAndInks() {
        val t = f["tints"]
        assertEquals(t["dim"].string, FieldOrb.RIM_DIM)
        for (r in t["rims"].list) {
            val rim = r["rim"].double!!
            assertEquals("aurum at $rim", colours(r["aurum"]), FieldOrb.colours(Field.AURUM, rim))
            assertEquals("coder at $rim", colours(r["coder"]), FieldOrb.colours(FieldOrb.agent("coder").colours, rim))
        }
        f["tones"].list.forEachIndexed { i, c ->
            val rgb = Fixture.numbers(c["rgb"])
            val got = FieldOrb.tone(rgb[0], rgb[1], rgb[2], c["exposure"].double!!)
            Fixture.numbers(c["shown"]).forEachIndexed { k, v -> Fixture.near(v, got[k], "tones[$i][$k]") }
        }
        for (c in f["inks"].list) {
            val inks = FieldOrb.inks(colours(c["colours"]))
            assertEquals(c["inks"]["key"].list.map { it.int }, inks.key.toList())
            assertEquals(c["inks"]["rim"].list.map { it.int }, inks.rim.toList())
            assertEquals(c["inks"]["sheen"].list.map { it.int }, inks.sheen.toList())
            for (s in c["shown"].list) {
                val ink = FieldOrb.ink(inks, s["lit"].double!!, s["rim"].double!!)
                val want = s["ink"]
                val rgb = Fixture.numbers(want["rgb"])
                Fixture.near(rgb[0], ink.r, "ink.r")
                Fixture.near(rgb[1], ink.g, "ink.g")
                Fixture.near(rgb[2], ink.b, "ink.b")
                near(want["alpha"], ink.alpha, "ink.alpha")
            }
        }
        // A colour as an ink on the light page (26 November 2026): its hue kept, more saturated, as light as its contrast
        // allows; and the model's own numbers.
        val ink = f["ink"]
        near(ink["key"], FieldOrb.Ink.KEY, "ink.key")
        near(ink["rim"], FieldOrb.Ink.RIM, "ink.rim")
        near(ink["sheen"]["contrast"], FieldOrb.Ink.SHEEN_CONTRAST, "ink.sheen.contrast")
        near(ink["sheen"]["from"], FieldOrb.Ink.SHEEN_FROM, "ink.sheen.from")
        near(ink["sheen"]["most"], FieldOrb.Ink.SHEEN_MOST, "ink.sheen.most")
        near(ink["chroma"], FieldOrb.Ink.CHROMA, "ink.chroma")
        near(ink["floor"], FieldOrb.Ink.FLOOR, "ink.floor")
        near(ink["curve"], FieldOrb.Ink.CURVE, "ink.curve")
        assertTrue(ink["of"].list.size >= 24)
        for (o in ink["of"].list) {
            val hex = o["hex"].string!!
            val contrast = o["contrast"].double!!
            assertEquals("$hex at $contrast", o["rgb"].list.map { it.int }, FieldOrb.inkOf(hex, contrast).toList())
        }
    }

    /** As a frame draws a point's ink on a light page (making nothing): the same colour, its opacity within a thousandth. */
    @Test fun aFramesInkIsTheInksWithinAThousandth() {
        val out = DoubleArray(4)
        for (colours in listOf(Field.AURUM, FieldOrb.agent("ada").colours, FieldOrb.agent("coder").colours)) {
            val inks = FieldOrb.inks(colours)
            for ((lit, rim) in listOf(0.0 to 0.0, 0.2 to 0.05, 0.5 to 0.5, 0.8 to 0.0, 1.0 to 0.0, 0.0 to 1.0, 0.37 to 0.61)) {
                FieldOrb.inkInto(inks, lit, rim, out)
                val exact = FieldOrb.ink(inks, lit, rim)
                for ((c, want) in listOf(exact.r, exact.g, exact.b).withIndex()) assertEquals("$lit/$rim [$c]", want, out[c], 1e-9)
                assertTrue("$lit/$rim alpha ${out[3]} vs ${exact.alpha}", kotlin.math.abs(out[3] - exact.alpha) < 0.001)
            }
            // The far lines faint but there, and whole where fully lit.
            assertEquals(FieldOrb.Ink.FLOOR, FieldOrb.ink(inks, 0.0, 0.0).alpha, 0.0)
            assertEquals(1.0, FieldOrb.ink(inks, 1.0, 0.0).alpha, 0.0)
        }
    }

    /** Nothing moves at rest (your word, 26 November 2026: "nothing animating at rest"): its orb idle, done, queued, paused
     * or failed is still and asks for no frame; at work, its embers drifting, 20 a second, and 30 only while a mood arrives. */
    @Test fun nothingMovesAtRest() {
        for (mood in listOf(OrbMotion.Mood.IDLE, OrbMotion.Mood.DONE, OrbMotion.Mood.QUEUED, OrbMotion.Mood.PAUSED, OrbMotion.Mood.FAILED)) {
            val motion = FieldOrb.motion(mood, agent = false)
            assertEquals("$mood turns", 0.0, motion.turn, 0.0)
            assertEquals("$mood breathes", null, motion.breath)
            assertEquals("$mood fps", 0, FieldOrb.fps(FieldOrb.clock(motion), motion))
        }
        val working = FieldOrb.motion(OrbMotion.Mood.WORKING, agent = false)
        assertEquals(20, FieldOrb.fps(FieldOrb.clock(working), working))
        val waiting = FieldOrb.motion(OrbMotion.Mood.WAITING, agent = false)
        assertEquals(20, FieldOrb.fps(FieldOrb.clock(waiting), waiting))
        // At work, then done: it eases to a stop (30 while it eases), then asks for none.
        val done = FieldOrb.motion(OrbMotion.Mood.DONE, agent = false)
        var clock = FieldOrb.clock(working)
        repeat(6) { clock = FieldOrb.step(clock, done, 1.0 / 30) }
        assertEquals(30, FieldOrb.fps(clock, done))
        repeat(600) { clock = FieldOrb.step(clock, done, 1.0 / 30) }
        assertEquals(0, FieldOrb.fps(clock, done))
    }

    /** No line inside the core, and none where the lights leave it dark: what reads as a bright middle never is drawn. */
    @Test fun theCoreStaysDark() {
        for (identity in listOf(FieldOrb.PRIMARY, FieldOrb.agent("ada"), FieldOrb.agent("coder"))) {
            val model = Field.model(identity.lines, 96, identity.tilt.toDoubleArray(), 1.0, identity.colours, identity.seed)
            val out = Field.buffer(model)
            for (turn in listOf(0.0, 1.0, 2.5)) {
                val count = Field.at(model, turn, out)
                assertTrue(count > 0)
                for (i in 0 until count) {
                    val r = kotlin.math.sqrt(out.x[i] * out.x[i] + out.y[i] * out.y[i] + out.z[i] * out.z[i]) / 1.05
                    assertTrue("a point inside the core at r $r", r >= 0.32 - 1e-9)
                }
            }
        }
    }
}
