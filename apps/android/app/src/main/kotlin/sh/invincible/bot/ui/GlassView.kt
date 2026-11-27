package sh.invincible.bot.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.LinearGradient
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.FloatState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import sh.invincible.bot.core.Glass
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/*
 * An agent's glass, drawn (core/Glass.kt's numbers, core's): its shape in its ramp, as one picture made once for each
 * shape, ramp, size and page and kept (with its blur from 40 dp); its glow beside it, a pool of its light behind it on a
 * dark page and a tinted shadow under it on a light one; and its state's dot, cut out of whatever it sits on. Only working
 * moves, and only on its agent's own page: its light breathes, by opacity, 15 times a second, while the phone's animations
 * are on and the app is in front (Compose's frame clock stops with the activity). In rows it is still: here each breath is
 * a frame of the app's own work, so rows wait for a breath the render thread runs, measured. Nothing it draws lays
 * anything out beyond its own box.
 */

/** An agent's glass: its shape in its ramp, its glow, and its state's dot where its state is known (null: no dot);
 * [live] where it is the one in focus (its agent's own page), which alone breathes. Decorative beside its name; named
 * ([description]) where it stands alone. */
@Composable
fun GlassMark(glass: Glass, size: Dp, state: Glass.State? = null, description: String? = null, live: Boolean = false) {
    val dark = LocalBrand.current.paper.luminance() < 0.5f
    val box = with(LocalDensity.current) { size.roundToPx() }
    val picture = remember(glass, size, box, dark) { GlassPictures.picture(glass.shape, glass.color, size.value, box, dark) }
    val breath = breathing(glassBreathes(state, live, motionAllowed()))
    val named = if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier.clearAndSetSemantics { }
    Canvas(Modifier.size(size).then(named)) {
        drawGlass(picture, Glass.RAMPS[glass.color], size.value, dark, state, breath.floatValue)
    }
}

/** Whether a glass breathes: a working agent's, on its own page ([live]), while the phone's animations are on. */
internal fun glassBreathes(state: Glass.State?, live: Boolean, motion: Boolean): Boolean = live && motion && state == Glass.State.WORKING

/** Your agent's mark, where a face goes: the app's I-beam on a tile of its own in one ink (the page's on its ink), or,
 * where this phone is set so (Settings), in pearl glass: on a graphite tile on a light page, glowing on its own on a dark
 * one. Decorative unless named ([description]). */
@Composable
fun GuardianMark(size: Dp, description: String? = null) {
    val brand = LocalBrand.current
    val dark = brand.paper.luminance() < 0.5f
    val pearl = GuardianSetting.pearl(LocalContext.current).value
    val box = with(LocalDensity.current) { size.roundToPx() }
    val picture = if (pearl) remember(size, box, dark) { GlassPictures.picture(-1, -1, size.value, box, dark) } else null
    val named = if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier.clearAndSetSemantics { }
    Canvas(Modifier.size(size).then(named)) {
        val side = this.size.minDimension
        val corner = androidx.compose.ui.geometry.CornerRadius(side * 0.28f)
        if (picture != null) {
            if (!dark) drawRoundRect(Color(hex(Glass.PEARL_TILE)), cornerRadius = corner)
            drawImage(picture.image, Offset(-picture.origin.toFloat(), -picture.origin.toFloat()))
        } else {
            drawRoundRect(brand.ink, cornerRadius = corner)
            val path = androidx.compose.ui.graphics.Path()
            for (part in sh.invincible.bot.core.IBeam.parts(this.size.width.toDouble(), this.size.height.toDouble())) {
                path.addRect(Rect(part.x0.toFloat(), part.y0.toFloat(), part.x1.toFloat(), part.y1.toFloat()))
            }
            drawPath(path, brand.paper)
        }
    }
}

/** Whether your agent's mark is in pearl glass on this phone (Settings): read once, then the one value every mark reads,
 * so a change shows at once. */
internal object GuardianSetting {
    private const val KEY = "guardian-mark"
    private var state: MutableState<Boolean>? = null

    fun pearl(context: Context): MutableState<Boolean> = state ?: mutableStateOf(prefs(context).getString(KEY, "mono") == "pearl").also { state = it }

    fun set(context: Context, pearl: Boolean) {
        prefs(context).edit().putString(KEY, if (pearl) "pearl" else "mono").apply()
        pearl(context).value = pearl
    }

    private fun prefs(context: Context) = (context.applicationContext ?: context).getSharedPreferences("invincible", Context.MODE_PRIVATE)
}

/** Its glow, its picture and its dot, in the avatar's box ([breath]: how far into its breath a working glass is, 0 to 1;
 * below 0, still). The glow and the picture go past the box; with a dot, they're drawn in a layer the dot's cut is taken
 * out of, then the dot over it. */
private fun DrawScope.drawGlass(picture: GlassPictures.Picture, ramp: Glass.Ramp, sizeDp: Float, dark: Boolean, state: Glass.State?, breath: Float) {
    val box = size.minDimension
    if (state != null) drawContext.canvas.saveLayer(Rect(-box * 0.4f, -box * 0.4f, box * 1.4f, box * 1.4f), Paint())
    glow(ramp, sizeDp, dark, breath)
    drawImage(picture.image, Offset(-picture.origin.toFloat(), -picture.origin.toFloat()))
    if (state == null) return
    val dot = Glass.Dot.size(sizeDp)
    val unit = box / sizeDp
    val at = Offset(box + (dot.out - dot.size / 2) * unit, box + (dot.out - dot.size / 2) * unit)
    drawCircle(Color.Black, radius = (dot.size / 2 + dot.cut) * unit, center = at, blendMode = BlendMode.Clear)
    drawContext.canvas.restore()
    val colour = Color(hex(Glass.Dot.COLORS.getValue(state).on(dark)))
    if (state == Glass.State.IDLE) {
        val ring = Glass.Dot.IDLE_RING * unit
        drawCircle(colour, radius = dot.size / 2 * unit - ring / 2, center = at, style = Stroke(ring))
    } else {
        drawCircle(colour, radius = dot.size / 2 * unit, center = at)
    }
}

/** A pool of its light behind it on a dark page (from 24 dp), a tinted shadow under it on a light one (from 20 dp). */
private fun DrawScope.glow(ramp: Glass.Ramp, sizeDp: Float, dark: Boolean, breath: Float) {
    val stops = ramp.on(dark)
    val box = size.minDimension
    if (dark && sizeDp >= Glass.Glow.POOL_FROM) {
        val r = box * (1 + 2 * Glass.Glow.POOL_SPREAD) / 2
        val c = Offset(box / 2, box / 2)
        val colours = Glass.Glow.POOL_STOPS.map { (at, ofB, a) -> at to Color(hex(if (ofB) stops.b else stops.a)).copy(alpha = a) }.toTypedArray()
        val alpha = if (breath < 0) Glass.Glow.POOL_OPACITY else Glass.Glow.POOL_BREATHE + (1 - Glass.Glow.POOL_BREATHE) * breath
        drawCircle(Brush.radialGradient(*colours, center = c, radius = r), radius = r, center = c, alpha = alpha)
    } else if (!dark && sizeDp >= Glass.Glow.SHADOW_FROM) {
        val w = box * (1 - Glass.Glow.SHADOW_LEFT - Glass.Glow.SHADOW_RIGHT)
        val h = box * (Glass.Glow.SHADOW_BOTTOM - Glass.Glow.SHADOW_TOP)
        val c = Offset(box * Glass.Glow.SHADOW_LEFT + w / 2, box * Glass.Glow.SHADOW_TOP + h / 2)
        val colours = Glass.Glow.SHADOW_STOPS.map { (at, a) -> at to Color(hex(stops.b)).copy(alpha = a) }.toTypedArray()
        val alpha = if (breath < 0) Glass.Glow.SHADOW_OPACITY else Glass.Glow.SHADOW_BREATHE + (1 - Glass.Glow.SHADOW_BREATHE) * breath
        // (An ellipse: a circle as wide as it, squashed to its height.)
        scale(1f, h / w, pivot = c) { drawCircle(Brush.radialGradient(*colours, center = c, radius = w / 2), radius = w / 2, center = c, alpha = alpha) }
    }
}

/** How far into its breath a working glass is (0 to 1, a raised cosine every Glow.PERIOD seconds, every glass in step),
 * 15 times a second while [on]; -1, still. Read only while drawing, so a new one draws it again and composes nothing. */
@Composable
private fun breathing(on: Boolean): FloatState {
    val breath = remember { mutableFloatStateOf(-1f) }
    LaunchedEffect(on) {
        if (!on) {
            breath.floatValue = -1f
            return@LaunchedEffect
        }
        fun at(nanos: Long) = (0.5 - 0.5 * cos(2 * PI * ((nanos / 1e9) % Glass.Glow.PERIOD) / Glass.Glow.PERIOD)).toFloat()
        breath.floatValue = at(System.nanoTime())
        while (true) {
            withFrameNanos { nanos -> breath.floatValue = at(nanos) }
            // (Woken 10 ms early, the frame after is the one due, on a screen refreshing 60 or 120 times a second.)
            delay(1000L / 15 - 10L)
        }
    }
    return breath
}

/** The pictures, kept: drawing one is the work (its paint's four layers and its blur), showing it is not. */
internal object GlassPictures {
    /** A picture with a blur spans this much of the avatar's box past it on each side; one without, a sliver. */
    private const val PAD = 0.3f
    private const val SLIVER = 0.04f

    /** A picture, and how far past the box's top left it starts, in pixels. */
    class Picture(val image: ImageBitmap, val origin: Int)

    private data class Key(val shape: Int, val ramp: Int, val box: Int, val dark: Boolean)

    private val kept = object : LruCache<Key, Picture>(24 * 1024 * 1024) {
        override fun sizeOf(key: Key, value: Picture) = value.image.width * value.image.height * 4
    }

    /** [shape] and [ramp] -1: the Guardian's I-beam in pearl. [box]: the avatar's side in pixels. */
    fun picture(shape: Int, ramp: Int, sizeDp: Float, box: Int, dark: Boolean): Picture {
        val key = Key(shape, ramp, box, dark)
        kept.get(key)?.let { return it }
        val made = draw(if (shape < 0) Glass.IBEAM else Glass.SHAPES[shape], if (ramp < 0) Glass.PEARL else Glass.RAMPS[ramp], sizeDp, max(1, box), dark)
        kept.put(key, made)
        return made
    }

    private fun draw(shape: Glass.Shape, ramp: Glass.Ramp, sizeDp: Float, box: Int, dark: Boolean): Picture {
        val blurred = sizeDp >= Glass.Glow.BLUR_FROM
        val origin = (box * (if (blurred) PAD else SLIVER)).roundToInt()
        val side = box + 2 * origin
        val k = box / 100f
        val shaped = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(shaped).apply {
            translate(origin.toFloat(), origin.toFloat())
            scale(k, k)
            val path = path(shape.d)
            val width = if (sizeDp <= 16f) shape.smallWidth else shape.width
            // Its region, opaque: a tube's round line; a fill, and its soft round stroke.
            val region = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = android.graphics.Color.BLACK
                strokeCap = android.graphics.Paint.Cap.ROUND
                strokeJoin = android.graphics.Paint.Join.ROUND
            }
            if (shape.tube) {
                region.style = android.graphics.Paint.Style.STROKE
                region.strokeWidth = width
                drawPath(path, region)
            } else {
                region.style = android.graphics.Paint.Style.FILL
                drawPath(path, region)
                if (width > 0) {
                    region.style = android.graphics.Paint.Style.STROKE
                    region.strokeWidth = width
                    drawPath(path, region)
                }
            }
            // Its paint's four layers, each drawn only where the region is (atop it).
            val s = ramp.on(dark)
            val all = RectF(-origin / k, -origin / k, (side - origin) / k, (side - origin) / k)
            val atop = PorterDuffXfermode(PorterDuff.Mode.SRC_ATOP)
            fun layer(shader: Shader) = drawRect(all, android.graphics.Paint().apply { this.shader = shader; xfermode = atop })
            val p = Glass.Paint
            layer(LinearGradient(0f, 0f, 100f, 100f, argb(s.a, 1f), argb(s.b, 1f), Shader.TileMode.CLAMP))
            layer(RadialGradient(p.ACCENT_X, p.ACCENT_Y, p.ACCENT_R, argb(s.accent, p.ACCENT_OPACITY), argb(s.accent, 0f), Shader.TileMode.CLAMP))
            layer(RadialGradient(p.HIGHLIGHT_X, p.HIGHLIGHT_Y, p.HIGHLIGHT_R, p.HIGHLIGHT_STOPS.map { argb(s.highlight, it.second) }.toIntArray(), p.HIGHLIGHT_STOPS.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP))
            layer(RadialGradient(p.SHADE_X, p.SHADE_Y, p.SHADE_R, argb(s.deep, p.shadeOpacity(dark)), argb(s.deep, 0f), Shader.TileMode.CLAMP))
        }
        if (!blurred) return Picture(shaped.asImageBitmap().also { it.prepareToDraw() }, origin)
        // From 40 dp, a blurred copy of it under it: at the page's opacity, moved down on a light page.
        val pixels = IntArray(side * side)
        shaped.getPixels(pixels, 0, side, 0, 0, side, side)
        val soft = Bitmap.createBitmap(GlassBlur.gaussian(pixels, side, side, Glass.Glow.BLUR_RADIUS * k), side, side, Bitmap.Config.ARGB_8888)
        val out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(out).apply {
            drawBitmap(soft, 0f, Glass.Glow.blurDrop(dark) * k, android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG).apply { alpha = (Glass.Glow.blurOpacity(dark) * 255).roundToInt() })
            drawBitmap(shaped, 0f, 0f, null)
        }
        shaped.recycle()
        soft.recycle()
        return Picture(out.asImageBitmap().also { it.prepareToDraw() }, origin)
    }

    private fun path(d: String) = android.graphics.Path().apply {
        for (s in Glass.segments(d)) when (s) {
            is Glass.Segment.Move -> moveTo(s.x, s.y)
            is Glass.Segment.Line -> lineTo(s.x, s.y)
            is Glass.Segment.Quad -> quadTo(s.x1, s.y1, s.x, s.y)
            is Glass.Segment.Cubic -> cubicTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y)
            Glass.Segment.Close -> close()
        }
    }

    private fun argb(hex: String, alpha: Float): Int = ((alpha * 255).roundToInt() shl 24) or hex.substring(1, 7).toInt(16)
}

/**
 * A Gaussian blur as SVG's feGaussianBlur makes one, which the web's glass is drawn with: three box blurs each way, of
 * the width its standard deviation gives (an odd one centred, or two even ones either side of the pixel and one a pixel
 * wider), over the colours premultiplied by their alpha. Pure arithmetic, so a test holds it.
 */
internal object GlassBlur {
    /** The box's width for a standard deviation of [sigma] pixels (SVG's d), at least 1. */
    fun width(sigma: Float): Int = max(1, floor(sigma * 3 * sqrt(2 * PI) / 4 + 0.5).toInt())

    /** [argb]: [w] × [h] pixels, not premultiplied (as Bitmap.getPixels gives them); the same, blurred. */
    fun gaussian(argb: IntArray, w: Int, h: Int, sigma: Float): IntArray {
        val d = width(sigma)
        if (d <= 1) return argb.copyOf()
        // Each pass: its width, and how far it reaches left of (above) the pixel; the rest is right of (below) it.
        val passes = if (d % 2 == 1) List(3) { d to (d - 1) / 2 } else listOf(d to d / 2, d to d / 2 - 1, d + 1 to d / 2)
        val n = w * h
        val channels = Array(4) { IntArray(n) }
        // (Alpha kept at the colours' scale, × 255, so a colour divided by it again comes back to the last bit.)
        for (i in 0 until n) {
            val c = argb[i]
            val a = c ushr 24
            channels[0][i] = a * 255
            channels[1][i] = ((c shr 16) and 255) * a
            channels[2][i] = ((c shr 8) and 255) * a
            channels[3][i] = (c and 255) * a
        }
        val spare = IntArray(n)
        for (channel in channels) {
            var src = channel
            var dst = spare
            for ((size, left) in passes) {
                box(src, dst, w, h, size, left, horizontal = true)
                src = dst.also { dst = src }
            }
            for ((size, left) in passes) {
                box(src, dst, w, h, size, left, horizontal = false)
                src = dst.also { dst = src }
            }
            // (Six passes, an even number: the result is back in the channel's own array.)
        }
        return IntArray(n) { i ->
            val a255 = channels[0][i]
            val a = (a255 + 127) / 255
            fun plain(c: Int) = minOf(255, (c * 255 + a255 / 2) / a255)
            if (a == 0) 0 else (a shl 24) or (plain(channels[1][i]) shl 16) or (plain(channels[2][i]) shl 8) or plain(channels[3][i])
        }
    }

    /** One box blur along rows (or columns): each pixel the mean of the [size] from [left] before it, rounded. */
    private fun box(src: IntArray, dst: IntArray, w: Int, h: Int, size: Int, left: Int, horizontal: Boolean) {
        val lines = if (horizontal) h else w
        val length = if (horizontal) w else h
        val step = if (horizontal) 1 else w
        val right = size - 1 - left
        for (line in 0 until lines) {
            val start = if (horizontal) line * w else line
            var sum = 0L
            for (j in 0..minOf(right, length - 1)) sum += src[start + j * step]
            for (j in 0 until length) {
                dst[start + j * step] = ((sum + size / 2) / size).toInt()
                val adds = j + right + 1
                if (adds < length) sum += src[start + adds * step]
                val drops = j - left
                if (drops >= 0) sum -= src[start + drops * step]
            }
        }
    }
}

internal fun hex(color: String): Long = 0xff000000L or color.substring(1, 7).toLong(16)
