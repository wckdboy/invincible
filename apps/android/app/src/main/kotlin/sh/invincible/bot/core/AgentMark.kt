package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/*
 * An agent's mark: the Grille (core's agent-mark.ts; O2, the owner's choice of 26 November 2026, "2 · Grille"). A solid
 * disc in the agent's own colour, cut into slats by two or three slots at its own angle, the I-beam's bars through the
 * orb. The primary stays the I-beam in one ink: never a Grille.
 *
 * Its colour and its form are the node's to give, once, as the agent joins (assignMark, in the order agents joined), and
 * are saved as its avatar ({v: 3, color, form}), so every device draws the same mark. Everything here is data and pure
 * geometry, a port of core's, and MarkVectorsTest holds it to core through the vectors' `marks`: the palette, the forms,
 * the marks a node gives, the snap, the states' colours and the slats' geometry in 108 cases.
 */
object AgentMark {
    /** A hue: its name, its form on a light page (at least 3:1 against it) and on a dark one. Saved as its light form. */
    data class Hue(val name: String, val light: String, val dark: String)

    /** The palette: eight hues, none between pink-red and red-orange (those are failure's red). */
    val PALETTE = listOf(
        Hue("Amber", "#c88200", "#ffbc63"),
        Hue("Lime", "#699700", "#b1ef4a"),
        Hue("Green", "#007745", "#18c376"),
        Hue("Teal", "#04a19b", "#34eee5"),
        Hue("Sky", "#0084ba", "#3bb7f7"),
        Hue("Blue", "#3453d3", "#5b81fe"),
        Hue("Violet", "#9a68da", "#ccabff"),
        Hue("Magenta", "#a23493", "#e26ace"),
    )

    /** A colour on each page: light and dark. */
    data class Paired(val light: String, val dark: String) {
        fun on(dark: Boolean): String = if (dark) this.dark else light
    }

    /** Each hue while queued (pale), and every mark while paused (grey), mixed in OKLab once, in core. */
    val QUEUED = listOf(
        Paired("#ebcdaa", "#634721"), Paired("#c1d6a9", "#425c17"), Paired("#a5c8b1", "#044a29"), Paired("#b0d9d6", "#0e5c58"),
        Paired("#aacee5", "#114560"), Paired("#a7bdf2", "#1e2e63"), Paired("#d5c3f3", "#4e4063"), Paired("#deafd4", "#57244e"),
    )
    val PAUSED = Paired("#8c8c8d", "#484848")

    /** The page a mark is drawn on, the ink (what asks you turns it), and the shared red (what failed). */
    val PAGE = Paired("#ffffff", "#000000")
    val INK = Paired("#0a0a0b", "#ffffff")
    val RED = Paired("#c4141b", "#ee2c36")

    /** The forms: the slots' angle, one of six, and two or three slots; form n is ANGLES[n % 6] with SLOTS[n / 6]. */
    val ANGLES = listOf(-40, -27, -14, 14, 27, 40)
    val SLOTS = listOf(2, 3)
    val FORMS = ANGLES.size * SLOTS.size

    data class Form(val slots: Int, val angle: Int)

    fun form(form: Int): Form = Form(SLOTS[(form / ANGLES.size) % SLOTS.size], ANGLES[form % ANGLES.size])

    /** An agent's mark: its colour (an index into PALETTE) and its form (0 to 11). */
    data class Mark(val color: Int, val form: Int)

    private fun paletteIndex(hex: String): Int = PALETTE.indexOfFirst { it.light == hex }

    /** A saved mark, read strictly: exactly v 3, a colour that is one of the eight (its light form, lower case) and a
     * whole form. */
    fun isMarkProfile(profile: Json?): Boolean {
        val f = (profile as? Json.Obj)?.fields ?: return false
        if (f.size != 3 || f["v"].double != 3.0) return false
        val color = f["color"].string ?: return false
        val form = f["form"].double ?: return false
        return paletteIndex(color) >= 0 && form == Math.floor(form) && form >= 0 && form < FORMS
    }

    fun readMarkProfile(profile: Json?): Mark? =
        if (isMarkProfile(profile)) Mark(paletteIndex(profile["color"].string!!), profile["form"].int!!) else null

    /** A mark as an agent's avatar saves it. */
    fun markProfile(mark: Mark): Json = Json.obj("v" to 3, "color" to PALETTE[mark.color].light, "form" to mark.form)

    /** Which of the eight a colour is nearest (by the sum of each channel's difference squared, to either of each hue's
     * forms, the first on a tie): a colour you pick snaps to one of them, never to red. */
    fun snapColor(hex: String): Int {
        fun rgb(h: String) = intArrayOf(h.substring(1, 3).toInt(16), h.substring(3, 5).toInt(16), h.substring(5, 7).toInt(16))
        val (r, g, b) = rgb(hex.lowercase())
        var best = 0
        var bestApart = Long.MAX_VALUE
        PALETTE.forEachIndexed { n, hue ->
            for (form in listOf(hue.light, hue.dark)) {
                val (fr, fg, fb) = rgb(form)
                val apart = (r - fr).toLong() * (r - fr) + (g - fg).toLong() * (g - fg) + (b - fb).toLong() * (b - fb)
                if (apart < bestApart) {
                    best = n
                    bestApart = apart
                }
            }
        }
        return best
    }

    /** The handle's own mark, before any is given: its seed's colour and form. */
    private fun seeded(id: String): Mark {
        val seed = Avatar.handleSeed(id)
        return Mark((seed % PALETTE.size).toInt(), ((seed ushr 8) % FORMS).toInt())
    }

    /** An agent's mark, from what it has: its own (v 3); a colour chosen before the marks (v 2), snapped, with its
     * handle's form; else its handle's. */
    fun markOf(id: String, profile: Json?): Mark {
        readMarkProfile(profile)?.let { return it }
        val handle = seeded(id)
        if (Avatar.isOrbProfile(profile)) return Mark(snapColor(profile["color"].string!!), handle.form)
        return handle
    }

    /**
     * The mark a node gives an agent as it joins, after [others] (the marks of those before it, in the order they joined):
     * its seed's colour or the next one free, so no two share a colour until all eight are taken (or the one you chose,
     * snapped); its seed's form or the next one no agent wears; once every form is worn, the next one no agent of its
     * colour wears.
     */
    fun assignMark(id: String, others: List<Mark>, chosen: String? = null): Mark {
        val seed = Avatar.handleSeed(id)
        var color = (seed % PALETTE.size).toInt()
        if (!chosen.isNullOrEmpty()) color = snapColor(chosen)
        else {
            val taken = others.map { it.color }.toSet()
            if (taken.size < PALETTE.size) while (color in taken) color = (color + 1) % PALETTE.size
        }
        val anyWorn = others.map { it.form }.toSet()
        val worn = others.filter { it.color == color }.map { it.form }.toSet()
        var form = ((seed ushr 8) % FORMS).toInt()
        if (anyWorn.size < FORMS) while (form in anyWorn) form = (form + 1) % FORMS
        else if (worn.size < FORMS) while (form in worn) form = (form + 1) % FORMS
        return Mark(color, form)
    }

    // ---- its states ----

    /** What a mark shows: idle (solid, still); working (its slats slide); needs (its top slat turns ink and beats); queued
     * (pale); paused (grey); done (its slots close and open once as it arrives); failed (its bottom slat turns red and
     * drops loose). The shape carries the state, never colour alone. */
    enum class State(val wire: String) { IDLE("idle"), WORKING("working"), NEEDS("needs"), QUEUED("queued"), PAUSED("paused"), DONE("done"), FAILED("failed") }

    /** Its motion's numbers, seconds. */
    const val WORK_CYCLE = 5.5
    const val NEEDS_BEAT = 4.2
    const val DONE_SETTLE = 1.4
    const val FAIL_DROP = 0.6

    /** The state a mark shows for what it is seen doing (core's avatarExpression). */
    fun state(expression: String?): State = when (expression) {
        "thinking", "working", "reading", "browsing", "checking" -> State.WORKING
        "asking" -> State.NEEDS
        "waiting" -> State.QUEUED
        "resting" -> State.PAUSED
        "pleased" -> State.DONE
        "concerned" -> State.FAILED
        else -> State.IDLE
    }

    /** The state a mark shows for an agent's state where it sits: work that passed review is done; new to you, or at
     * rest, idle (the web's markStateOfAgent). */
    fun state(agent: AgentState?): State = when (agent) {
        AgentState.WORKING -> State.WORKING
        AgentState.NEEDS -> State.NEEDS
        AgentState.FAILED -> State.FAILED
        AgentState.PAUSED -> State.PAUSED
        AgentState.QUEUED -> State.QUEUED
        AgentState.VERIFIED -> State.DONE
        else -> State.IDLE
    }

    /** The colours it is drawn in: its body, and its key slat (the top one in ink when it asks you, the bottom one red
     * when it failed). */
    data class Colors(val body: String, val key: String)

    fun colors(color: Int, state: State, dark: Boolean): Colors {
        val hue = PALETTE[color].let { if (dark) it.dark else it.light }
        val body = when (state) {
            State.QUEUED -> QUEUED[color].on(dark)
            State.PAUSED -> PAUSED.on(dark)
            else -> hue
        }
        return Colors(body, if (state == State.NEEDS) INK.on(dark) else if (state == State.FAILED) RED.on(dark) else body)
    }

    // ---- its geometry ----

    /** A slat, in a 100-unit box, about the box's middle and turned by the mark's angle: a band of the disc from [from]
     * to [to] (across the slots, downward before turning), slid [slide] along its slot, filled as the body or the key
     * ([key]); knocked loose, turned [turn] degrees about [pivot] (a point of the box), then moved down [drop]. */
    data class Slat(val from: Double, val to: Double, val slide: Double, val key: Boolean, val drop: Double, val turn: Double, val pivotX: Double, val pivotY: Double)

    data class Geometry(val angle: Int, val radius: Double, val slats: List<Slat>)

    private const val TAU = PI * 2
    private fun beat(t: Double, period: Double) = 0.5 - 0.5 * cos(TAU * t / period)
    private fun easeOut(x: Double) = 1 - (1 - min(1.0, max(0.0, x))).pow(3)

    /**
     * Its slats as they stand: [size] the mark's square in points (a slot is 7.5 units, or 1.35 pt where that is wider);
     * [t] seconds on the page's clock (null: still, as every row and reduced motion draw it); [since] seconds since it
     * came to its state (null: long ago, settled). [seed]: its handle's, which sets its slats' phase.
     */
    fun geometry(mark: Mark, seed: Long, state: State, size: Double, t: Double?, since: Double?): Geometry {
        val form = form(mark.form)
        val radius = 44.0
        var gap = max(7.5, 1.35 * 100 / size)
        if (state == State.DONE) gap *= 1 - 0.85 * (if (since != null && since < DONE_SETTLE) sin(PI * (since / DONE_SETTLE)) else 0.0)
        val n = form.slots + 1
        val width = (2 * radius - form.slots * gap) / n
        val turned = form.angle * PI / 180
        val slats = ArrayList<Slat>(n)
        for (i in 0 until n) {
            val from = -radius + i * (width + gap)
            val to = from + width
            val key = if (state == State.NEEDS) i == 0 else if (state == State.FAILED) i == n - 1 else false
            var slide = 0.0
            if (state == State.WORKING && t != null) slide = 6 * sin(TAU * (t / WORK_CYCLE) + i * TAU / n + (seed % 7))
            if (key && state == State.NEEDS) slide = if (t != null) 3 + 4 * beat(t, NEEDS_BEAT) else 5.0
            var drop = 0.0
            var turn = 0.0
            val middle = (from + to) / 2
            if (key && state == State.FAILED) {
                val k = if (since == null) 1.0 else easeOut(since / FAIL_DROP)
                drop = 8 * k
                turn = 10 * k
            }
            slats += Slat(from, to, slide, key, drop, turn, 50 - middle * sin(turned), 50 + middle * cos(turned))
        }
        return Geometry(form.angle, radius, slats)
    }
}
