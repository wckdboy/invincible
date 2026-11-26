package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * An orb as a sphere of glyphs round a bright nucleus: the PWA's lib/orb-sphere.ts, held to it by the vectors (your
 * words, 25 November 2026: "custom/procedurally generated colored particle orbs", "use glyph and randomness on the orbs,
 * like Jarvis/Ultron in the movies, and my other project Phren", "slow and calming movement"). Its points are spread
 * evenly over a sphere turning slowly about an axis that leans towards you; each is a monospace glyph from a ladder of
 * brightness, as Phren's field is (`.` at the back to `@` at the front), the nearer ones larger, lighter and more
 * opaque. Each glyph changes, now and then, on a slow beat of its own, fading a little as it does; and once in a while a
 * few become data (a hex digit), more often while it works. Its handle makes it its own: how far it leans, which way it
 * turns, where it starts, which points are its second colour, and which glyphs it shows when. Its colours are Avatar's
 * agentColors for an agent, and its state's for Invincible (Orb). Pure: everything in the orb's square, 200 wide and
 * centred on its middle (y down); ui/Orb.kt draws it.
 */
object OrbSphere {
    /** An orb's own way of being a sphere, from its handle: how far its axis leans towards you (12 to 32 degrees), which
     * way it turns (1: the near side to the right), where it starts (0 to 360 degrees), and how many of its points are its
     * second colour (18 % to 34 %). */
    data class Sphere(val seed: Long, val tilt: Double, val spin: Int, val phase: Double, val share: Double)

    fun sphere(handle: String): Sphere {
        val seed = OrbMotion.seed(handle)
        return Sphere(
            seed,
            tilt = 12 + 20 * OrbMotion.rand(seed, 0, 21),
            spin = if (OrbMotion.rand(seed, 0, 22) < 0.5) -1 else 1,
            phase = 360 * OrbMotion.rand(seed, 0, 23),
            share = 0.18 + 0.16 * OrbMotion.rand(seed, 0, 24),
        )
    }

    /** How a sphere looks at a size (Orb's levels): how many glyphs, the size of its nearest (in the square's units), its
     * radius, and its nucleus's. Few and large where it is small, many and fine where it is large. */
    data class Look(val count: Int, val glyph: Double, val r: Double, val nucleus: Double)

    /** An agent's face's sphere, at each size. */
    val AGENT: Map<Orb.Level, Look> = mapOf(
        Orb.Level.BADGE to Look(30, 32.0, 74.0, 24.0),
        Orb.Level.SEAT to Look(72, 24.0, 72.0, 20.0),
        Orb.Level.FULL to Look(150, 16.0, 68.0, 17.0),
    )

    /** How much further a sphere turns than its ring (OrbMotion's `ring`, in degrees): a whole number, so the turn goes on
     * smoothly where the ring's comes round to 0 again. */
    const val TURN = 3.0

    /** The glyphs, by brightness: six levels, three of each (Phren's ladder), the farthest first. */
    val LADDER: List<List<String>> = listOf(
        listOf(".", "·", "'"),
        listOf("·", ":", "-"),
        listOf("+", ":", "="),
        listOf("o", "+", "x"),
        listOf("*", "o", "0"),
        listOf("#", "*", "@"),
    )

    /** What a glyph becomes when it is data for a moment. */
    const val DATA = "0123456789ABCDEF"

    /** How often, in each mood, a glyph is data for its beat (at work it reads more), as a share of its beats. Never while
     * paused or failed. */
    val FLASH: Map<OrbMotion.Mood, Double> = mapOf(
        OrbMotion.Mood.IDLE to 0.008, OrbMotion.Mood.WORKING to 0.03, OrbMotion.Mood.WAITING to 0.015, OrbMotion.Mood.QUEUED to 0.01,
        OrbMotion.Mood.PAUSED to 0.0, OrbMotion.Mood.DONE to 0.01, OrbMotion.Mood.FAILED to 0.0,
    )

    /** A point on the unit sphere (x right, y down, z towards you), whether it is the second colour, and its size (0.7 to
     * 1 of its orb's largest). */
    data class Point(val x: Double, val y: Double, val z: Double, val second: Boolean, val size: Double)

    /** [count] points spread evenly over the sphere (a Fibonacci lattice: each a golden angle round from the last, from
     * the top to the bottom in even steps). */
    fun points(sphere: Sphere, count: Int): List<Point> {
        val golden = PI * (3 - sqrt(5.0))
        return List(count) { i ->
            val y = 1 - (2 * (i + 0.5)) / count
            val r = sqrt(1 - y * y)
            val a = i * golden
            Point(r * cos(a), y, r * sin(a), OrbMotion.rand(sphere.seed, i, 25) < sphere.share, 0.7 + 0.3 * OrbMotion.rand(sphere.seed, i, 26))
        }
    }

    /** A glyph's character, whether it is data, and how far it is lit through its beat. */
    data class Glyph(val char: String, val data: Boolean, val fade: Double)

    /** Glyph [i]'s character at [t] seconds, by its brightness [level] (0 to 5): it keeps one for a slow beat of its own
     * (2 to 6 seconds), then another of its level, at random; for [flash] of its beats it is data instead. Its fade is how
     * far it is lit through its beat (0.7 at its ends, where it changes, to 1 in its middle), so a change is soft. */
    fun glyph(seed: Long, i: Int, level: Int, t: Double, flash: Double): Glyph {
        val beat = 2 + 4 * OrbMotion.rand(seed, i, 30)
        val at = t / beat + OrbMotion.rand(seed, i, 31)
        val slot = floor(at)
        val pick = OrbMotion.rand(lot(seed, slot, GOLDEN), i, 32)
        val data = flash > 0 && OrbMotion.rand(lot(seed, slot, MIX), i, 33) < flash
        val fade = 0.7 + 0.3 * sin(PI * (at - slot))
        val ladder = LADDER[max(0, min(5, level))]
        return Glyph(if (data) DATA[floor(16 * pick).toInt()].toString() else ladder[floor(3 * pick).toInt()], data, fade)
    }

    /**
     * A glyph as it is seen: where it is in the square, how near (0 at the back, 1 at the front), its size (its height, in
     * the square's units), how opaque, which of its colour's six shades it takes (0 the farthest), whether that colour is
     * its second, and its character (data or not).
     */
    data class Shown(val x: Double, val y: Double, val near: Double, val size: Double, val alpha: Double, val shade: Int, val second: Boolean, val char: String, val data: Boolean)

    /**
     * The sphere's glyphs at a moment, the farthest first (where two are as near, the one listed first): turned [angle]
     * degrees about its axis, then its axis leant `tilt` towards you; [radius] in the square's units, [scale] its breath
     * (OrbMotion's frame), [glyph] its nearest glyph's size, [t] the time its glyphs change by, and [mood] how often they
     * are data and whether its lower glyphs sag (failed). [paper]: drawn on a light page, where the near glyphs are the
     * deeper and the far ones fade to the page, so it is opaque further back.
     */
    fun frame(sphere: Sphere, points: List<Point>, angle: Double, radius: Double, scale: Double, glyph: Double, t: Double, mood: OrbMotion.Mood, paper: Boolean = false): List<Shown> {
        val a = ((sphere.phase + sphere.spin * angle) * PI) / 180
        val tilt = (sphere.tilt * PI) / 180
        val ca = cos(a)
        val sa = sin(a)
        val ct = cos(tilt)
        val st = sin(tilt)
        val reach = radius * scale
        val flash = FLASH[mood] ?: 0.0
        val sag = if (mood == OrbMotion.Mood.FAILED) 0.17 * reach else 0.0
        val depths = DoubleArray(points.size)
        val shown = ArrayList<Shown>(points.size)
        for ((i, p) in points.withIndex()) {
            val x = p.x * ca - p.z * sa
            val z = p.x * sa + p.z * ca
            val y = p.y * ct - z * st
            val depth = p.y * st + z * ct
            val near = (depth + 1) / 2
            val shade = min(5, floor(near * 6).toInt())
            val g = glyph(sphere.seed, i, shade, t, flash)
            val alpha = (if (paper) 0.45 + 0.55 * near else 0.25 + 0.75 * near) * g.fade
            depths[i] = depth
            shown += Shown(x * reach, y * reach + (if (y > 0) sag * y * y else 0.0), near, glyph * p.size * (0.6 + 0.55 * near), alpha, shade, p.second, g.char, g.data)
        }
        // (As the PWA sorts them: by how deep, then in the order they're listed, where the difference is none.)
        val order = shown.indices.sortedWith { p, q ->
            val d = depths[p] - depths[q]
            if (d < 0) -1 else if (d > 0) 1 else p - q
        }
        return order.map { shown[it] }
    }

    /** A colour's six shades for a dark page, farthest to nearest: from its shadow two thirds of the way to it, then it,
     * then 30 % and 60 % of the way to its light. */
    fun shades(ink: String, light: String, deep: String): List<String> =
        listOf(deep, Avatar.blendHex(deep, ink, 1.0 / 3), Avatar.blendHex(deep, ink, 2.0 / 3), ink, Avatar.blendHex(ink, light, 0.3), Avatar.blendHex(ink, light, 0.6))

    /** The same for a light page (Phren's ink on paper): the far side fades towards white, the near side deepens. */
    fun paperShades(ink: String, deep: String): List<String> =
        listOf(Avatar.blendHex(ink, "#ffffff", 0.6), Avatar.blendHex(ink, "#ffffff", 0.4), Avatar.blendHex(ink, "#ffffff", 0.18), ink, Avatar.blendHex(ink, deep, 0.3), Avatar.blendHex(ink, deep, 0.55))

    /** One of an agent's own arcs round its face (Jarvis's rings, each agent's its own): its radius and width, where it
     * starts and how long it is (degrees), and how fast it turns against its ring's turning (-1.4 to 1.4 times). */
    data class Arc(val r: Double, val width: Double, val from: Double, val length: Double, val speed: Double)

    /** An agent's arcs at a size: one or two, of lengths and paces its handle gives it; none on a small face. */
    fun arcs(sphere: Sphere, level: Orb.Level): List<Arc> {
        if (level == Orb.Level.BADGE) return emptyList()
        val count = 1 + floor(2 * OrbMotion.rand(sphere.seed, 0, 40)).toInt()
        return List(count) { k ->
            Arc(
                r = 95.0 - 5 * k,
                width = if (k != 0) 1.1 else 1.8,
                from = 360 * OrbMotion.rand(sphere.seed, k, 41),
                length = 50 + 130 * OrbMotion.rand(sphere.seed, k, 42),
                speed = (if (OrbMotion.rand(sphere.seed, k, 43) < 0.5) -1 else 1) * (1 + kotlin.math.floor(2 * OrbMotion.rand(sphere.seed, k, 44))),
            )
        }
    }

    /** A place of the primary's data ring, lit: its hex digit and how bright it is. */
    data class Data(val char: String, val alpha: Double)

    /** One place of the primary's data ring at [t]: whether it is lit (about [share] of them are, by its handle), its hex digit,
     * changing on a slow beat of its own (2.5 to 7 seconds), and how bright it is (0.45 to 0.85). Null: not lit. */
    fun dataGlyph(seed: Long, k: Int, t: Double, share: Double): Data? {
        if (OrbMotion.rand(seed, k, 50) >= share) return null
        val beat = 2.5 + 4.5 * OrbMotion.rand(seed, k, 51)
        val slot = floor(t / beat + OrbMotion.rand(seed, k, 52))
        val lot = lot(seed, slot, GOLDEN)
        return Data(DATA[floor(16 * OrbMotion.rand(lot, k, 53)).toInt()].toString(), 0.45 + 0.4 * OrbMotion.rand(lot, k, 54))
    }

    private val GOLDEN = 0x9e3779b1.toInt()
    private val MIX = 0x85ebca77.toInt()

    /** A beat's own seed, as the PWA reckons `(seed + Math.imul(slot, k)) >>> 0`: the slot taken to a 32-bit integer, the
     * product wrapping, the sum unsigned 32-bit. */
    private fun lot(seed: Long, slot: Double, k: Int): Long = (seed + (slot.toLong().toInt() * k).toLong()) and 0xffffffffL
}
