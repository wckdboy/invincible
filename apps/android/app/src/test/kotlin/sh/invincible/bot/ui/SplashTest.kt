package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.compose.ui.graphics.toArgb
import org.w3c.dom.Element
import sh.invincible.bot.core.IBeam
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.math.floor
import kotlin.math.hypot

/**
 * What Android 12 and later show while the app starts (its splash): the bare I-beam in the page's ink on the page's
 * ground, light and dark, as the app's own marks are since the owner's word of 27 November 2026 ("the Logo is just the I
 * beam, not the appicon squircle around it"), never the launcher icon on its black field, which the splash showed until
 * then. Its I-beam is IBeam's own parts, as IBeamMark draws them, at the size Android gives a splash icon without a
 * background: 288 dp, the mark inside the 192 dp circle it is cut to. (The resources are read from the source tree: a
 * unit test runs in the module's folder.)
 */
class SplashTest {
    private val res = File("src/main/res")

    private fun xml(path: String): Element {
        val file = File(res, path)
        assertTrue("$file is there", file.isFile)
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
    }

    private fun Element.children(tag: String): List<Element> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    @Test fun itShowsTheBareIBeamOnThePagesGroundNeverTheLauncherIcon() {
        for (theme in listOf("values-v31/themes.xml", "values-night-v31/themes.xml")) {
            val items = xml(theme).children("item").associate { it.getAttribute("name") to it.textContent.trim() }
            assertEquals(theme, "@drawable/splash_ibeam", items["android:windowSplashScreenAnimatedIcon"])
            assertEquals(theme, "@color/window", items["android:windowSplashScreenBackground"])
            // Nothing behind it: no circle of a colour of its own.
            assertFalse(theme, "android:windowSplashScreenIconBackgroundColor" in items)
        }
    }

    @Test fun itsIBeamIsIBeamsOwnPartsAsLargeAsTheSplashsCircleHolds() {
        val vector = xml("drawable/splash_ibeam.xml")
        assertEquals("vector", vector.tagName)
        assertEquals("288dp", vector.getAttribute("android:width"))
        assertEquals("288dp", vector.getAttribute("android:height"))
        assertEquals("288", vector.getAttribute("android:viewportWidth"))
        assertEquals("288", vector.getAttribute("android:viewportHeight"))
        // One path in the page's ink, and nothing else: no field, no tile, no circle.
        val paths = vector.children("path")
        assertEquals(1, paths.size)
        assertEquals(1, (0 until vector.childNodes.length).count { vector.childNodes.item(it) is Element })
        assertEquals("@color/ink", paths[0].getAttribute("android:fillColor"))

        // The largest whole dp to a unit of IBeam's 100-unit box at which its corners stay inside the 192 dp circle.
        val halfWidth = IBeam.rects.maxOf { maxOf(50 - it.x0, it.x1 - 50) }
        val halfHeight = IBeam.rects.maxOf { maxOf(50 - it.y0, it.y1 - 50) }
        val unit = floor(96 / hypot(halfWidth, halfHeight))
        assertEquals(2.0, unit, 0.0)
        val want = IBeam.rects.map { IBeam.Part(144 + (it.x0 - 50) * unit, 144 + (it.y0 - 50) * unit, 144 + (it.x1 - 50) * unit, 144 + (it.y1 - 50) * unit) }
        val drawn = Regex("""M([\d.]+),([\d.]+)H([\d.]+)V([\d.]+)H([\d.]+)Z""").findAll(paths[0].getAttribute("android:pathData")).map { m ->
            val (x0, y0, x1, y1, back) = m.destructured
            assertEquals(x0, back)
            IBeam.Part(x0.toDouble(), y0.toDouble(), x1.toDouble(), y1.toDouble())
        }.toList()
        assertEquals(want, drawn)
    }

    @Test fun itsInkIsThePagesInkLightAndDark() {
        fun ink(path: String) = xml(path).children("color").single { it.getAttribute("name") == "ink" }.textContent.trim()
        fun hex(argb: Int) = "#%06X".format(argb and 0xFFFFFF)
        assertEquals(hex(LightInk.toArgb()), ink("values/colors.xml"))
        assertEquals(hex(DarkInk.toArgb()), ink("values-night/colors.xml"))
    }
}
