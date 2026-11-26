package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * The primary's field (the PWA's lib/field.ts; your choice for the app icon, 26 November 2026: "field aurum"): lines of force
 * looping from pole to pole round a dark core, lit from the upper left and burning at the rim on the far side. Pure:
 * points in space with a colour and a size, and their place on a square picture. Every orb draws the same points
 * (FieldOrb says whose field, at what size and in what mood; ui/Field.kt draws it), the primary's in gold and each agent's in
 * its own colours. Held to the PWA's own numbers by the vectors' `field` section, to a billionth.
 *
 * A field is made in two steps, so an orb that turns does the costly part once: its model (each line's longitude and
 * width from its seed, each step's angle, its lean, its colours in linear light), then its points at a turn ([at], into
 * a buffer it keeps).
 */
object Field {
    /** A field's colours: its key light (the lit face, bright then deep) and the rim burning on its far side. */
    data class Colours(val key: List<String>, val rim: String)

    /** Gold and copper: the field's fire. */
    val AURUM = Colours(listOf("#fff4d6", "#ffb12e"), "#ff5a2a")

    /** sRGB hex to linear light, as three.js reads a colour. */
    fun linear(hex: String): DoubleArray {
        fun channel(at: Int): Double {
            val c = hex.substring(at, at + 2).toInt(16) / 255.0
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return doubleArrayOf(channel(1), channel(3), channel(5))
    }

    private fun norm(x: Double, y: Double, z: Double): DoubleArray {
        val l = sqrt(x * x + y * y + z * z).let { if (it == 0.0 || it.isNaN()) 1.0 else it }
        return doubleArrayOf(x / l, y / l, z / l)
    }

    /** Where the key light comes from and where the rim light burns: unit vectors in the field's space (x right, y up, z
     * towards you). */
    val KEY: DoubleArray = norm(-0.55, 0.58, 0.6)
    val RIM: DoubleArray = norm(0.8, -0.45, -0.35)

    /** A field's colours in linear light, read once (shade reads them on every point). */
    class Light(val deep: DoubleArray, val bright: DoubleArray, val rim: DoubleArray)

    fun light(colours: Colours): Light = Light(linear(colours.key[1]), linear(colours.key[0]), linear(colours.rim))

    /** A point's light: its colour (linear), how strongly it is lit (`k`, 0 to 1), and the key's and the rim's apart. */
    class Shade(val r: Double, val g: Double, val b: Double, val k: Double, val lit: Double, val rim: Double)

    /** A point's colour by the key light on it and the rim light behind it (n: its unit normal). */
    fun shade(nx: Double, ny: Double, nz: Double, light: Light): Shade {
        val lit = max(0.0, nx * KEY[0] + ny * KEY[1] + nz * KEY[2]).pow(1.2)
        val facing = max(0.0, nz)
        val rimK = (1 - facing).pow(2.4) * max(0.0, nx * RIM[0] + ny * RIM[1] + nz * RIM[2] + 0.25)
        val deep = light.deep
        val bright = light.bright
        val rim = light.rim
        var c0 = deep[0] * 0.12
        var c1 = deep[1] * 0.12
        var c2 = deep[2] * 0.12
        // (As the PWA mixes: a + (b - a) * t, a channel at a time.)
        val t1 = min(1.0, lit * 1.5)
        c0 += (deep[0] - c0) * t1
        c1 += (deep[1] - c1) * t1
        c2 += (deep[2] - c2) * t1
        val t2 = max(0.0, lit - 0.4) * 1.7
        c0 += (bright[0] - c0) * t2
        c1 += (bright[1] - c1) * t2
        c2 += (bright[2] - c2) * t2
        val k = max(lit, rimK)
        val gain = 0.12 + 1.9 * k
        return Shade((c0 + rim[0] * rimK * 2.2) * gain, (c1 + rim[1] * rimK * 2.2) * gain, (c2 + rim[2] * rimK * 2.2) * gain, k, lit, rimK)
    }

    /** A field's fixed part: its lines' longitudes before any turn and their widths (its seed's), each step's angle along
     * a line (its sine, cosine and sine squared), its lean's cosines and sines, its weight and its colours. */
    class Model(
        val lines: Int,
        val steps: Int,
        val weight: Double,
        val phi: DoubleArray,
        val width: DoubleArray,
        val sin: DoubleArray,
        val cos: DoubleArray,
        val sin2: DoubleArray,
        /** The lean: cos and sin about x, y and z. */
        val lean: DoubleArray,
        val light: Light,
    )

    /**
     * A field's model: [lines] lines (more is denser), [steps] points along each, its lean ([tilt]: radians about x, y and
     * z in turn, as three.js turns an Euler), bolder points ([weight]), its colours, and its [seed].
     */
    fun model(lines: Int = 46, steps: Int = 260, tilt: DoubleArray = doubleArrayOf(0.42, 0.3, -0.18), weight: Double = 1.0, colours: Colours = AURUM, seed: Long = 11): Model {
        // The same random numbers every time (Park and Miller's), so a field is the same picture on every machine.
        var s = seed
        fun rnd(): Double {
            s = (s * 16807) % 2147483647
            return s / 2147483647.0
        }
        val phi = DoubleArray(lines)
        val width = DoubleArray(lines)
        for (line in 0 until lines) {
            phi[line] = (line.toDouble() / lines) * PI * 2 + rnd() * 0.12
            width[line] = 1.05 + 0.75 * rnd().pow(0.7)
        }
        val sinA = DoubleArray(steps)
        val cosA = DoubleArray(steps)
        val sin2 = DoubleArray(steps)
        for (j in 1 until steps) {
            val th = (j.toDouble() / steps) * PI
            sinA[j] = sin(th)
            cosA[j] = cos(th)
            sin2[j] = sin(th).pow(2)
        }
        val (ax, ay, az) = Triple(tilt[0], tilt[1], tilt[2])
        return Model(lines, steps, weight, phi, width, sinA, cosA, sin2, doubleArrayOf(cos(ax), sin(ax), cos(ay), sin(ay), cos(az), sin(az)), light(colours))
    }

    /** Where a field's points go: each one's place on its line (its line times the model's steps, plus its step), x, y,
     * z, its colour (linear), its size, and the key's and the rim's light on it; as many as a model can have. */
    class Buffer(n: Int) {
        val at = IntArray(n)
        val x = DoubleArray(n)
        val y = DoubleArray(n)
        val z = DoubleArray(n)
        val r = DoubleArray(n)
        val g = DoubleArray(n)
        val b = DoubleArray(n)
        val size = DoubleArray(n)
        val lit = DoubleArray(n)
        val rim = DoubleArray(n)
    }

    fun buffer(model: Model): Buffer = Buffer(model.lines * model.steps)

    /**
     * The field's points turned [turn] radians about its axis, into [out], and how many there are: each line a loop from
     * pole to pole (a dipole's, r = L·sin²θ) at its own longitude and width, none inside the core (r < 0.32) and none the
     * lights leave dark. [light] colours it otherwise than its model (a mood's tint, FieldOrb).
     */
    fun at(model: Model, turn: Double, out: Buffer, light: Light = model.light): Int {
        val lines = model.lines
        val steps = model.steps
        val cx = model.lean[0]
        val sx = model.lean[1]
        val cy = model.lean[2]
        val sy = model.lean[3]
        val cz = model.lean[4]
        val sz = model.lean[5]
        var n = 0
        for (line in 0 until lines) {
            val p = model.phi[line] + turn
            val cp = cos(p)
            val sp = sin(p)
            val w = model.width[line]
            for (j in 1 until steps) {
                val r = w * model.sin2[j]
                if (r < 0.32) continue
                val rs = r * model.sin[j]
                val a0 = rs * cp
                val a1 = r * model.cos[j]
                val a2 = rs * sp
                // The lean, as an XYZ Euler turns (three.js' default order: the matrix Rx·Ry·Rz applied to the point).
                var x = a0 * cz - a1 * sz
                var y = a0 * sz + a1 * cz
                var z = a2
                val x2 = x * cy + z * sy
                val z2 = -x * sy + z * cy
                x = x2
                z = z2
                val y3 = y * cx - z * sx
                val z3 = y * sx + z * cx
                y = y3
                z = z3
                val l = sqrt(x * x + y * y + z * z).let { if (it == 0.0) 1.0 else it }
                val s = shade(x / l, y / l, z / l, light)
                if (s.k < 0.02) continue
                val near = min(1.0, 1.9 / (0.6 + r))
                val g = 0.35 + 0.65 * near
                out.at[n] = line * steps + j
                out.x[n] = x * 1.05
                out.y[n] = y * 1.05
                out.z[n] = z * 1.05
                out.r[n] = s.r * g
                out.g[n] = s.g * g
                out.b[n] = s.b * g
                out.size[n] = (0.009 + 0.02 * s.k) * model.weight
                out.lit[n] = s.lit
                out.rim[n] = s.rim
                n++
            }
        }
        return n
    }

    /** Where a point falls on a square picture [size] across, seen from a camera on the z axis (as the icon is drawn):
     * its pixel position, its diameter in pixels, and whether it is in front of the camera at all. */
    data class Projected(val x: Double, val y: Double, val d: Double, val visible: Boolean)

    fun project(x: Double, y: Double, z: Double, pointSize: Double, size: Double, fov: Double = 28.0, distance: Double = 8.3, zoom: Double = 1.0): Projected {
        val depth = distance - z
        val f = (size / 2 / tan(((fov / 2) * PI) / 180)) * zoom
        return Projected(size / 2 + (x * f) / depth, size / 2 - (y * f) / depth, (pointSize * (size / 2) * zoom) / depth, depth > 0.1)
    }
}
