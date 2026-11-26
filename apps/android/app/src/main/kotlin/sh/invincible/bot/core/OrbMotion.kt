package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * How the primary's orb and an agent's seat move (your word, 24 November 2026: "cool orbs/particles, pulsing/moving when
 * doing a task, sitting idle, waiting, done"): the PWA's lib/orb-motion.ts, as data and one pure function of time,
 * held to it by the vectors, so a mood moves the same here as on the web and the Apple app. ui/Orb.kt draws it.
 *
 * Each state has a mood:
 * - idle: a slow breath, with a few motes drifting round.
 * - working: the display turns, a light runs round its inner ring, and motes stream in.
 * - waiting on you: an amber beat that sends out waves.
 * - queued: a slow grey light goes round.
 * - paused: nearly still.
 * - done: a burst, then green with a glint going round.
 * - failed: the turning stops and the motes run down its sides.
 *
 * All of it slow and calm (your word, 25 November 2026: "slow and calming movement"): a breath takes 4 to 12 seconds, a
 * ring turns a few degrees a second, and a mood arrives over more than a second. This replaces the stillness asked for
 * on 18 November 2026, on your later word. Nothing moves while the phone's animations are off (Settings ›
 * Accessibility › Remove animations): the still orb (Orb) is drawn then, which is this function's frame with nothing
 * under way. An agent's handle only seeds where its motes start.
 */
object OrbMotion {
    enum class Mood { IDLE, WORKING, WAITING, QUEUED, PAUSED, DONE, FAILED; val wire: String get() = name.lowercase() }

    /** How a mood's motes move: round (orbit), streaming in from outside (inward), or running down its sides (fall). */
    enum class Flow { ORBIT, INWARD, FALL; val wire: String get() = name.lowercase() }

    /** Degrees a second the display's rings turn (negative: the other way): the outer ring with its notches, the ticks
     * with their marks, and the segments. */
    data class Turn(val ring: Double, val ticks: Double, val segments: Double)

    /** A light running round the inner ring (on an agent's seat, round its own ring): degrees a second, and the length of
     * its tail in degrees. */
    data class Comet(val speed: Double, val tail: Double)

    /** A mood's motes: how many; degrees a second they go round (each between half and one and a half times it); how far
     * each strays across its band (a share of it); and how they move. */
    data class Motes(val count: Int, val speed: Double, val sway: Double, val flow: Flow)

    /**
     * A mood's motion: seconds a breath takes, in and out; how much the sphere swells with each (0.02 is 2 % of its size;
     * its glow swells ten times as much); its rings' turning; its light; seconds between two waves sent out from its edge;
     * its motes; and how strongly an agent's ring glows round it, 0 to 1.
     */
    data class Motion(val breath: Double, val swell: Double, val turn: Turn, val comet: Comet?, val ripple: Double?, val motes: Motes, val aura: Double)

    val motions: Map<Mood, Motion> = mapOf(
        Mood.IDLE to Motion(9.0, 0.01, Turn(1.6, 0.0, -2.4), null, null, Motes(10, 3.5, 0.2, Flow.ORBIT), 0.1),
        Mood.WORKING to Motion(5.2, 0.016, Turn(9.0, 2.2, -14.0), Comet(55.0, 110.0), null, Motes(16, 9.0, 0.0, Flow.INWARD), 0.26),
        Mood.WAITING to Motion(4.2, 0.024, Turn(2.5, 0.0, -3.5), null, 4.2, Motes(10, 4.0, 0.35, Flow.ORBIT), 0.34),
        Mood.QUEUED to Motion(7.0, 0.01, Turn(4.0, 0.0, -4.0), Comet(18.0, 60.0), null, Motes(6, 5.0, 0.12, Flow.ORBIT), 0.14),
        Mood.PAUSED to Motion(12.0, 0.005, Turn(0.0, 0.0, 0.0), null, null, Motes(0, 0.0, 0.0, Flow.ORBIT), 0.05),
        Mood.DONE to Motion(8.0, 0.012, Turn(1.0, 0.0, -1.5), Comet(20.0, 40.0), null, Motes(8, 4.0, 0.25, Flow.ORBIT), 0.24),
        Mood.FAILED to Motion(6.0, 0.014, Turn(0.0, 0.0, 0.0), null, null, Motes(6, 0.0, 0.0, Flow.FALL), 0.24),
    )

    fun motion(mood: Mood): Motion = motions.getValue(mood)

    /** Seconds a new mood takes to arrive: its motes, its light and its waves fade in over them (slowly: your word, 25
     * November 2026, "slow and calming movement"). */
    const val ARRIVE = 1.6
    /** Seconds a burst takes (done, and a task's end), and how many motes drift out in it: a soft one. */
    const val BURST = 2.6
    const val BURST_MOTES = 12
    /** Seconds a speed, the swell and the light take to ease most of the way (63 %) to a new mood's. */
    const val EASE = 0.35
    /** The longest step a frame takes: one late by more (the app coming back) turns nothing a long way at once. */
    const val LONGEST_STEP = 0.25

    /** Where an agent stands among the agents, as its seat moves: work is working, needing you is waiting, verified and
     * new are done, failed, paused and queued are their own, and at rest is idle. */
    fun mood(state: AgentState?): Mood = when (state) {
        AgentState.WORKING -> Mood.WORKING
        AgentState.NEEDS -> Mood.WAITING
        AgentState.FAILED -> Mood.FAILED
        AgentState.PAUSED -> Mood.PAUSED
        AgentState.QUEUED -> Mood.QUEUED
        AgentState.VERIFIED, AgentState.UNREAD -> Mood.DONE
        AgentState.RESTING, null -> Mood.IDLE
    }

    /** The same from a state as the node and the PWA write it ("needs"); one it doesn't know is at rest. */
    fun mood(wire: String?): Mood = mood(AgentState.entries.firstOrNull { it.wire == wire })

    /**
     * What an agent is doing where only that is known (Roster's expression, core's avatarExpression), as its orb's mood
     * (the PWA's orbMoodOfExpression): thinking, at work, reading, browsing and checking are work; waiting is queued;
     * asking for your approval waits on you; pleased is done; concerned is failed; resting is paused; idle, and anything else, is
     * idle.
     */
    fun moodOfExpression(expression: String?): Mood = when (expression) {
        "thinking", "working", "reading", "browsing", "checking" -> Mood.WORKING
        "waiting" -> Mood.QUEUED
        "asking" -> Mood.WAITING
        "pleased" -> Mood.DONE
        "concerned" -> Mood.FAILED
        "resting" -> Mood.PAUSED
        else -> Mood.IDLE
    }

    /** Whether a change of mood bursts: arriving at done from any other mood, or at idle straight from work (a task's end
     * you watched). Never on first sight (`from` null): opening a page shows where things stand, settled. */
    fun bursts(from: Mood?, to: Mood): Boolean = from != null && from != to && (to == Mood.DONE || (to == Mood.IDLE && from == Mood.WORKING))

    /** A mote: degrees clockwise from the top; where it is across its band (0 at the inner edge, 1 at the outer); a share
     * of the largest mote's size (0.5 to 1); how opaque (0 to 1). */
    data class Mote(val angle: Double, val u: Double, val size: Double, val alpha: Double)

    /**
     * What an orb carries from one frame to the next, so a change of mood turns or swells nothing with a jump: how far
     * each ring has turned and where its light's head is (degrees); how fast each is turning now, easing to its mood's;
     * its light's tail (kept while the light fades after a mood without one); how far through a breath it is (0 to 1);
     * and its swell, its light's brightness and an agent's ring's glow, each easing to its mood's.
     */
    data class Clock(
        val ring: Double, val ticks: Double, val segments: Double, val head: Double,
        val ringSpeed: Double, val ticksSpeed: Double, val segmentsSpeed: Double, val headSpeed: Double,
        val tail: Double, val breath: Double, val swell: Double, val light: Double, val aura: Double,
    )

    /** An orb as it is first seen, settled in its mood: its light's head and its breath where its seed puts them, so a
     * roster of seats never breathes or turns as one. */
    fun clock(mood: Mood, seed: Long = 0): Clock {
        val m = motion(mood)
        return Clock(
            ring = 0.0, ticks = 0.0, segments = 0.0, head = 360 * rand(seed, 0, 7),
            ringSpeed = m.turn.ring, ticksSpeed = m.turn.ticks, segmentsSpeed = m.turn.segments, headSpeed = m.comet?.speed ?: 0.0,
            tail = m.comet?.tail ?: 0.0, breath = rand(seed, 0, 8), swell = m.swell, light = if (m.comet != null) 1.0 else 0.0, aura = m.aura,
        )
    }

    /** The clock `dt` seconds on, in a mood: each speed, the swell and the light eased towards the mood's, then each ring
     * and the light's head turned on at its speed, and the breath further through. */
    fun step(clock: Clock, mood: Mood, dt: Double): Clock {
        val m = motion(mood)
        val d = min(LONGEST_STEP, max(0.0, dt))
        val ease = 1 - exp(-d / EASE)
        fun toward(value: Double, target: Double) = value + (target - value) * ease
        val ringSpeed = toward(clock.ringSpeed, m.turn.ring)
        val ticksSpeed = toward(clock.ticksSpeed, m.turn.ticks)
        val segmentsSpeed = toward(clock.segmentsSpeed, m.turn.segments)
        // A light fading after its mood slows to a stop where it was going; one coming in picks up speed.
        val headSpeed = toward(clock.headSpeed, m.comet?.speed ?: 0.0)
        return Clock(
            ring = turned(clock.ring + ringSpeed * d),
            ticks = turned(clock.ticks + ticksSpeed * d),
            segments = turned(clock.segments + segmentsSpeed * d),
            head = turned(clock.head + headSpeed * d),
            ringSpeed = ringSpeed,
            ticksSpeed = ticksSpeed,
            segmentsSpeed = segmentsSpeed,
            headSpeed = headSpeed,
            tail = m.comet?.tail ?: clock.tail,
            breath = fract(clock.breath + d / m.breath),
            swell = toward(clock.swell, m.swell),
            light = toward(clock.light, if (m.comet != null) 1.0 else 0.0),
            aura = toward(clock.aura, m.aura),
        )
    }

    /** An orb's light at a moment: its head and its tail in degrees, and how bright it is. */
    data class Light(val head: Double, val tail: Double, val alpha: Double)

    /**
     * A moment of an orb: the sphere's size about its middle; its glow, as a share of the still one's; how strongly a
     * agent's ring glows round it now (0 to 1); degrees each turning ring is turned; its light, none once it has faded;
     * how far each wave under way has gone (0 at its edge, 1 at its reach), the newest first; the mood's own motes; while
     * it arrives, the last mood's, fading; and a burst's sparks, flying out.
     */
    data class Frame(
        val scale: Double, val glow: Double, val aura: Double,
        val ring: Double, val ticks: Double, val segments: Double,
        val comet: Light?, val ripples: List<Double>,
        val motes: List<Mote>, val leaving: List<Mote>, val sparks: List<Mote>,
    )

    /** The still orb, as Orb's parts are drawn: nothing turned, swollen or under way. What animations off show. */
    val STILL = Frame(1.0, 1.0, 0.0, 0.0, 0.0, 0.0, null, emptyList(), emptyList(), emptyList(), emptyList())

    /**
     * An orb in a mood at [t] seconds, measured from any fixed moment, with its clock as it stands then: whose it is
     * ([seed]: an agent's handle's, the primary's own is 0), seconds since it arrived at this mood ([since]; null: long ago,
     * settled), the mood it arrived from ([from]), and whether it arrived with a burst. Its motes and waves are a function
     * of the time alone, seeded; the rest is the clock's. Pure, and the same in every app.
     */
    fun frame(mood: Mood, clock: Clock, t: Double, seed: Long = 0, since: Double? = null, from: Mood? = null, burst: Boolean = false): Frame {
        val m = motion(mood)
        val sinceThen = if (since == null) Double.POSITIVE_INFINITY else max(0.0, since)
        val arrived = min(1.0, sinceThen / ARRIVE)
        // A burst's motes fly out first; the mood's own come in over its second half.
        val settled = if (burst) clamp01((sinceThen - BURST / 2) / (BURST / 2)) else arrived
        val leaving = if (from != null && from != mood && arrived < 1) moodMotes(from, seed, t, 1 - arrived) else emptyList()
        val sparks = ArrayList<Mote>()
        if (burst && sinceThen < BURST) {
            // Out from the edge to the band's reach and gone: fast, then slowing, as a spark does.
            val progress = sinceThen / BURST
            val out = 1 - (1 - progress).pow(3)
            for (i in 0 until BURST_MOTES) {
                val a = rand(seed, i, 5)
                val z = rand(seed, i, 6)
                sparks += Mote(turned((360 * (i + a)) / BURST_MOTES + 25 * out), out, 0.6 + 0.4 * z, 1 - progress)
            }
        }

        // Each wave lasts one and a half times the time between two, so the next sets out before the last has gone; only
        // those set out since the mood arrived.
        val ripples = ArrayList<Double>()
        m.ripple?.let { every ->
            val life = 1.5 * every
            var k = floor(t / every)
            while (k * every > t - life) {
                val gone = (t - k * every) / life
                if (gone >= 0 && gone < 1 && t - k * every <= sinceThen) ripples += gone
                k--
            }
        }

        val breath = sin(2 * PI * clock.breath)
        val glow = 1 + min(0.4, 10 * clock.swell) * breath
        return Frame(
            scale = 1 + clock.swell * breath,
            glow = glow,
            aura = min(1.0, clock.aura * glow),
            ring = clock.ring,
            ticks = clock.ticks,
            segments = clock.segments,
            comet = if (clock.light > 0.01) Light(clock.head, clock.tail, clock.light) else null,
            ripples = ripples,
            motes = moodMotes(mood, seed, t, settled),
            leaving = leaving,
            sparks = sparks,
        )
    }

    /** A mood's own motes at [t], as opaque as [share] of their own. */
    private fun moodMotes(mood: Mood, seed: Long, t: Double, share: Double): List<Mote> {
        val m = motion(mood)
        val motes = ArrayList<Mote>(m.motes.count)
        for (i in 0 until m.motes.count) {
            val a = rand(seed, i, 0)
            val s = rand(seed, i, 1)
            val u0 = rand(seed, i, 2)
            val p = rand(seed, i, 3)
            val z = rand(seed, i, 4)
            val speed = m.motes.speed * (0.5 + s)
            // Each twinkles on a slow breath of its own, between 3 and 7 seconds.
            val twinkle = 0.5 + 0.5 * sin(2 * PI * (t / (3 + 4 * s) + p))
            val angle: Double
            val u: Double
            val alpha: Double
            when (m.motes.flow) {
                Flow.INWARD -> {
                    // From the band's outer edge to its inner one, turning as it comes, 4 to 7 seconds a pass, then again.
                    val phase = fract(t / (4 + 3 * s) + p)
                    angle = 360 * a + speed * t + 120 * phase
                    u = 1 - phase
                    alpha = sin(PI * phase) * (0.55 + 0.45 * twinkle)
                }
                Flow.FALL -> {
                    // Down one side, from high on it to the foot, faster as it goes, fading, 6 to 10 seconds a run.
                    val phase = fract(t / (6 + 4 * s) + p)
                    val side = if (a < 0.5) -1.0 else 1.0
                    val from = side * (20 + 70 * u0)
                    angle = from + (side * 180 - from) * phase * phase
                    u = clamp01(0.15 + 0.5 * u0 - 0.15 * phase)
                    alpha = (1 - phase) * (0.45 + 0.55 * twinkle)
                }
                Flow.ORBIT -> {
                    angle = 360 * a + speed * t
                    u = clamp01(u0 + m.motes.sway * 0.5 * sin(2 * PI * (t / (1.7 * m.breath) + p)))
                    alpha = 0.35 + 0.65 * twinkle
                }
            }
            motes += Mote(turned(angle), u, 0.5 + 0.5 * z, alpha * share)
        }
        return motes
    }

    /** The ring its light runs round on an orb's stage, and how wide. */
    data class StageComet(val r: Double, val width: Double)

    /**
     * Where a frame's moving parts are drawn, at each size of orb and round an agent's face, in the units of the orb's
     * square (200 wide, centred on its middle; on an agent's seat, 100 is its ring's outer edge): how far from the middle
     * anything is drawn (past 100 it draws outside its square, and nothing round it moves for that); its motes' band; the
     * largest mote's radius; how many of a mood's motes it shows; where its waves set out and how far they reach, and how
     * wide a wave's line is as it sets out; and the ring its light runs round (none on an agent's seat, whose light runs
     * round its own ring).
     */
    data class Stage(
        val reach: Double, val bandFrom: Double, val bandTo: Double, val mote: Double, val share: Double,
        val wavesFrom: Double, val wavesTo: Double, val wave: Double, val comet: StageComet?,
    )

    val stages: Map<String, Stage> = mapOf(
        "full" to Stage(150.0, 64.0, 134.0, 3.4, 1.0, 60.0, 140.0, 2.4, StageComet(70.5, 2.4)),
        "seat" to Stage(124.0, 70.0, 114.0, 4.6, 0.6, 66.0, 120.0, 4.0, StageComet(80.0, 4.5)),
        "badge" to Stage(112.0, 84.0, 104.0, 7.0, 0.0, 78.0, 110.0, 7.0, StageComet(94.0, 6.0)),
        "ring" to Stage(124.0, 88.0, 116.0, 5.5, 0.35, 100.0, 122.0, 5.0, null),
    )

    fun stage(level: Orb.Level): Stage = stages.getValue(level.wire)

    /** An agent's seat's stage: its lights round its face. */
    val RING: Stage get() = stages.getValue("ring")

    /**
     * How a frame moves the orb's parts (Orb's names), and where its lights are drawn among them: the outer ring and its
     * notches turn with the frame's `ring`, the ticks and their marks with its `ticks`, the segments and the data ring
     * with its `segments`; the sphere, its nucleus and the light it sits in swell with its `scale`, and its glows (the
     * halo, the light round the sphere, the nucleus) brighten with its `glow`. The sphere turns with its `ring`, three
     * times as far (OrbSphere.TURN). The waves are drawn after the halo, under every ring; the light and the motes after
     * the rings, just before the sphere's light, which they pass behind.
     */
    object Moves {
        val ring = listOf("ring", "notches")
        val ticks = listOf("ticks", "marks")
        val segments = listOf("segments", "data")
        val swell = listOf("glow", "nucleus", "sphere")
        val glow = listOf("halo", "glow", "nucleus")
        const val LIGHTS_BEFORE = "glow"
    }

    /**
     * How many frames a second an orb is drawn at, on a stage ("full", "seat", "badge", or "ring", an agent's seat): as
     * few as look smooth, since every frame costs the phone its battery. At work, or arriving at a mood (a burst, a fade:
     * [since] under BURST seconds), the light runs fast: 30. A slow breath and drifting motes look the same at 15. Its
     * home's orb, the largest, at twice these.
     */
    fun fps(mood: Mood, stage: String, since: Double?): Int {
        val lively = mood == Mood.WORKING || (since != null && since < BURST)
        return (if (lively) 30 else 15) * (if (stage == "full") 2 else 1)
    }

    /** Which of a frame's motes a stage shows: its share of the mood's own and of the last mood's while they fade (rounded
     * as JavaScript's Math.round does), and every spark; none on a stage too small for motes. */
    fun shownMotes(frame: Frame, stage: Stage): List<Mote> {
        if (stage.share == 0.0) return emptyList()
        fun share(motes: List<Mote>) = motes.take(Math.round(motes.size * stage.share).toInt())
        return share(frame.motes) + share(frame.leaving) + frame.sparks
    }

    /** A whole number for a name, for its seed: FNV-1a over its UTF-16 code units, as an unsigned 32-bit number. */
    fun seed(name: String): Long {
        var hash = 0x811c9dc5.toInt()
        for (unit in name) hash = (hash xor unit.code) * 0x01000193
        return hash.toLong() and 0xffffffffL
    }

    /** The [k]th random number of mote [i] of an orb seeded [seed], from 0 up to 1: the same for the same three in every
     * app (a 32-bit integer hash, lowbias32, wrapping as JavaScript's Math.imul does). */
    fun rand(seed: Long, i: Int, k: Int): Double {
        var n = seed.toInt() xor ((i + 1) * 0x9e3779b1.toInt()) xor ((k + 1) * 0x85ebca77.toInt())
        n = (n xor (n ushr 16)) * 0x7feb352d
        n = (n xor (n ushr 15)) * 0x846ca68b.toInt()
        return ((n xor (n ushr 16)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
    }

    private fun clamp01(x: Double): Double = min(1.0, max(0.0, x))
    private fun fract(x: Double): Double = x - floor(x)

    /** An angle as 0 up to 360 degrees. */
    private fun turned(degrees: Double): Double {
        val r = degrees % 360
        return if (r < 0) r + 360 else r
    }
}
