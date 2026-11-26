package sh.invincible.bot.ui

import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BlendMode
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DoubleState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import sh.invincible.bot.core.Field
import sh.invincible.bot.core.FieldOrb
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.OrbMotion
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.tan

/*
 * The orbs (26 November 2026): every orb is the primary's field (core/Field.kt, core/FieldOrb.kt), drawn as the PWA's
 * ui/orb.ts draws it. Its is in gold, with its beam of light through it along its axis (your word, 26 November 2026, of
 * the heads-up ring it wore until then: "remove the old mark around primary. make the primary agent distinct in some other
 * cool way"); an agent's is in its own colours, with no beam. The app's own mark is its field alone (AppMark). Each line
 * of a field is a stroke from point to point, its light added to the others on a dark page (a canvas's "lighter":
 * Android's BlendMode.PLUS) over a close, faint glow of its own and no fog; on a light page it is ink, each colour a
 * saturated ink of its own hue, lit where the light strikes (FieldOrb.Ink), in one pass. Where it is one of
 * many (a row, a conversation's history) an orb is still and drawn once; where it is the one you are looking at, it moves
 * as its mood does, slowly (your words, 25 and 26 November 2026: "slow and calming movement", "i dont want them to be too
 * visually distractin"), only as often as FieldOrb.fps asks, never at rest, and never while the phone's animations are off.
 */

/**
 * The primary's orb: its field in gold, its beam through it. Given a [mood] (where it stands), it moves as that mood does;
 * without one, and while the phone's animations are off, it is still. Decorative beside its name; named ([description])
 * where it stands alone. [key] says which orb it is, so one drawn again carries on where it was and a change of mood eases.
 */
@Composable
fun PrimaryOrb(size: Dp, mood: OrbMotion.Mood? = null, description: String? = null, key: String = "primary") {
    FieldCanvas(size, FieldOrb.PRIMARY, beam = true, agent = false, mood = mood, key = key, description = description)
}

/**
 * The app's mark where a page shows it (the sidebar's head beside PRIMARY, Settings' About): the app icon's field, its in
 * gold, alone (no beam: that is its as the one you talk to), still, and on nothing, so it sits on a light page as on a
 * dark one (your word, 26 November 2026: "make sure the app icon is transparent so it works in dark and white mode"):
 * light added to light on a dark page, ink on a light one, as every orb is. Decorative: what it is in is named.
 */
@Composable
fun AppMark(size: Dp) {
    FieldCanvas(size, FieldOrb.PRIMARY, beam = false, agent = false, mood = null, key = "primary:mark", description = null)
}

/**
 * An agent's orb: its field in its own colours (FieldOrb.agent: the colour you chose for it or its handle's, and its
 * handle's lines and lean, the same on every device). It moves only while it works ([mood] WORKING: in its own thread's
 * header); in any other mood it is still, in that mood's light (dimmer while paused or queued, its rim red-brown when its
 * work failed). Without a mood, it is still at rest: in a row, or as a speaker in a conversation.
 */
@Composable
fun AgentOrb(id: String, profile: Json?, size: Dp, mood: OrbMotion.Mood? = null, description: String? = null, key: String = "face:$id") {
    val identity = remember(id, profile) { FieldOrb.agent(id, profile) }
    FieldCanvas(size, identity, beam = false, agent = true, mood = mood, key = key, description = description)
}

/** An agent's or the primary's orb by handle ("primary" is the primary's), still unless given a mood. */
@Composable
fun Face(id: String, profile: Json?, size: Dp, mood: OrbMotion.Mood? = null, description: String? = null) {
    if (id == "primary") PrimaryOrb(size, mood, description) else AgentOrb(id, profile, size, mood, description)
}

/** Whether the page is light (the brand's paper is): a field is ink there. */
@Composable
internal fun onPaper(): Boolean = LocalBrand.current.paper.luminance() > 0.5f

@Composable
private fun FieldCanvas(size: Dp, identity: FieldOrb.Identity, beam: Boolean, agent: Boolean, mood: OrbMotion.Mood?, key: String, description: String?) {
    val look = remember(identity, size, agent) { FieldOrb.look(identity, size.value.toDouble(), primary = !agent) }
    val motion = mood?.let { FieldOrb.motion(it, agent) } ?: STILL
    val paper = onPaper()
    val allowed = motionAllowed()
    // Still: no mood (a row, the history), or a mood with nothing to move (an agent not at work) and no course under way to
    // come to rest from. Drawn once, in its mood's light, from the stills already drawn where one is the same.
    val moving = mood != null && (moves(motion) || Courses.has(key))
    val course = if (moving) remember(key, motion) { Courses.keep(key, motion) } else null
    val time = if (course != null) frameTime(course, motion, allowed) else null
    val painter = if (course != null) remember(identity, look, beam) { Painter(identity, look, beam) } else null
    val semantics = if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier.clearAndSetSemantics { }
    Canvas(Modifier.size(size).then(semantics)) {
        val px = this.size.width.roundToInt().coerceAtLeast(1)
        val bitmap = if (course != null && painter != null) {
            val t = time?.doubleValue
            val frame = if (t != null && allowed) Courses.advance(course, t, OrbMotion.seed(key), !agent) else FieldOrb.still(course.motion).copy(turn = course.clock.turn)
            painter.frame(px, density, size.value.toDouble(), frame, paper)
        } else {
            Stills.of(identity, look, beam, FieldOrb.still(motion), px, density, size.value.toDouble(), paper)
        }
        drawIntoCanvas { it.nativeCanvas.drawBitmap(bitmap, 0f, 0f, null) }
    }
}

/** What a still orb shows: a field at rest, in no mood's light. */
private val STILL = FieldOrb.Motion(0.0, 1.0, null, false, 0.0)

/** Whether a motion moves anything once it has arrived. */
private fun moves(motion: FieldOrb.Motion): Boolean = motion.turn > 0 || motion.breath != null || motion.embers

// ---- each moving orb's course: its motion and its clock, kept by its key -----------------------------------------------

/** Now, in seconds, on the clock the frames are timed by (Choreographer's, System.nanoTime's). */
internal fun now(): Double = System.nanoTime() / 1e9

private object Courses {
    class Course(var motion: FieldOrb.Motion, var clock: FieldOrb.Clock, var last: Double)

    private val kept = HashMap<String, Course>()

    fun has(key: String) = kept.containsKey(key)

    /** An orb's course, by its key: begun settled on first sight, at its rest; drawn again in a new mood, it eases there
     * from where it was. Touched only on the main thread. */
    fun keep(key: String, motion: FieldOrb.Motion): Course {
        val course = kept[key] ?: Course(motion, FieldOrb.clock(motion), now()).also { kept[key] = it }
        course.motion = motion
        return course
    }

    /** Its frame at [t], its clock stepped on to it first (once a moment, however many of its orbs are drawn). */
    fun advance(course: Course, t: Double, seed: Long, embers: Boolean): FieldOrb.Frame {
        if (t > course.last) {
            course.clock = FieldOrb.step(course.clock, course.motion, t - course.last)
            course.last = t
        }
        return FieldOrb.frame(course.clock, t, seed, embers)
    }
}

/**
 * The time of the frame an orb is drawn at, in seconds, as often as its course needs (FieldOrb.fps): read only while
 * drawing, so a new one draws it again and composes nothing. Between two it sleeps, asking for no frame at all; once its
 * course has come to rest (fps 0) it asks for none until its mood changes. Never while the phone's animations are off.
 */
@Composable
private fun frameTime(course: Courses.Course, motion: FieldOrb.Motion, allowed: Boolean): DoubleState {
    val time = remember { mutableDoubleStateOf(now()) }
    LaunchedEffect(course, motion, allowed) {
        if (!allowed) return@LaunchedEffect
        // (A course just made, or a new mood: its clock starts from here, not from when it was last drawn.)
        course.last = max(course.last, now() - OrbMotion.LONGEST_STEP)
        while (true) {
            val fps = FieldOrb.fps(course.clock, course.motion)
            if (fps == 0) break
            withFrameNanos { nanos -> time.doubleValue = nanos / 1e9 }
            // (Woken 10 ms early, the frame after is the one due, on a screen refreshing 60 or 120 times a second.)
            delay(max(0L, 1000L / fps - 10L))
        }
    }
    return time
}

/**
 * The time of the frame a dot's wave is drawn at, [fps] times a second (asked again after each frame): read only while
 * drawing. Between two it sleeps, asking for no frame at all.
 */
@Composable
internal fun frameTime(fps: () -> Int): DoubleState {
    val time = remember { mutableDoubleStateOf(now()) }
    val rate = rememberUpdatedState(fps)
    LaunchedEffect(Unit) {
        while (true) {
            withFrameNanos { nanos -> time.doubleValue = nanos / 1e9 }
            delay(maxOf(0L, 1000L / rate.value().coerceAtLeast(1) - 10L))
        }
    }
    return time
}

/** Whether things may move: not while the phone's animations are off (Settings › Accessibility › Remove animations,
 * which sets the animator duration scale to 0). Read once, then watched for the app's life. */
@Composable
internal fun motionAllowed(): Boolean {
    val context = LocalContext.current
    return remember(context) { MotionSetting.allowed(context) }.value
}

private object MotionSetting {
    private var state: MutableState<Boolean>? = null

    fun allowed(context: Context): State<Boolean> = state ?: run {
        val app = context.applicationContext ?: context
        val watched = mutableStateOf(on(app))
        app.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) {
                    watched.value = on(app)
                }
            },
        )
        state = watched
        watched
    }

    private fun on(context: Context) = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

/** How many steps of brightness (or of an ink's opacity) its strokes are drawn in, and of each colour channel. */
private const val LEVELS = 16
private const val HUES = 16

/** The camera Field.project places: 28 degrees across, 8.3 from the core. */
private val FOCAL = 1 / tan((14 * PI) / 180)
private const val DISTANCE = 8.3

/**
 * A field made ready to draw a frame at a time: its model and the buffer its points are written to (made once), the paths
 * its strokes are gathered into (one for each colour and brightness, so a frame is a few dozen draws, not one for each
 * point), and the picture it draws into, kept and drawn again. With [beam], its beam goes under its lines.
 */
private class Painter(val identity: FieldOrb.Identity, val look: FieldOrb.Look, val beam: Boolean) {
    private val model = Field.model(look.lines, look.steps, identity.tilt.toDoubleArray(), look.weight, identity.colours, identity.seed)
    private val buffer = Field.buffer(model)
    private val xs = FloatArray(model.lines * model.steps)
    private val ys = FloatArray(model.lines * model.steps)
    private val kinds = IntArray(model.lines * model.steps)
    private val paths = LinkedHashMap<Int, Path>()
    private val last = HashMap<Int, Int>()
    private val used = ArrayList<Int>()
    private val toned = DoubleArray(3)
    private val inked = DoubleArray(4)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val blade = Paint(Paint.ANTI_ALIAS_FLAG)
    private val outline = Path()
    private var picture: Bitmap? = null

    /** A frame drawn into this orb's own picture, [px] pixels wide ([sizeDp] dp at [density]). */
    fun frame(px: Int, density: Float, sizeDp: Double, frame: FieldOrb.Frame, paper: Boolean): Bitmap {
        val bitmap = picture?.takeIf { it.width == px } ?: Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888).also { picture = it }
        bitmap.eraseColor(0)
        draw(android.graphics.Canvas(bitmap), px, density, sizeDp, frame, paper)
        return bitmap
    }

    fun draw(g: android.graphics.Canvas, px: Int, density: Float, sizeDp: Double, frame: FieldOrb.Frame, paper: Boolean) {
        val colours = FieldOrb.colours(identity.colours, frame.rim)
        val count = Field.at(model, frame.turn, buffer, if (colours === identity.colours) model.light else Field.light(colours))
        val half = px / 2.0
        val f = half * FOCAL * look.zoom
        val inks = if (paper) PaperInks.of(colours) else null
        val glow = max(0.0, frame.glow)
        val light = FieldOrb.strokeLight(sizeDp)
        fun q(v: Double, steps: Int) = max(0, min(steps - 1, FieldOrb.jsRound(v * (steps - 1)).toInt()))
        for (i in 0 until count) {
            val depth = DISTANCE - buffer.z[i]
            xs[i] = (half + (buffer.x[i] * f) / depth).toFloat()
            ys[i] = (half - (buffer.y[i] * f) / depth).toFloat()
            var r: Double
            var gg: Double
            var b: Double
            val level: Double
            if (inks != null) {
                // (Into one array kept from frame to frame: a frame makes nothing for each of its thousands of points.)
                FieldOrb.inkInto(inks, buffer.lit[i], buffer.rim[i], inked)
                r = inked[0] / 255
                gg = inked[1] / 255
                b = inked[2] / 255
                level = min(1.0, inked[3] * glow)
            } else {
                FieldOrb.tone(buffer.r[i] * glow * light, buffer.g[i] * glow * light, buffer.b[i] * glow * light, FieldOrb.EXPOSURE, toned)
                // Its colour at full brightness, and how bright: so a stroke of one colour can be drawn at a step of brightness.
                level = max(toned[0], max(toned[1], toned[2]))
                val m = if (level == 0.0) 1.0 else level
                r = toned[0] / m
                gg = toned[1] / m
                b = toned[2] / m
            }
            val shown = q(level, LEVELS)
            kinds[i] = if (shown == 0) -1 else (((q(r, HUES) shl 8) or (q(gg, HUES) shl 4) or q(b, HUES)) shl 4) or shown
        }
        // Each line's points one after another on it, joined; the strokes of each kind gathered into one path.
        for (path in paths.values) path.rewind()
        last.clear()
        used.clear()
        for (i in 1 until count) {
            val kind = kinds[i]
            if (buffer.at[i] != buffer.at[i - 1] + 1 || kind < 0 || kinds[i - 1] < 0) continue
            val path = paths.getOrPut(kind) { Path() }
            if (last[kind] == null) used += kind
            if (last[kind] != i - 1) path.moveTo(xs[i - 1], ys[i - 1])
            path.lineTo(xs[i], ys[i])
            last[kind] = i
        }
        val weight = look.weight * density
        stroke.blendMode = if (paper) null else BlendMode.PLUS
        fill.blendMode = if (paper) null else BlendMode.PLUS
        blade.blendMode = if (paper) null else BlendMode.PLUS
        // (On a light page the lines are ink, with no glow under them: one pass.)
        for (pass in if (paper) LINE_ONLY else GLOW_THEN_LINE) {
            // Its beam, under its lines (on a light page they cross over it; on a dark one light adds alike either way).
            if (pass == LINE && beam) drawBeam(g, px, density, sizeDp, colours, glow, inks)
            for (kind in used) {
                val level = (kind and 0xf).toDouble() / (LEVELS - 1)
                val hue = kind shr 4
                fun channel(shift: Int) = FieldOrb.jsRound((((hue shr shift) and 0xf).toDouble() / (HUES - 1)) * 255).toInt()
                // (On a light page, one ink at every size: the small sizes' boldness is for light, which spreads.)
                val width = if (paper) max(FieldOrb.Stroke.INK_LEAST, (FieldOrb.Stroke.LEAST + FieldOrb.Stroke.MORE * level) * FieldOrb.Stroke.INK) * density
                    else (FieldOrb.Stroke.LEAST + FieldOrb.Stroke.MORE * level) * weight
                stroke.strokeWidth = (if (pass == GLOW) width * FieldOrb.Stroke.GLOW_WIDTH else width).toFloat()
                val alpha = if (pass == GLOW) level * FieldOrb.Stroke.GLOW_ALPHA else level
                stroke.color = android.graphics.Color.argb((alpha * 255).roundToInt().coerceIn(0, 255), channel(8), channel(4), channel(0))
                g.drawPath(paths.getValue(kind), stroke)
            }
        }
        // Its embers: a soft light of its rim's (or its ink) drifting off it, falling away from its middle to nothing at three
        // times its radius, never a hard dot.
        if (frame.embers.isNotEmpty()) {
            val (er, eg, eb) = if (paper) inks!!.rim.let { Triple(it[0], it[1], it[2]) } else emberLight(colours).let { Triple(FieldOrb.jsRound(it.first).toInt(), FieldOrb.jsRound(it.second).toInt(), FieldOrb.jsRound(it.third).toInt()) }
            fun argb(alpha: Double) = android.graphics.Color.argb((FieldOrb.jsRound(max(0.0, min(1.0, alpha)) * 1000) / 1000 * 255).roundToInt(), er, eg, eb)
            for (e in frame.embers) {
                if (e.alpha < 0.01) continue
                val r = max(0.6 * density, e.r * half)
                val x = (half + e.x * half).toFloat()
                val y = (half + e.y * half).toFloat()
                fill.shader = RadialGradient(x, y, (r * 3).toFloat(), intArrayOf(argb(e.alpha), argb(e.alpha * 0.55), argb(0.0)), EMBER_STOPS, Shader.TileMode.CLAMP)
                g.drawCircle(x, y, (r * 3).toFloat(), fill)
            }
            fill.shader = null
        }
    }

    /**
     * Its beam (FieldOrb.Beam, beamLine, beamAt; ui/orb.ts' beam): each half one blade, from its root out of its core
     * to its tip, narrowing to a point and fading as it goes, filled along its length with its lit gold going to its gold
     * and then its rim's copper (its light added, over a close glow), or on a light page its inks; as bright as its field
     * is now ([glow]). One path and one fill a half and a pass, so no seam shows where light is added to light.
     */
    private fun drawBeam(g: android.graphics.Canvas, px: Int, density: Float, sizeDp: Double, colours: Field.Colours, glow: Double, inks: FieldOrb.Inks?) {
        val half = px / 2.0
        // Half its width at its root, in pixels: never under half a dp (a dp across); on a light page, never under its ink's
        // least, so it holds as a blade where it is small.
        val root = max(if (inks != null) FieldOrb.Beam.INK_LEAST else 0.5, (sizeDp * FieldOrb.Beam.WIDTH) / 2) * density
        val strength = min(1.0, max(0.0, glow))
        fun rgb(hex: String) = intArrayOf(hex.substring(1, 3).toInt(16), hex.substring(3, 5).toInt(16), hex.substring(5, 7).toInt(16))
        fun mix(a: IntArray, b: IntArray, t: Double) = IntArray(3) { FieldOrb.jsRound(a[it] + (b[it] - a[it]) * t).toInt() }
        val lit = rgb(colours.key[0])
        val gold = rgb(colours.key[1])
        val rim = rgb(colours.rim)
        // From its lit gold through its gold to its rim's copper; on a light page, its inks the same way: its sheen, its key,
        // its rim.
        val first = inks?.sheen ?: lit
        val middle = inks?.key ?: gold
        val last = inks?.rim ?: rim
        fun colourAt(hue: Double): IntArray = if (hue <= 0.5) mix(first, middle, hue * 2) else mix(middle, last, (hue - 0.5) * 2)
        val stops = FloatArray(BEAM_STOPS + 1) { it.toFloat() / BEAM_STOPS }
        for (each in FieldOrb.beamLine(identity, look.zoom)) {
            val x0 = half + each.root[0] * half
            val y0 = half + each.root[1] * half
            val x1 = half + each.tip[0] * half
            val y1 = half + each.tip[1] * half
            val length = hypot(x1 - x0, y1 - y0).takeIf { it > 0 } ?: 1.0
            val nx = -(y1 - y0) / length
            val ny = (x1 - x0) / length
            for (pass in GLOW_THEN_LINE) {
                val spread = when {
                    inks != null -> if (pass == GLOW) FieldOrb.Beam.INK_GLOW_WIDTH else FieldOrb.Beam.INK_WIDTH
                    pass == GLOW -> FieldOrb.Beam.GLOW_WIDTH
                    else -> 1.0
                }
                val strong = strength * when {
                    inks != null -> if (pass == GLOW) FieldOrb.Beam.INK_GLOW_ALPHA else FieldOrb.Beam.INK_ALPHA
                    pass == GLOW -> FieldOrb.Beam.GLOW_ALPHA
                    else -> 1.0
                }
                val colors = IntArray(BEAM_STOPS + 1) { i ->
                    val at = FieldOrb.beamAt(i.toDouble() / BEAM_STOPS)
                    val c = colourAt(at.hue)
                    // (Ink fades slower than light: on a light page the blade holds further out towards its tip.)
                    val light = if (inks != null) at.light.pow(FieldOrb.Beam.INK_FADE) else at.light
                    val alpha = FieldOrb.jsRound(min(1.0, light * strong) * 1000) / 1000
                    android.graphics.Color.argb((alpha * 255).roundToInt().coerceIn(0, 255), c[0], c[1], c[2])
                }
                blade.shader = LinearGradient(x0.toFloat(), y0.toFloat(), x1.toFloat(), y1.toFloat(), colors, stops, Shader.TileMode.CLAMP)
                // One side from root to tip, the other back: its width at each step its root's times beamAt's share.
                outline.rewind()
                for (i in 0..FieldOrb.Beam.STEPS) {
                    val u = i.toDouble() / FieldOrb.Beam.STEPS
                    val w = root * spread * FieldOrb.beamAt(u).width
                    val x = (x0 + (x1 - x0) * u + nx * w).toFloat()
                    val y = (y0 + (y1 - y0) * u + ny * w).toFloat()
                    if (i == 0) outline.moveTo(x, y) else outline.lineTo(x, y)
                }
                for (i in FieldOrb.Beam.STEPS downTo 0) {
                    val u = i.toDouble() / FieldOrb.Beam.STEPS
                    val w = root * spread * FieldOrb.beamAt(u).width
                    outline.lineTo((x0 + (x1 - x0) * u - nx * w).toFloat(), (y0 + (y1 - y0) * u - ny * w).toFloat())
                }
                outline.close()
                g.drawPath(outline, blade)
            }
        }
        blade.shader = null
    }

    private companion object {
        const val GLOW = 0
        const val LINE = 1
        /** How many steps of colour and light a blade of its beam is filled with, along it. */
        const val BEAM_STOPS = 8
        /** An ember's light: whole at its middle, a little over half at a third of the way out, nothing at its edge. */
        val EMBER_STOPS = floatArrayOf(0f, 0.33f, 1f)
        val GLOW_THEN_LINE = intArrayOf(GLOW, LINE)
        val LINE_ONLY = intArrayOf(LINE)
    }
}

/** A field's inks on a light page (FieldOrb.inks), worked out once for each field's colours: a frame on a light page
 * reads them, and an ink takes a few hundred steps. The latest 64 kept; touched only on the main thread, where drawing is. */
private object PaperInks {
    private val kept = object : LinkedHashMap<Field.Colours, FieldOrb.Inks>(80, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Field.Colours, FieldOrb.Inks>?): Boolean = size > 64
    }

    fun of(colours: Field.Colours): FieldOrb.Inks = kept.getOrPut(colours) { FieldOrb.inks(colours) }
}

/** An ember's colour on a dark page: its rim's, a third of the way to its key's deep gold. */
private fun emberLight(colours: Field.Colours): Triple<Double, Double, Double> {
    fun rgb(hex: String) = intArrayOf(hex.substring(1, 3).toInt(16), hex.substring(3, 5).toInt(16), hex.substring(5, 7).toInt(16))
    val a = rgb(colours.rim)
    val b = rgb(colours.key[1])
    return Triple(a[0] + (b[0] - a[0]) / 3.0, a[1] + (b[1] - a[1]) / 3.0, a[2] + (b[2] - a[2]) / 3.0)
}

/**
 * Still orbs' pictures, drawn once and stamped from then on wherever the same orb is still (an agent in twenty rows is
 * drawn once): the latest forty kept, small ones only (a large one is drawn into a picture of its own each time it is
 * drawn, which is once). Touched only on the main thread, where drawing is.
 */
private object Stills {
    private val kept = object : LinkedHashMap<String, Bitmap>(48, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean = size > 40
    }

    fun of(identity: FieldOrb.Identity, look: FieldOrb.Look, beam: Boolean, frame: FieldOrb.Frame, px: Int, density: Float, sizeDp: Double, paper: Boolean): Bitmap {
        val key = "${identity.seed}/${identity.tilt}/${identity.lines}/${identity.colours}|$look|$beam|${frame.glow}/${frame.rim}|$px|$paper"
        kept[key]?.let { return it }
        val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        Painter(identity, look, beam).draw(android.graphics.Canvas(bitmap), px, density, sizeDp, frame, paper)
        if (px <= 384) kept[key] = bitmap
        return bitmap
    }
}
