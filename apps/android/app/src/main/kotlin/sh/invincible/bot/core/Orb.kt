package sh.invincible.bot.core

/**
 * The primary's orb, as data (the PWA's lib/orb.ts, the Apple app's Orb.swift, held to them by the vectors; your word,
 * 23 November 2026: it is the one you talk to, "a Jarvis … like visual, the orb graphic"): a sphere of glyphs round a
 * bright nucleus inside the rings of a heads-up display, with a ring of data turning in it, in the colour of its state.
 * On 25 November 2026 its glass sphere became glyphs, as every agent's orb is (your words: "custom/procedurally
 * generated colored particle orbs", "also update the primary's orb", "use glyph and randomness on the orbs, like
 * Jarvis/Ultron in the movies, and my other project Phren"); the glyphs are OrbSphere's, its own handle's sphere. The
 * parts it is drawn from, in a square 200 wide centred on its middle (y down), and each state's colours; ui/Orb.kt draws
 * them, moved as OrbMotion says where it is doing something (your word, 24 November 2026), and still otherwise.
 */
object Orb {
    /** Its line's tone (Roster.Now's), and red for a failure. */
    enum class Tone { NEUTRAL, ACCENT, WARN, OK, DANGER; val wire: String get() = name.lowercase() }

    /** How much of it a size can show: a badge (beside its words), a seat (among the agents), or all of it (its home). */
    enum class Level { BADGE, SEAT, FULL; val wire: String get() = name.lowercase() }

    /** What a part is coloured with: one of its palette's colours, or white. */
    enum class Ink { TINT, LIGHT, DEEP, WHITE }

    /** A state's colours: its tint, the tint lit (45 % of it, with white) and in shadow (52 %, with black), mixed in OKLab. */
    data class Palette(val tint: Long, val light: Long, val deep: Long)

    /** A gradient's stop: how far along it (0 to 1), its colour, and how opaque. */
    data class Stop(val at: Double, val ink: Ink, val opacity: Double)

    /** An arc of a ring, in degrees clockwise from the top. */
    data class Arc(val from: Double, val to: Double)

    /** A part, drawn in order, each over those before it; its name is the PWA's (its SVG class). */
    sealed interface Part {
        val name: String

        /** A circle filled by a radial gradient, lit from (cx, cy) as fractions of its box, reaching `spread` of its width. */
        data class Disc(override val name: String, val r: Double, val cx: Double, val cy: Double, val spread: Double, val stops: List<Stop>) : Part

        /** A circle's stroke, whole (no arcs) or only its arcs. */
        data class Ring(override val name: String, val r: Double, val width: Double, val ink: Ink, val opacity: Double, val arcs: List<Arc>?) : Part

        /** `count` short strokes across a circle, evenly round from `offset` degrees, each `length` long and `width` wide. */
        data class Ticks(override val name: String, val r: Double, val count: Int, val offset: Double, val length: Double, val width: Double, val ink: Ink, val opacity: Double) : Part

        /** `count` places round a circle `r` from the middle, about `share` of them lit with a hex digit `size` high, each
         * changing on a slow beat of its own (OrbSphere.dataGlyph): its data ring. */
        data class Glyphs(override val name: String, val r: Double, val count: Int, val size: Double, val share: Double, val ink: Ink) : Part

        /** `count` glyphs on a sphere `r` from the middle, its nearest `glyph` high (OrbSphere), its own handle's sphere;
         * some of them are `second`'s colour. */
        data class Sphere(override val name: String, val r: Double, val count: Int, val glyph: Double, val second: Ink) : Part
    }

    /** From these sizes (dp), a seat's rings and then the full display's ticks can be told apart. */
    const val SEAT_FROM = 48.0
    const val FULL_FROM = 120.0

    fun level(size: Double): Level = if (size >= FULL_FROM) Level.FULL else if (size >= SEAT_FROM) Level.SEAT else Level.BADGE

    /** The parts of an orb this size, in the order they're drawn. */
    fun parts(size: Double): List<Part> = when (level(size)) {
        Level.BADGE -> BADGE
        Level.SEAT -> SEAT
        Level.FULL -> FULL
    }

    /**
     * Each state's light: a calm blue at rest, a brighter blue at work, amber when something waits on you, green for an
     * answer new to you, red for a failure. The bright tints in both themes. (0xRRGGBB.)
     */
    val palettes: Map<Tone, Palette> = mapOf(
        Tone.NEUTRAL to Palette(0x8ab8ff, 0xcae0ff, 0x354969),
        Tone.ACCENT to Palette(0x58a6ff, 0xb6d8ff, 0x1f4169),
        Tone.WARN to Palette(0xf0b549, 0xf9dfb4, 0x624818),
        Tone.OK to Palette(0x4cc38a, 0xb6e5c9, 0x1a4e35),
        Tone.DANGER to Palette(0xff6b6b, 0xffc0bb, 0x692727),
    )

    fun palette(tone: Tone): Palette = palettes.getValue(tone)

    /** Its line's tone ("neutral", "accent", "warn", "ok"), as the orb shows it; one it doesn't know is its rest. */
    fun tone(wire: String?): Tone = Tone.entries.firstOrNull { it.wire == wire } ?: Tone.NEUTRAL

    /** Where it stands among the agents, as its ring there would show it. */
    fun tone(state: AgentState?): Tone = when (state?.tone) {
        AgentState.Tone.WORK -> Tone.ACCENT
        AgentState.Tone.NEEDS -> Tone.WARN
        AgentState.Tone.FAILED -> Tone.DANGER
        AgentState.Tone.OK -> Tone.OK
        AgentState.Tone.NEUTRAL, null -> Tone.NEUTRAL
    }

    // ---- the parts (lib/orb.ts' PARTS) ----

    /** The four gaps of the outer ring, at the top, the sides and the foot, where its notches stand. */
    private fun quarters(gap: Double) = listOf(0.0, 90.0, 180.0, 270.0).map { Arc(it + gap, it + 90 - gap) }

    /** Three arcs a third of the way round from each other: the display's segments. */
    private val thirds = listOf(Arc(20.0, 90.0), Arc(140.0, 210.0), Arc(260.0, 330.0))

    private val halo = Part.Disc("halo", 99.0, 0.5, 0.5, 0.5, listOf(Stop(0.0, Ink.TINT, 0.55), Stop(0.62, Ink.TINT, 0.2), Stop(1.0, Ink.TINT, 0.0)))

    /** The light the sphere sits in, brightest at its middle: its glyphs are seen against it. */
    private fun glow(r: Double) = Part.Disc("glow", r, 0.5, 0.5, 0.5, listOf(Stop(0.0, Ink.TINT, 0.45), Stop(0.55, Ink.TINT, 0.16), Stop(1.0, Ink.TINT, 0.0)))

    /** The bright nucleus at its heart (Phren's): white at its middle, into its tint, and gone. */
    private fun nucleus(r: Double) = Part.Disc("nucleus", r, 0.5, 0.5, 0.5, listOf(Stop(0.0, Ink.WHITE, 0.95), Stop(0.3, Ink.TINT, 0.65), Stop(1.0, Ink.TINT, 0.0)))
    private fun sphere(r: Double, count: Int, glyph: Double) = Part.Sphere("sphere", r, count, glyph, Ink.WHITE)

    private val FULL: List<Part> = listOf(
        halo,
        Part.Ring("ring", 95.0, 1.1, Ink.TINT, 0.5, quarters(6.0)),
        Part.Ticks("notches", 95.0, 4, 0.0, 9.0, 1.6, Ink.TINT, 0.8),
        Part.Ticks("ticks", 89.0, 72, 0.0, 3.0, 0.8, Ink.TINT, 0.45),
        Part.Ticks("marks", 89.0, 12, 0.0, 7.0, 1.4, Ink.TINT, 0.75),
        Part.Glyphs("data", 80.5, 48, 7.0, 0.62, Ink.LIGHT),
        Part.Ring("segments", 72.0, 2.4, Ink.TINT, 0.55, thirds),
        glow(64.0),
        nucleus(37.0),
        sphere(54.0, 170, 14.0),
    )

    private val SEAT: List<Part> = listOf(
        halo,
        Part.Ring("ring", 94.0, 2.4, Ink.TINT, 0.55, quarters(8.0)),
        Part.Ticks("notches", 94.0, 4, 0.0, 12.0, 3.2, Ink.TINT, 0.85),
        Part.Ring("segments", 80.0, 4.5, Ink.TINT, 0.5, thirds),
        glow(74.0),
        nucleus(44.0),
        sphere(64.0, 72, 22.0),
    )

    private val BADGE: List<Part> = listOf(
        Part.Ring("ring", 94.0, 5.0, Ink.TINT, 0.5, null),
        glow(88.0),
        nucleus(53.0),
        sphere(70.0, 30, 30.0),
    )
}
