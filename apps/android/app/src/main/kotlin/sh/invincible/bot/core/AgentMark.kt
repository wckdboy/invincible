package sh.invincible.bot.core

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

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

    // ---- a colour you pick, snapped (core's snapColor): + − × ÷ and √ alone, so the same to the last bit everywhere ----

    /** sRGB's 256 levels in linear light, as core holds them (MARK_LINEAR: pow differs between platforms in its last bits). */
    val LINEAR = doubleArrayOf(
        0.0, 0.0003035269835488375, 0.000607053967097675, 0.0009105809506465125, 0.00121410793419535, 0.0015176349177441874,
        0.001821161901293025, 0.0021246888848418626, 0.0024282158683907, 0.0027317428519395373, 0.003035269835488375, 0.003346535763899161,
        0.003676507324047436, 0.004024717018496307, 0.004391442037410293, 0.004776953480693729, 0.005181516702338386, 0.005605391624202723,
        0.006048833022857054, 0.006512090792594475, 0.006995410187265387, 0.007499032043226175, 0.008023192985384994, 0.008568125618069307,
        0.009134058702220787, 0.00972121732023785, 0.010329823029626936, 0.010960094006488246, 0.011612245179743885, 0.012286488356915872,
        0.012983032342173012, 0.013702083047289686, 0.014443843596092545, 0.01520851442291271, 0.01599629336550963, 0.016807375752887384,
        0.017641954488384078, 0.018500220128379697, 0.019382360956935723, 0.0202885630566524, 0.021219010376003555, 0.02217388479338738,
        0.02315336617811041, 0.024157632448504756, 0.02518685962736163, 0.026241221894849898, 0.027320891639074894, 0.028426039504420793,
        0.0295568344378088, 0.030713443732993635, 0.03189603307301153, 0.033104766570885055, 0.03433980680868217, 0.03560131487502034,
        0.03688945040110004, 0.0382043715953465, 0.03954623527673284, 0.04091519690685319, 0.042311410620809675, 0.043735029256973465,
        0.04518620438567554, 0.046665086336880095, 0.04817182422688942, 0.04970656598412723, 0.05126945837404324, 0.052860647023180246,
        0.05448027644244237, 0.05612849004960009, 0.05780543019106723, 0.0595112381629812, 0.06124605423161761, 0.06301001765316767,
        0.06480326669290577, 0.06662593864377289, 0.06847816984440017, 0.07036009569659588, 0.07227185068231748, 0.07421356838014963,
        0.07618538148130785, 0.07818742180518633, 0.08021982031446832, 0.0822827071298148, 0.08437621154414882, 0.08650046203654976,
        0.08865558628577294, 0.09084171118340768, 0.09305896284668745, 0.0953074666309647, 0.09758734714186246, 0.09989872824711389,
        0.10224173308810132, 0.10461648409110419, 0.10702310297826761, 0.10946171077829933, 0.1119324278369056, 0.11443537382697373,
        0.11697066775851084, 0.11953842798834562, 0.12213877222960187, 0.12477181756095049, 0.12743768043564743, 0.1301364766903643,
        0.13286832155381798, 0.13563332965520566, 0.13843161503245183, 0.14126329114027164, 0.14412847085805777, 0.14702726649759498,
        0.14995978981060856, 0.15292615199615017, 0.1559264637078274, 0.1589608350608804, 0.162029375639111, 0.1651321945016676,
        0.16826940018969075, 0.1714411007328226, 0.17464740365558504, 0.17788841598362912, 0.18116424424986022, 0.184474994500441,
        0.18782077230067787, 0.19120168274079138, 0.1946178304415758, 0.19806931955994886, 0.20155625379439707, 0.20507873639031693,
        0.20863687014525575, 0.21223075741405523, 0.21586050011389926, 0.2195261997292692, 0.2232279573168085, 0.22696587351009836,
        0.23074004852434915, 0.23455058216100522, 0.238397573812271, 0.24228112246555486, 0.24620132670783548, 0.25015828472995344,
        0.25415209433082675, 0.2581828529215958, 0.26225065752969623, 0.26635560480286247, 0.2704977910130658, 0.27467731206038465,
        0.2788942634768104, 0.2831487404299921, 0.2874408377269175, 0.29177064981753587, 0.2961382707983211, 0.3005437944157765,
        0.3049873140698863, 0.30946892281750854, 0.31398871337571754, 0.31854677812509186, 0.32314320911295075, 0.3277780980565422,
        0.33245153634617935, 0.33716361504833037, 0.3419144249086609, 0.3467040563550296, 0.35153259950043936, 0.3564001441459435,
        0.3613067797835095, 0.3662525955988395, 0.3712376804741491, 0.3762621229909065, 0.38132601143253014, 0.386429433787049,
        0.39157247774972326, 0.39675523072562685, 0.4019777798321958, 0.4072402119017367, 0.41254261348390375, 0.4178850708481375,
        0.4232676699860717, 0.4286904966139066, 0.43415363617474895, 0.4396571738409188, 0.44520119451622786, 0.45078578283822346,
        0.45641102318040466, 0.4620769996544071, 0.467783796112159, 0.47353149614800955, 0.4793201831008268, 0.4851499400560704,
        0.4910208498478356, 0.4969329950608704, 0.5028864580325687, 0.5088813208549338, 0.5149176653765214, 0.5209955732043543,
        0.5271151257058131, 0.5332764040105052, 0.5394794890121072, 0.5457244613701866, 0.5520114015120001, 0.5583403896342679,
        0.5647115057049292, 0.5711248294648731, 0.5775804404296506, 0.5840784178911641, 0.5906188409193369, 0.5972017883637634,
        0.6038273388553378, 0.6104955708078648, 0.6172065624196511, 0.6239603916750761, 0.6307571363461468, 0.6375968739940326,
        0.6444796819705821, 0.6514056374198242, 0.6583748172794485, 0.665387298282272, 0.6724431569576875, 0.6795424696330938,
        0.6866853124353135, 0.6938717612919899, 0.7011018919329731, 0.7083757798916868, 0.7156935005064807, 0.7230551289219693,
        0.7304607400903537, 0.7379104087727308, 0.7454042095403874, 0.7529422167760779, 0.7605245046752924, 0.768151147247507,
        0.7758222183174236, 0.7835377915261935, 0.7912979403326302, 0.799102738014409, 0.8069522576692516, 0.8148465722161012,
        0.8227857543962835, 0.8307698767746546, 0.83879901174074, 0.846873231509858, 0.8549926081242338, 0.8631572134541023,
        0.8713671191987972, 0.8796223968878317, 0.8879231178819663, 0.8962693533742664, 0.9046611743911496, 0.9130986517934192,
        0.9215818562772946, 0.9301108583754237, 0.938685728457888, 0.9473065367331999, 0.9559733532492861, 0.9646862478944651,
        0.9734452903984125, 0.9822505503331171, 0.9911020971138298, 1.0,
    )

    /** Under this chroma a colour is a grey: it has no hue to snap by. */
    const val GREY = 0.02

    /** A cube root of [0, 1] by Newton's method: from 1, halved until its cube is within 8 times x, then a fixed 8 steps. */
    fun cubeRoot(x: Double): Double {
        if (x <= 0) return 0.0
        var y = 1.0
        while (y * y * y > 8 * x) y = y / 2
        for (n in 0 until 8) y = (2 * y + x / (y * y)) / 3
        return y
    }

    /** A colour (#rrggbb) in OKLab: its lightness and its (a, b), each sum in core's order. */
    fun lab(hex: String): DoubleArray {
        val r = LINEAR[hex.substring(1, 3).toInt(16)]
        val g = LINEAR[hex.substring(3, 5).toInt(16)]
        val b = LINEAR[hex.substring(5, 7).toInt(16)]
        val l = cubeRoot(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cubeRoot(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cubeRoot(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return doubleArrayOf(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
    }

    private class HueDirection(val a: Double, val b: Double, val forms: List<DoubleArray>)

    /** Each hue's direction in (a, b), from its light form, and both forms' lightness and chroma, for a tie. */
    private val HUES = PALETTE.map { hue ->
        val (_, a, b) = lab(hue.light)
        val chroma = Math.sqrt(a * a + b * b)
        HueDirection(a / chroma, b / chroma, listOf(hue.light, hue.dark).map { form ->
            val (fl, fa, fb) = lab(form)
            doubleArrayOf(fl, Math.sqrt(fa * fa + fb * fb))
        })
    }

    /**
     * Which of the eight a colour you pick snaps to: the nearest hue (OKLCH's), its lightness and chroma only breaking a
     * tie, so a pale mint is Teal's and red, which isn't among them, is Amber's. A grey goes to the form nearest it in
     * lightness. Core's snapColor, line for line.
     */
    fun snapColor(hex: String): Int {
        val (l, a, b) = lab(hex.lowercase())
        val chroma = Math.sqrt(a * a + b * b)
        var best = 0
        if (chroma < GREY) {
            var apart = Double.POSITIVE_INFINITY
            HUES.forEachIndexed { n, hue ->
                for (form in hue.forms) {
                    val d = Math.abs(form[0] - l)
                    if (d < apart) {
                        best = n
                        apart = d
                    }
                }
            }
            return best
        }
        var along = Double.NEGATIVE_INFINITY
        var nearL = Double.POSITIVE_INFINITY
        var nearC = Double.POSITIVE_INFINITY
        HUES.forEachIndexed { n, hue ->
            val at = a * hue.a + b * hue.b
            val dL = minOf(Math.abs(hue.forms[0][0] - l), Math.abs(hue.forms[1][0] - l))
            val dC = minOf(Math.abs(hue.forms[0][1] - chroma), Math.abs(hue.forms[1][1] - chroma))
            if (at > along || (at == along && (dL < nearL || (dL == nearL && dC < nearC)))) {
                best = n
                along = at
                nearL = dL
                nearC = dC
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

    // ---- its arithmetic (core's): + − × ÷ and floor alone, never Math.sin, cos or pow, whose last bits are each
    // platform's own; taken to its quarter turn, then Taylor's series. The same to the last bit as every app. ----

    private const val QUARTER = PI / 2

    private fun sinNear(r: Double): Double {
        val r2 = r * r
        return r + r * r2 * (-1.0 / 6 + r2 * (1.0 / 120 + r2 * (-1.0 / 5040 + r2 * (1.0 / 362880 + r2 * (-1.0 / 39916800 + r2 * (1.0 / 6227020800))))))
    }

    private fun cosNear(r: Double): Double {
        val r2 = r * r
        return 1 + r2 * (-1.0 / 2 + r2 * (1.0 / 24 + r2 * (-1.0 / 720 + r2 * (1.0 / 40320 + r2 * (-1.0 / 3628800 + r2 * (1.0 / 479001600 + r2 * (-1.0 / 87178291200)))))))
    }

    /** Which quarter turn, 0 to 3, of a whole number of them. */
    private fun turnOf(q: Double): Double = q - 4 * floor(q / 4)

    /** The sine of [x] radians (core's markSin). */
    fun sin(x: Double): Double {
        val q = floor(x / QUARTER + 0.5)
        val r = x - q * QUARTER
        return when (turnOf(q)) { 0.0 -> sinNear(r); 1.0 -> cosNear(r); 2.0 -> -sinNear(r); else -> -cosNear(r) }
    }

    /** The cosine of [x] radians (core's markCos). */
    fun cos(x: Double): Double {
        val q = floor(x / QUARTER + 0.5)
        val r = x - q * QUARTER
        return when (turnOf(q)) { 0.0 -> cosNear(r); 1.0 -> -sinNear(r); 2.0 -> -cosNear(r); else -> sinNear(r) }
    }

    private const val TAU = PI * 2
    private fun beat(t: Double, period: Double) = 0.5 - 0.5 * cos(TAU * t / period)
    private fun easeOut(x: Double): Double {
        val left = 1 - min(1.0, max(0.0, x))
        return 1 - left * left * left
    }

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
