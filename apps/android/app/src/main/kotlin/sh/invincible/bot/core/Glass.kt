package sh.invincible.bot.core

/*
 * An agent's glass (core's glass.ts; the owner's word of 27 November 2026 that the Grille goes): its shape, one of 22 of
 * our own, and its colour, one of eight ramps on the palette's hues, as its node gave them ({v: 4, color, shape}), the
 * same on every device. Its numbers are core's (GlassData.kt), and GlassTest holds them and this file's reading and rule
 * to the vectors' `glass`: this file is the reading and the rule, ui/GlassView.kt the drawing.
 */

/** An agent's glass: its colour (an index into AgentMark.PALETTE, and so into RAMPS) and its shape (into SHAPES). */
data class Glass(val color: Int, val shape: Int) {
    /** A shape: a tube (a round line [width] wide along its path), or a fill softened by a round stroke [width] wide (0:
     * none); [smallWidth] at 16 dp; its path in a 100 × 100 box, absolute M, L, C, Q and Z alone. */
    data class Shape(val id: String, val name: String, val family: String, val tube: Boolean, val width: Float, val smallWidth: Float, val d: String)

    data class Stops(val highlight: String, val a: String, val b: String, val accent: String, val deep: String)

    data class Ramp(val id: String, val name: String, val light: Stops, val dark: Stops) {
        fun on(dark: Boolean): Stops = if (dark) this.dark else light
    }

    /** What its dot says: working, needs you and failed are their own; idle is the rest, the word beside it saying which. */
    enum class State(val wire: String) { WORKING("working"), NEEDS("needs"), IDLE("idle"), FAILED("failed") }

    /** A piece of a shape's path, in its box. */
    sealed interface Segment {
        data class Move(val x: Float, val y: Float) : Segment
        data class Line(val x: Float, val y: Float) : Segment
        data class Quad(val x1: Float, val y1: Float, val x: Float, val y: Float) : Segment
        data class Cubic(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val x: Float, val y: Float) : Segment
        data object Close : Segment
    }

    /** The paint over the shape's box (core's GLASS_PAINT), its layers in this order: `a` to `b` along the diagonal;
     * `accent` in a pool at the bottom right, to nothing at its radius; `highlight` in a pool at the top left (its opacity
     * at each stop); the `deep` shade in the bottom-right corner, at the page's opacity, to nothing. */
    object Paint {
        const val ACCENT_X = 82f
        const val ACCENT_Y = 78f
        const val ACCENT_R = 55f
        const val ACCENT_OPACITY = 0.95f
        const val HIGHLIGHT_X = 27f
        const val HIGHLIGHT_Y = 20f
        const val HIGHLIGHT_R = 50f
        val HIGHLIGHT_STOPS = listOf(0f to 0.95f, 0.45f to 0.38f, 1f to 0f)
        const val SHADE_X = 96f
        const val SHADE_Y = 100f
        const val SHADE_R = 82f
        fun shadeOpacity(dark: Boolean): Float = if (dark) 0.72f else 0.42f
    }

    /** Its glow, by its size in dp (core's GLASS_GLOW): on a dark page a pool of its light behind it from 24, on a light
     * one a tinted shadow under it from 20; from 40 a blurred copy of it. Only working breathes, every [PERIOD] seconds. */
    object Glow {
        const val POOL_FROM = 24f
        /** The pool's circle reaches this far past the box on each side, as a share of its size. */
        const val POOL_SPREAD = 0.3f
        /** Its stops: where, whether in `b` (else `a`), and at what opacity. */
        val POOL_STOPS = listOf(Triple(0f, false, 0.46f), Triple(0.64f, true, 0.16f), Triple(1f, true, 0f))
        const val POOL_OPACITY = 0.7f
        const val POOL_BREATHE = 0.45f
        const val SHADOW_FROM = 20f
        /** The shadow's ellipse, as shares of the box: in 4 % from each side, from 64 % of its height to 116 %. */
        const val SHADOW_LEFT = 0.04f
        const val SHADOW_RIGHT = 0.04f
        const val SHADOW_TOP = 0.64f
        const val SHADOW_BOTTOM = 1.16f
        val SHADOW_STOPS = listOf(0f to 0.3f, 1f to 0f)
        const val SHADOW_OPACITY = 0.9f
        const val SHADOW_BREATHE = 0.55f
        const val BLUR_FROM = 40f
        /** The blur: a Gaussian of this standard deviation in the box; its opacity, and how far down it is moved, by page. */
        const val BLUR_RADIUS = 6.5f
        fun blurOpacity(dark: Boolean): Float = if (dark) 0.7f else 0.32f
        fun blurDrop(dark: Boolean): Float = if (dark) 0f else 7f
        const val PERIOD = 3.6
    }

    /** The dot (core's GLASS_DOT): its colours (idle a ring in its colour), and its size by the avatar's: diameter, how far
     * past the box's bottom-right corner it sits, and the ring cut out round it. */
    object Dot {
        val COLORS = mapOf(
            State.WORKING to AgentMark.Paired("#155dfc", "#51a2ff"),
            State.NEEDS to AgentMark.Paired("#0a0a0b", "#ffffff"),
            State.FAILED to AgentMark.Paired("#e7000b", "#ff6467"),
            State.IDLE to AgentMark.Paired("#a1a1a1", "#737373"),
        )
        const val IDLE_RING = 1.5f

        data class Size(val upTo: Float, val size: Float, val out: Float, val cut: Float)

        val SIZES = listOf(Size(16f, 6f, 2f, 1.5f), Size(28f, 8f, 2f, 2f), Size(40f, 10f, 1f, 2f), Size(1000f, 13f, -1f, 3f))

        fun size(avatar: Float): Size = SIZES.firstOrNull { avatar <= it.upTo } ?: SIZES.last()
    }

    /** How a glass that waits on you nudges (core's GLASS_NUDGE): a knock [MS] long through [TURNS] (shares of [TURN]
     * degrees, at even steps), [COUNT] times, one every [EVERY] ms timed from the clock, then still: "knock three times,
     * then rest". */
    object Nudge {
        const val EVERY = 4000L
        const val MS = 600L
        const val TURN = 7f
        val TURNS = listOf(0f, -1f, 1f, -0.5f, 0f)
        const val COUNT = 3
    }

    companion object {
        /**
         * Whether a glass knocks now (core's nudgeNow, held to the vectors): when it starts to wait on you, and again when
         * more waits on it than when it last knocked ([before]; null: it waited on nothing); never again for the same.
         * Returns whether it knocks, and what to keep for next time.
         */
        fun nudgeNow(before: Int?, state: State?, needs: Int): Pair<Boolean, Int?> =
            if (state != State.NEEDS) false to null else (needs > (before ?: 0)) to needs

        /** The shapes, in core's order: a saved shape is its index. */
        val SHAPES: List<Shape> get() = GLASS_SHAPES
        val IBEAM: Shape get() = GLASS_IBEAM
        val RAMPS: List<Ramp> get() = GLASS_RAMPS
        /**
         * Your agent's pearl glass, core's: on a light page the pearl inked, a darker glass at its own hues, so the bare
         * I-beam reads on paper with no tile behind it (the owner's word, 27 November 2026: the logo is just the I-beam);
         * on a dark page the pearl.
         */
        val PEARL: Ramp get() = GLASS_PEARL

        fun state(mark: AgentMark.State): State = when (mark) {
            AgentMark.State.WORKING -> State.WORKING
            AgentMark.State.NEEDS -> State.NEEDS
            AgentMark.State.FAILED -> State.FAILED
            else -> State.IDLE
        }

        private fun paletteIndex(hex: String): Int = AgentMark.PALETTE.indexOfFirst { it.light == hex }

        /** A saved glass, read strictly (core's isGlassProfile): exactly v 4, a colour that is one of the eight (its light
         * form) and a whole shape. */
        fun isGlassProfile(profile: Json?): Boolean {
            val f = (profile as? Json.Obj)?.fields ?: return false
            if (f.size != 3 || f["v"].double != 4.0) return false
            val color = f["color"].string ?: return false
            val shape = f["shape"].double ?: return false
            return paletteIndex(color) >= 0 && shape == Math.floor(shape) && shape >= 0 && shape < GLASS_SHAPES.size
        }

        fun read(profile: Json?): Glass? =
            if (isGlassProfile(profile)) Glass(paletteIndex(profile["color"].string!!), profile["shape"].int!!) else null

        /** A glass as an agent's avatar saves it. */
        fun profile(glass: Glass): Json = Json.obj("v" to 4, "color" to AgentMark.PALETTE[glass.color].light, "shape" to glass.shape)

        /** A handle's own glass, before any is given: its seed's shape and colour (core's seeded). */
        fun seeded(id: String): Glass {
            val seed = Avatar.handleSeed(id)
            return Glass(((seed ushr 7) % AgentMark.PALETTE.size).toInt(), (seed % GLASS_SHAPES.size).toInt())
        }

        /** An agent's glass from what it has (core's glassOf): its own (v 4); a mark's colour (v 3) or a colour chosen
         * before (v 2), snapped, with its handle's shape; else its handle's, an avatar of a version yet to come too. */
        fun of(id: String, profile: Json?): Glass {
            read(profile)?.let { return it }
            val handle = seeded(id)
            AgentMark.readMarkProfile(profile)?.let { return Glass(it.color, handle.shape) }
            if (Avatar.isOrbProfile(profile)) return Glass(AgentMark.snapColor(profile["color"].string!!), handle.shape)
            return handle
        }

        /**
         * The glass a node gives an agent as it joins, after [others] (core's assignGlass): among the shapes no agent
         * wears, the one from the least-used family, tried in its seed's order (once all are worn, the least worn, then the
         * least-used family); its colour the one you chose (snapped, or one of the eight by its index), else the least
         * worn, tried from its seed's, never the same as either of the two before it. The editor previews with it.
         */
        fun assign(id: String, others: List<Glass>, chosen: String? = null, chosenIndex: Int? = null): Glass {
            val seed = Avatar.handleSeed(id)
            val count = GLASS_SHAPES.size
            val wear = IntArray(count) { n -> others.count { it.shape == n } }
            fun familyUse(family: String) = others.count { it.shape in 0 until count && GLASS_SHAPES[it.shape].family == family }
            val free = wear.any { it == 0 }
            var shape = -1
            for (i in 0 until count) {
                val c = ((seed + i) % count).toInt()
                if (free && wear[c] > 0) continue
                if (shape < 0 || wear[c] < wear[shape] || (wear[c] == wear[shape] && familyUse(GLASS_SHAPES[c].family) < familyUse(GLASS_SHAPES[shape].family))) shape = c
            }
            val colors = AgentMark.PALETTE.size
            val color = when {
                chosenIndex != null && chosenIndex in 0 until colors -> chosenIndex
                !chosen.isNullOrEmpty() -> AgentMark.snapColor(chosen)
                else -> {
                    val recent = others.takeLast(2).map { it.color }
                    val worn = IntArray(colors) { n -> others.count { it.color == n } }
                    var best = -1
                    for (i in 0 until colors) {
                        val c = (((seed ushr 7) + i) % colors).toInt()
                        if (c in recent) continue
                        if (best < 0 || worn[c] < worn[best]) best = c
                    }
                    best
                }
            }
            return Glass(color, shape)
        }

        /** A shape's path, read (core's: absolute M, L, C, Q and Z, its numbers apart by spaces or a minus sign). */
        fun segments(d: String): List<Segment> {
            val out = ArrayList<Segment>()
            val numbers = ArrayList<Float>()
            var command = ' '
            val token = StringBuilder()
            fun endNumber() {
                if (token.isNotEmpty()) token.toString().toFloatOrNull()?.let { numbers += it }
                token.setLength(0)
            }
            fun flush() {
                val n = numbers
                when {
                    command == 'M' && n.size >= 2 -> out += Segment.Move(n[0], n[1])
                    command == 'L' && n.size >= 2 -> out += Segment.Line(n[0], n[1])
                    command == 'Q' && n.size >= 4 -> out += Segment.Quad(n[0], n[1], n[2], n[3])
                    command == 'C' && n.size >= 6 -> out += Segment.Cubic(n[0], n[1], n[2], n[3], n[4], n[5])
                    command == 'Z' -> out += Segment.Close
                }
                numbers.clear()
            }
            for (ch in d) {
                when {
                    ch in "MLCQZ" -> {
                        endNumber()
                        flush()
                        command = ch
                    }
                    ch == ' ' -> endNumber()
                    ch == '-' && token.isNotEmpty() -> {
                        endNumber()
                        token.append('-')
                    }
                    else -> token.append(ch)
                }
            }
            endNumber()
            flush()
            return out
        }
    }
}
