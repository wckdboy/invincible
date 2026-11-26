package sh.invincible.bot.ui

import android.content.Context
import android.database.ContentObserver
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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.Avatar
import sh.invincible.bot.core.Json
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.sqrt

/*
 * An agent's mark, the Grille (core/AgentMark.kt): a solid disc in the agent's own colour, cut into slats by two or three
 * slots at its own angle, drawn from core's numbers alone as every app draws it. The shape carries its state: the top
 * slat in ink while it asks you, the bottom one red and loose once it failed, pale while queued, grey while paused.
 *
 * Still in every row. The one in focus ([live]: an agent's own page) moves in its state's way, slowly: its slats slide
 * while it works, its top slat beats while it asks you (15 frames a second); done settles once and failed drops once as
 * it arrives (30 a second, then nothing). Never while the phone's animations are off, and nothing at rest.
 */

/** An agent's mark, by its handle and saved avatar ([profile]: its mark, v 3; a colour chosen before the marks, v 2; or
 * nothing), in [state]. Decorative beside its name; named ([description]) where it stands alone. */
@Composable
fun AgentMarkView(id: String, profile: Json?, size: Dp, state: AgentMark.State = AgentMark.State.IDLE, live: Boolean = false, description: String? = null) {
    val mark = remember(id, profile) { AgentMark.markOf(id, profile) }
    val seed = remember(id) { Avatar.handleSeed(id) }
    val dark = LocalBrand.current.paper.luminance() < 0.5f
    val colors = remember(mark, state, dark) { AgentMark.colors(mark.color, state, dark).let { Color(hex(it.body)) to Color(hex(it.key)) } }
    // When it came to its state, while it is on screen: first seen in it, it is long in it (settled).
    val arrived = remember(id) { Arrival(state) }
    if (arrived.state != state) arrived.came(state)
    val moves = state == AgentMark.State.WORKING || state == AgentMark.State.NEEDS
    val lasts = when (state) { AgentMark.State.DONE -> AgentMark.DONE_SETTLE; AgentMark.State.FAILED -> AgentMark.FAIL_DROP; else -> 0.0 }
    val allowed = motionAllowed()
    val time = if (live && allowed && (moves || (lasts > 0 && arrived.since() < lasts))) markTime(moves, lasts, arrived) else null
    val still = remember(mark, state, size) { AgentMark.geometry(mark, seed, state, size.value.toDouble(), null, null) }
    // (A still mark's bands, made once: a list of rows draws them as it scrolls, never building them again.)
    val stillBands = remember(still) { still.slats.map { band(still.radius.toFloat(), it.from.toFloat(), it.to.toFloat()) } }
    val named = if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier.clearAndSetSemantics { }
    Canvas(Modifier.size(size).then(named)) {
        val moving = time?.let { t ->
            val since = arrived.since().takeIf { it < lasts || moves }
            AgentMark.geometry(mark, seed, state, size.value.toDouble(), if (moves) t.doubleValue else null, since)
        }
        val geometry = moving ?: still
        val (body, key) = colors
        scale(this.size.minDimension / 100f, this.size.minDimension / 100f, pivot = Offset.Zero) {
            for ((n, slat) in geometry.slats.withIndex()) {
                val loose = slat.drop != 0.0 || slat.turn != 0.0
                translate(0f, if (loose) slat.drop.toFloat() else 0f) {
                    rotate(if (loose) slat.turn.toFloat() else 0f, pivot = Offset(slat.pivotX.toFloat(), slat.pivotY.toFloat())) {
                        translate(50f, 50f) {
                            rotate(geometry.angle.toFloat(), pivot = Offset.Zero) {
                                translate(slat.slide.toFloat(), 0f) {
                                    drawPath(if (moving == null) stillBands[n] else band(geometry.radius.toFloat(), slat.from.toFloat(), slat.to.toFloat()), if (slat.key) key else body)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** An agent's mark or the primary's by handle ("primary" is the primary's: the I-beam), still unless given a state. */
@Composable
fun Face(id: String, profile: Json?, size: Dp, state: AgentMark.State = AgentMark.State.IDLE, description: String? = null) {
    if (id == "primary") PrimaryMark(size, description) else AgentMarkView(id, profile, size, state, description = description)
}

/** A band of the disc between u = [a] and u = [b] (across the slots, downward), about the disc's middle: two chords and
 * the two arcs between them (the web's bandPath). */
private fun band(r: Float, a: Float, b: Float): Path {
    val ha = sqrt(max(0f, r * r - a * a))
    val hb = sqrt(max(0f, r * r - b * b))
    val disc = Rect(-r, -r, r, r)
    val ta = Math.toDegrees(atan2(a.toDouble(), ha.toDouble())).toFloat()
    val tb = Math.toDegrees(atan2(b.toDouble(), hb.toDouble())).toFloat()
    return Path().apply {
        moveTo(-ha, a)
        lineTo(ha, a)
        arcTo(disc, ta, tb - ta, false)
        lineTo(-hb, b)
        arcTo(disc, 180f - tb, tb - ta, false)
        close()
    }
}

private fun hex(color: String): Long = 0xff000000L or color.substring(1, 7).toLong(16)

/** When a mark came to its state, on the frame clock (null: before it was seen, so long ago). */
private class Arrival(var state: AgentMark.State) {
    private var at: Double? = null

    fun came(next: AgentMark.State) {
        state = next
        at = now()
    }

    fun since(): Double = at?.let { now() - it } ?: Double.MAX_VALUE
}

private fun now(): Double = System.nanoTime() / 1e9

/**
 * The time of the frame a moving mark is drawn at: 15 frames a second while it moves (working, asking you), 30 while it
 * arrives (done, failed), then none. Read only while drawing, so a new one draws it again and composes nothing; between two
 * it sleeps, asking for no frame at all.
 */
@Composable
private fun markTime(moves: Boolean, lasts: Double, arrived: Arrival): DoubleState {
    val time = remember { mutableDoubleStateOf(now()) }
    LaunchedEffect(moves, lasts, arrived.state) {
        while (moves || arrived.since() < lasts) {
            withFrameNanos { nanos -> time.doubleValue = nanos / 1e9 }
            // (Woken 10 ms early, the frame after is the one due, on a screen refreshing 60 or 120 times a second.)
            delay(max(0L, 1000L / (if (moves) 15 else 30) - 10L))
        }
        // (Come to rest: one more frame, where it settles.)
        withFrameNanos { nanos -> time.doubleValue = nanos / 1e9 }
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
