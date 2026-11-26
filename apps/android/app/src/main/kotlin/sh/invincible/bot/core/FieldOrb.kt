package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * The orbs as fields (the PWA's lib/field-orb.ts, 26 November 2026): the primary's field (Field) is every orb, its in gold
 * with its beam of light through it, each agent's in its own colours. The owner's words: the glyph spheres "still look
 * a little strange/not cool enough, and almost like nipples", and "i dont want them to be too visually distractin"; then,
 * of the heads-up ring it had worn round its field, "remove the old mark around primary. make the primary agent distinct
 * in some other cool way". So a field has no bright middle (its core stays dark), no regular lattice of dots, and no ring
 * round it, its or an agent's; it is still where it is one of many, and moves slowly where it is the one you are looking
 * at. Pure: whose field an orb is, how it is drawn at a size, its beam, how it moves in each mood, its embers and its ink
 * on a light page. ui/Field.kt draws it; the vectors' `field` section holds it to the PWA's own numbers.
 */
object FieldOrb {
    /** Whose field an orb is: its seed (its lines' longitudes and widths), its lean (Field.model's tilt), how many lines,
     * and its colours. */
    data class Identity(val seed: Long, val tilt: List<Double>, val lines: Int, val colours: Field.Colours)

    /** The primary's: the icon's own field, in gold. */
    val PRIMARY = Identity(11, listOf(0.42, 0.3, -0.18), 46, Field.AURUM)

    /**
     * An agent's: its colours are Avatar's agentColors (the one you chose for it, or its handle's): its key light its tint
     * lit and its tint, its rim its second colour. Its handle gives the rest: 12 to 20 lines, their longitudes and widths
     * (its seed), and its lean: its axis turned up to about 40 degrees either way in the picture, and leaning towards you
     * by 0.25 to 0.5 (the sine of its angle with the picture), so it is always seen from the side, never end on or flat.
     */
    fun agent(id: String, profile: Json? = null): Identity {
        val colours = Avatar.agentColors(id, profile)
        val seed = OrbMotion.seed(id)
        val ay = -0.5 + OrbMotion.rand(seed, 0, 61)
        val az = -0.65 + 1.3 * OrbMotion.rand(seed, 0, 62)
        val towards = 0.25 + 0.25 * OrbMotion.rand(seed, 0, 60)
        // The axis (y, before the lean) ends up with z = cos(az)·sin(ax) + sin(az)·sin(ay)·cos(ax) = R·sin(ax + δ): the lean
        // about x that gives it `towards`.
        val a = cos(az)
        val b = sin(az) * sin(ay)
        val ax = asin(towards / hypot(a, b)) - atan2(b, a)
        return Identity(1 + (seed % 2147483646), listOf(ax, ay, az), 12 + floor(9 * OrbMotion.rand(seed, 0, 63)).toInt(), Field.Colours(listOf(colours.light, colours.tint), colours.second))
    }

    /** How a field is drawn at a size (dp): how many of its lines, points along each, how bold, and how far it reaches in
     * its square (at 1 its widest point is 0.44 to 0.47 of its width from the middle). */
    data class Look(val lines: Int, val steps: Int, val weight: Double, val zoom: Double)

    /** A field at a size. Its ([primary]) keeps fewer of its 46 lines where it is small, so it reads at 18 dp; every field
     * fills its square alike (its no longer drawn in, clear of a ring). The larger, the more points along a line, and the
     * smaller, the bolder. */
    fun look(identity: Identity, size: Double, primary: Boolean): Look {
        val s = if (size.isFinite()) max(8.0, size) else 36.0
        val lines = if (primary) min(identity.lines, if (s < 30) 26 else if (s < 56) 34 else 46) else identity.lines
        return Look(lines, jsRound(max(20.0, min(96.0, s * 0.55))).toInt(), if (s <= 24) 1.5 else if (s <= 48) 1.25 else 1.0, 0.94)
    }

    /**
     * Its beam: what marks it out, now its heads-up ring has gone (the owner's word, 26 November 2026: "make the primary
     * agent distinct in some other cool way"). A blade of light along its field's own axis, out of both its poles, as a
     * pulsar's jets go: no agent has one. Each half runs from [FROM] to [TO] of the field's units out of its middle (so the
     * core, r < 0.32, stays dark), [WIDTH] of the orb's width across at its root (never under a pixel), narrowing to
     * nothing at its tip, its light fading as it goes ([beamAt]). On a dark page its light is added as the field's is,
     * with a close glow [GLOW_WIDTH] times as wide and [GLOW_ALPHA] as strong (no fog); on a light page it is ink,
     * [INK_WIDTH] times as wide and [INK_ALPHA] times as strong as its light (ink on white reads thinner than light on
     * black), its root never under [INK_LEAST] dp each side (so at 34 dp it holds as a blade, not a needle), its ink
     * fading slower than its light does ([beamAt]'s light to the power [INK_FADE]), over a close tint of its ink
     * ([INK_GLOW_WIDTH] times as wide, [INK_GLOW_ALPHA] as strong). Its outline is taken at [STEPS] steps along it. The
     * field turns about it; it shines as the field does, never past its light at rest (breathing while something waits,
     * dimmer while queued or paused, its tip red-brown when its work failed).
     */
    object Beam {
        const val FROM = 0.36
        const val TO = 1.72
        const val WIDTH = 1.0 / 40
        const val STEPS = 16
        const val GLOW_WIDTH = 3.2
        const val GLOW_ALPHA = 0.2
        const val INK_WIDTH = 1.6
        const val INK_ALPHA = 1.5
        const val INK_LEAST = 0.85
        const val INK_FADE = 0.6
        const val INK_GLOW_WIDTH = 3.2
        const val INK_GLOW_ALPHA = 0.24
    }

    /** A half of its beam in an orb's square (its middle 0, its edge 1; x right, y down, as an ember's): its root, out of
     * its core, and its tip, each as x and y. */
    data class Blade(val root: List<Double>, val tip: List<Double>)

    /** A direction in the field's own space turned as its lean turns its points (Field.at: Rx·Ry·Rz). */
    fun leaned(v: List<Double>, tilt: List<Double>): List<Double> {
        val cx = cos(tilt[0])
        val sx = sin(tilt[0])
        val cy = cos(tilt[1])
        val sy = sin(tilt[1])
        val cz = cos(tilt[2])
        val sz = sin(tilt[2])
        var x = v[0] * cz - v[1] * sz
        val y = v[0] * sz + v[1] * cz
        var z = v[2]
        val x2 = x * cy + z * sy
        val z2 = -x * sy + z * cy
        x = x2
        z = z2
        return listOf(x, y * cx - z * sx, y * sx + z * cx)
    }

    /** Its beam in an orb's square at a zoom: each half's root and tip, along its axis (Field.project's camera, as its
     * points are seen), the upper half first. */
    fun beamLine(identity: Identity, zoom: Double): List<Blade> {
        val axis = leaned(listOf(0.0, 1.0, 0.0), identity.tilt)
        fun seen(k: Double): List<Double> {
            // (Placed as a point is: Field.at's points are its units times 1.05.)
            val q = Field.project(axis[0] * k * 1.05, axis[1] * k * 1.05, axis[2] * k * 1.05, 0.0, 2.0, zoom = zoom)
            return listOf(q.x - 1, q.y - 1)
        }
        val halves = listOf(1.0, -1.0).map { dir -> Blade(seen(dir * Beam.FROM), seen(dir * Beam.TO)) }
        return if (halves[0].tip[1] <= halves[1].tip[1]) halves else listOf(halves[1], halves[0])
    }

    /** Along a half of its beam, [u] of the way from its root (0) to its tip (1): its width as a share of the root's (it
     * narrows to a point), how much of its light is left, and how far its colour has gone from its key's lit gold (0)
     * through its gold (0.5) to its rim's copper (1). */
    data class Along(val width: Double, val light: Double, val hue: Double)

    fun beamAt(u: Double): Along {
        val t = max(0.0, min(1.0, u))
        return Along((1 - t).pow(0.55), (1 - t).pow(1.1), t)
    }

    // ---- how it moves ------------------------------------------------------------------------------------------------

    /** A slow breath of brightness: its seconds, and its depth (0.2 is a fifth brighter and dimmer). */
    data class Breath(val period: Double, val depth: Double)

    /**
     * A mood's motion, slow and calm (your word, 25 November 2026: "slow and calming movement"): radians a second it
     * turns ([turn]; 0.1 is a turn a minute), how bright ([glow], 1 at rest), a slow [breath] or none, whether a few
     * [embers] drift off its rim (its alone), and how far its burning rim has dimmed towards red-brown ([rim], 0 to 1).
     */
    data class Motion(val turn: Double, val glow: Double, val breath: Breath?, val embers: Boolean, val rim: Double)

    /** The primary's moods: only while something is going on does it move (your word, 26 November 2026: "nothing animating at
     * rest"): at work it turns, embers drifting off its rim; waiting on you it breathes, turning slowly. At rest (idle),
     * done (it settles), queued, paused and failed it comes to rest, still, in its mood's light: dimmer while queued or
     * paused, its rim red-brown when its work failed. (Until 26 November 2026 it turned at rest too, a turn a minute.) */
    val MOTION: Map<OrbMotion.Mood, Motion> = mapOf(
        OrbMotion.Mood.IDLE to Motion(0.0, 1.0, null, false, 0.0),
        OrbMotion.Mood.WORKING to Motion(0.2, 1.08, null, true, 0.0),
        OrbMotion.Mood.WAITING to Motion(0.08, 1.0, Breath(5.2, 0.2), false, 0.0),
        OrbMotion.Mood.QUEUED to Motion(0.0, 0.85, null, false, 0.0),
        OrbMotion.Mood.PAUSED to Motion(0.0, 0.7, null, false, 0.0),
        OrbMotion.Mood.DONE to Motion(0.0, 1.0, null, false, 0.0),
        OrbMotion.Mood.FAILED to Motion(0.0, 0.88, null, false, 1.0),
    )

    /** An agent's: it moves only while it works (your word, 26 November 2026: still in rows, moving only in its own
     * thread's header while it works), turning as its does at work, with no embers; in every other mood it comes to rest,
     * in that mood's light. */
    fun motion(mood: OrbMotion.Mood, agent: Boolean): Motion {
        val m = MOTION.getValue(mood)
        if (!agent) return m
        return if (mood == OrbMotion.Mood.WORKING) m.copy(embers = false) else m.copy(turn = 0.0, breath = null, embers = false)
    }

    /** Seconds a speed, a light or a tint takes to ease most of the way (63 %) to a new mood's: a mood arrives over about
     * two seconds. */
    const val EASE = 0.6

    /** What a field carries from one frame to the next, so a change of mood speeds or slows its turning, brightens or dims
     * it, with no jump: how far it has turned (0 to 2π) and how fast now, its brightness and its rim's dimming now, its
     * breath's depth now, how far through a breath it is and a breath's seconds, and how much of its embers show. */
    data class Clock(val turn: Double, val speed: Double, val glow: Double, val rim: Double, val depth: Double, val breath: Double, val period: Double, val embers: Double)

    /** A field as it is first seen: settled in its motion, at its rest (turned 0, a breath not begun). */
    fun clock(motion: Motion): Clock = Clock(0.0, motion.turn, motion.glow, motion.rim, motion.breath?.depth ?: 0.0, 0.0, motion.breath?.period ?: 6.0, if (motion.embers) 1.0 else 0.0)

    /** The clock [dt] seconds on, in a motion: each speed and light eased towards the motion's, then turned on. A step
     * longer than a frame takes (the app coming back) turns nothing a long way at once. */
    fun step(clock: Clock, motion: Motion, dt: Double): Clock {
        val d = min(OrbMotion.LONGEST_STEP, max(0.0, dt))
        val ease = 1 - exp(-d / EASE)
        fun toward(value: Double, target: Double) = value + (target - value) * ease
        val speed = toward(clock.speed, motion.turn)
        val period = motion.breath?.period ?: clock.period
        return Clock(
            turn = turned(clock.turn + speed * d),
            speed = speed,
            glow = toward(clock.glow, motion.glow),
            rim = toward(clock.rim, motion.rim),
            depth = toward(clock.depth, motion.breath?.depth ?: 0.0),
            breath = fract(clock.breath + d / period),
            period = period,
            embers = toward(clock.embers, if (motion.embers) 1.0 else 0.0),
        )
    }

    /** Whether a clock has come to its motion: nothing left to ease. */
    fun settled(clock: Clock, motion: Motion): Boolean {
        fun near(a: Double, b: Double, by: Double = 0.002) = kotlin.math.abs(a - b) <= by
        return near(clock.speed, motion.turn, 0.0005) && near(clock.glow, motion.glow) && near(clock.rim, motion.rim) &&
            near(clock.depth, motion.breath?.depth ?: 0.0) && near(clock.embers, if (motion.embers) 1.0 else 0.0, 0.005)
    }

    /** How many frames a second a field needs now: as few as look smooth (each frame costs a battery). While it eases to a
     * mood, 30; while its embers drift (slowly: a frame moves one a third of a pixel at 168 dp) or it breathes, 20; only
     * turning, 15; and none once it has come to rest. */
    fun fps(clock: Clock, motion: Motion): Int {
        if (!settled(clock, motion)) return 30
        if (clock.embers > 0.01 || clock.depth > 0.002) return 20
        return if (clock.speed > 0.0005) 15 else 0
    }

    /** An ember: where it is in the orb's square (its middle 0, its edge 1; x right, y down), its radius there, and how
     * opaque. */
    data class Ember(val x: Double, val y: Double, val r: Double, val alpha: Double)

    /** A moment of a field: how far it is turned, how bright, how far its rim has dimmed, and its embers. */
    data class Frame(val turn: Double, val glow: Double, val rim: Double, val embers: List<Ember>)

    /** Its embers, refined (26 November 2026: few, small and slow, so they say it works without pulling the eye): how
     * many; each lives 3.6 to 5.6 seconds (then another sets out); where they set out (a share of the way from the middle
     * to the edge of the orb's square) and how far each drifts; how much they rise; how far round from the rim's burning
     * side they may set out (degrees either way); their radius; and how long each takes to come into sight (a share of
     * its life). Always inside its square. Drawn soft (a light that falls away from its middle), never a hard dot. */
    object Embers {
        const val COUNT = 5
        const val LIFE_FROM = 3.6
        const val LIFE_TO = 5.6
        const val FROM_FROM = 0.58
        const val FROM_TO = 0.64
        const val DRIFT_FROM = 0.08
        const val DRIFT_TO = 0.15
        const val RISE = 0.05
        const val SPREAD = 60.0
        const val SIZE_FROM = 0.012
        const val SIZE_TO = 0.022
        const val FADE_IN = 0.25
    }

    /** Where the rim burns, in degrees clockwise from the top (Field's rim light, seen from the front: lower right). */
    val RIM_ANGLE: Double = (atan2(Field.RIM[0], Field.RIM[1]) * 180) / PI

    /** A field at [t] seconds, as its clock stands: its breath in its brightness, and (where it has them, [embers]) its
     * embers, seeded by [seed] so two never drift as one. */
    fun frame(clock: Clock, t: Double, seed: Long = 0, embers: Boolean = false): Frame {
        val glow = clock.glow * (1 + clock.depth * sin(2 * PI * clock.breath))
        val shown = if (embers && clock.embers > 0.01) embersAt(seed and 0xffffffffL, t, clock.embers) else emptyList()
        return Frame(clock.turn, glow, clock.rim, shown)
    }

    /** A field still: at its rest (turned 0), in its mood's light (dimmed, or its rim red-brown), with no breath and no
     * embers. What a row shows, a conversation's history, and every orb while the phone's animations are off. */
    fun still(motion: Motion): Frame = Frame(0.0, motion.glow, motion.rim, emptyList())

    private fun embersAt(seed: Long, t: Double, share: Double): List<Ember> {
        val out = ArrayList<Ember>(Embers.COUNT)
        for (i in 0 until Embers.COUNT) {
            val life = Embers.LIFE_FROM + (Embers.LIFE_TO - Embers.LIFE_FROM) * OrbMotion.rand(seed, i, 70)
            val at = t / life + OrbMotion.rand(seed, i, 71)
            val round = floor(at)
            val u = at - round
            // Each time it sets out, from somewhere else (JavaScript's (seed + Math.imul(round, 0x9e3779b1)) >>> 0).
            val lot = (seed + (round.toLong().toInt() * 0x9e3779b1.toInt()).toLong()) and 0xffffffffL
            val angle = ((RIM_ANGLE + Embers.SPREAD * (2 * OrbMotion.rand(lot, i, 72) - 1)) * PI) / 180
            val reach = Embers.FROM_FROM + (Embers.FROM_TO - Embers.FROM_FROM) * OrbMotion.rand(lot, i, 73) + (Embers.DRIFT_FROM + (Embers.DRIFT_TO - Embers.DRIFT_FROM) * OrbMotion.rand(lot, i, 74)) * u
            val fadeIn = min(1.0, u / Embers.FADE_IN)
            out += Ember(
                x = reach * sin(angle),
                y = -reach * cos(angle) - Embers.RISE * u,
                r = (Embers.SIZE_FROM + (Embers.SIZE_TO - Embers.SIZE_FROM) * OrbMotion.rand(lot, i, 75)) * (1 - 0.4 * u),
                alpha = share * fadeIn * fadeIn * (3 - 2 * fadeIn) * (1 - u) * (1 - u),
            )
        }
        return out
    }

    // ---- its colours ----------------------------------------------------------------------------------------------------

    /** Where a failed field's rim dims to: a red-brown, an ember going out. */
    const val RIM_DIM = "#5a2416"

    /** A field's colours in a moment: its rim dimmed [rim] of the way (0.7 at most) towards red-brown. */
    fun colours(colours: Field.Colours, rim: Double): Field.Colours =
        if (rim > 0.001) Field.Colours(colours.key, Avatar.blendHex(colours.rim, RIM_DIM, 0.7 * min(1.0, rim))) else colours

    /** How a point's light is shown on a dark page, as the icon shows it: three.js' ACES filmic tone mapping (r160) at the
     * icon's exposure, to sRGB, 0 to 1 a channel, into [out]. */
    const val EXPOSURE = 1.12

    fun tone(r: Double, g: Double, b: Double, exposure: Double = EXPOSURE, out: DoubleArray = DoubleArray(3)): DoubleArray {
        val e = exposure / 0.6
        val x = r * e
        val y = g * e
        val z = b * e
        fun fit(v: Double) = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
        val f0 = fit(0.59719 * x + 0.35458 * y + 0.04823 * z)
        val f1 = fit(0.076 * x + 0.90834 * y + 0.01566 * z)
        val f2 = fit(0.0284 * x + 0.13383 * y + 0.83777 * z)
        fun srgb(v: Double): Double {
            val c = max(0.0, min(1.0, v))
            return if (c <= 0.0031308) c * 12.92 else 1.055 * c.pow(1 / 2.4) - 0.055
        }
        out[0] = srgb(1.60475 * f0 - 0.53108 * f1 - 0.07367 * f2)
        out[1] = srgb(-0.10208 * f0 + 1.10813 * f1 - 0.00605 * f2)
        out[2] = srgb(-0.00327 * f0 - 0.07276 * f1 + 1.07602 * f2)
        return out
    }

    /**
     * How a field's lines are drawn, from point to point along each (dp): a line's width from [LEAST] where it is faintest
     * to [LEAST] + [MORE] where brightest, times its look's weight; under each line on a dark page its light again,
     * [GLOW_WIDTH] times as wide and [GLOW_ALPHA] as strong (close, so no fog: your word, 26 November 2026, "less fog, so
     * it reads clearer"); a line's width on a light page, [INK] of its width on a dark one at its largest, the same at
     * every size (a look's weight, its boldness where small, is for light, which spreads): wider, as ink on paper has no
     * glow to carry it (until 26 November 2026, 0.85 of the dark page's at each size: the agents read as thin scribbles
     * there), and never narrower than [INK_LEAST] dp, so a 14 dp face keeps its lines (no glow under them there); and how
     * much of its points' light a line shows on a dark page ([LIGHT]), less again where it is smaller than [FULL].
     */
    object Stroke {
        const val LEAST = 0.42
        const val MORE = 0.5
        const val GLOW_WIDTH = 3.2
        const val GLOW_ALPHA = 0.12
        const val INK = 1.35
        const val INK_LEAST = 0.55
        const val LIGHT = 0.22
        const val FULL = 96.0
    }

    /** How much of its points' light a field [size] wide shows on a dark page. */
    fun strokeLight(size: Double): Double = Stroke.LIGHT * min(1.0, size / Stroke.FULL)

    /** A field's inks on a light page, as sRGB (0 to 255 each): where its key light falls, its key's deep colour as ink,
     * where its rim burns, its rim's, and where the key light strikes hardest, its lit colour as a lighter ink (its
     * [sheen], which says it is lit) ([Ink]). */
    data class Inks(val key: IntArray, val rim: IntArray, val sheen: IntArray)

    fun inks(colours: Field.Colours): Inks =
        Inks(inkOf(colours.key[1], Ink.KEY), inkOf(colours.rim, Ink.RIM), inkOf(colours.key[0], Ink.SHEEN_CONTRAST))

    /**
     * A point's ink on a light page, from the key's light on it and the rim's: between its two inks by their shares, and
     * as opaque as it is lit ([Ink]'s floor and curve), so the field keeps its depth on paper and its far lines don't
     * vanish.
     *
     * The ink itself (26 November 2026: it read as "flat line art" there, the agents' above all, which the icon rounds
     * had turned down): each colour as a saturated ink rather than darkened towards black (which made gold brown and
     * every tint muddy):
     * - [KEY], [RIM]: how far its key's ink and its rim's stand from the page (#fafafa) where fully lit, as a contrast
     *   ratio (3:1 is a graphic's floor; the key, nearer you, stronger);
     * - [CHROMA]: how much more saturated each ink is than its colour, as far as sRGB allows at its lightness;
     * - sheen: where the key light strikes hardest (past [SHEEN_FROM] of its light), its ink goes up to [SHEEN_MOST] of
     *   the way to its lit colour as an ink [SHEEN_CONTRAST] to 1 from the page: the light page's white-hot, so it reads
     *   as lit, not drawn;
     * - [FLOOR], [CURVE]: how opaque a line is by its light, from [FLOOR] where the lights leave it to whole where it is
     *   fully lit, along [CURVE] (under 1, it gains sooner): the far lines faint but there, so the field keeps its volume.
     */
    class Ink(val r: Double, val g: Double, val b: Double, val alpha: Double) {
        companion object {
            const val KEY = 3.4
            const val RIM = 3.1
            const val SHEEN_CONTRAST = 2.2
            const val SHEEN_FROM = 0.55
            const val SHEEN_MOST = 0.7
            const val CHROMA = 1.2
            const val FLOOR = 0.22
            const val CURVE = 0.9
        }
    }

    fun ink(inks: Inks, lit: Double, rim: Double): Ink {
        val total = lit + rim
        val share = if (total > 0) rim / total else 0.0
        // Where the key strikes hardest (past SHEEN_FROM of its light), its sheen: up to SHEEN_MOST of the way to it.
        val sheen = Ink.SHEEN_MOST * max(0.0, min(1.0, (lit - Ink.SHEEN_FROM) / (1 - Ink.SHEEN_FROM))) * (1 - share)
        fun mix(at: Int): Double {
            val ink = inks.key[at] + (inks.rim[at] - inks.key[at]) * share
            return ink + (inks.sheen[at] - ink) * sheen
        }
        val light = min(1.0, max(0.0, max(lit, rim)))
        return Ink(mix(0), mix(1), mix(2), Ink.FLOOR + (1 - Ink.FLOOR) * light.pow(Ink.CURVE))
    }

    /** [ink] for each point of each frame on a light page, making nothing: its colour into [out] (0 to 255 a channel) and
     * its opacity as `out[3]`, read from [Ink]'s curve taken in 1024 steps (within a thousandth of [ink]'s; a stroke is
     * drawn in sixteen steps of it anyway). */
    fun inkInto(inks: Inks, lit: Double, rim: Double, out: DoubleArray) {
        val total = lit + rim
        val share = if (total > 0) rim / total else 0.0
        val sheen = Ink.SHEEN_MOST * max(0.0, min(1.0, (lit - Ink.SHEEN_FROM) / (1 - Ink.SHEEN_FROM))) * (1 - share)
        for (c in 0 until 3) {
            val ink = inks.key[c] + (inks.rim[c] - inks.key[c]) * share
            out[c] = ink + (inks.sheen[c] - ink) * sheen
        }
        out[3] = INK_ALPHA[jsRound(min(1.0, max(0.0, max(lit, rim))) * 1023).toInt()]
    }

    private val INK_ALPHA = DoubleArray(1024) { Ink.FLOOR + (1 - Ink.FLOOR) * (it / 1023.0).pow(Ink.CURVE) }

    /** A colour as an ink on the light page: its hue kept, its chroma [Ink.CHROMA] times its own (as far as sRGB goes),
     * and as light as it can be while it stands [contrast] to 1 from the page (or as it is, where it is darker already). */
    fun inkOf(hex: String, contrast: Double): IntArray {
        val lab = oklab(Field.linear(hex))
        val l0 = lab[0]
        val c0 = hypot(lab[1], lab[2]) * Ink.CHROMA
        val h = atan2(lab[2], lab[1])
        val ch = cos(h)
        val sh = sin(h)
        // The most chroma up to c0 that sRGB holds at a lightness (bisected: 16 steps, under a ten-thousandth of the range,
        // finer than a byte of sRGB can tell).
        fun held(l: Double): DoubleArray {
            var lo = 0.0
            var hi = c0
            if (inGamut(fromOklab(l, c0 * ch, c0 * sh))) lo = c0
            else for (i in 0 until 16) {
                val mid = (lo + hi) / 2
                if (inGamut(fromOklab(l, mid * ch, mid * sh))) lo = mid else hi = mid
            }
            return fromOklab(l, lo * ch, lo * sh)
        }
        val most = (PAGE_LUMINANCE + 0.05) / contrast - 0.05
        var shown = held(l0)
        if (relativeLuminance(shown) > most) {
            // As light as it may be: the lightness that stands `contrast` from the page (bisected, 16 steps).
            var lo = 0.0
            var hi = l0
            for (i in 0 until 16) {
                val mid = (lo + hi) / 2
                if (relativeLuminance(held(mid)) > most) hi = mid else lo = mid
            }
            shown = held(lo)
        }
        return intArrayOf(srgb8(shown[0]), srgb8(shown[1]), srgb8(shown[2]))
    }

    // (Colour in OKLab, Björn Ottosson's: a lightness and two axes of hue, so an ink keeps its hue as it darkens.)
    /** The light page's own luminance (#fafafa). */
    private val PAGE_LUMINANCE = ((250 / 255.0 + 0.055) / 1.055).pow(2.4)

    private fun oklab(rgb: DoubleArray): DoubleArray {
        val r = rgb[0]
        val g = rgb[1]
        val b = rgb[2]
        val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return doubleArrayOf(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
    }

    private fun fromOklab(lightness: Double, a: Double, b: Double): DoubleArray {
        val l = (lightness + 0.3963377774 * a + 0.2158037573 * b).pow(3)
        val m = (lightness - 0.1055613458 * a - 0.0638541728 * b).pow(3)
        val s = (lightness - 0.0894841775 * a - 1.291485548 * b).pow(3)
        return doubleArrayOf(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    }

    private fun inGamut(rgb: DoubleArray): Boolean = rgb.all { it >= -1e-9 && it <= 1 + 1e-9 }

    private fun relativeLuminance(rgb: DoubleArray): Double = 0.2126 * max(0.0, rgb[0]) + 0.7152 * max(0.0, rgb[1]) + 0.0722 * max(0.0, rgb[2])

    /** Linear light to an sRGB byte. */
    private fun srgb8(v: Double): Int {
        val c = max(0.0, min(1.0, v))
        return jsRound(255 * (if (c <= 0.0031308) c * 12.92 else 1.055 * c.pow(1 / 2.4) - 0.055)).toInt()
    }

    /** JavaScript's Math.round: halves go up (towards +∞). */
    internal fun jsRound(x: Double): Double = floor(x + 0.5).let { if (it - x > 0.5) it - 1 else it }

    private fun fract(x: Double): Double = x - floor(x)

    /** An angle as 0 up to 2π radians. */
    private fun turned(radians: Double): Double {
        val r = radians % (2 * PI)
        return if (r < 0) r + 2 * PI else r
    }
}
