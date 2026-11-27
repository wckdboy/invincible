package sh.invincible.bot.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import sh.invincible.bot.core.IBeam
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * A notification's small icon (Notices.kt's setSmallIcon), which Android draws in one colour in the status bar and the
 * shade: the bare I-beam, as everywhere the app draws its mark (the owner's word of 27 November 2026, "the Logo is just
 * the I beam"), where it had been the ring and dots of the agents' first mark. Its path is IBeam's three parts in their
 * own 100-unit box, which spans the 24 dp icon. (Read from the source tree, as SplashTest reads the splash.)
 */
class NotifyIconTest {
    @Test fun itIsTheBareIBeamInOneColourInItsOwnBox() {
        val file = File("src/main/res/drawable/ic_notify.xml")
        assertTrue("$file is there", file.isFile)
        val vector = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
        assertEquals("vector", vector.tagName)
        assertEquals("24dp", vector.getAttribute("android:width"))
        assertEquals("24dp", vector.getAttribute("android:height"))
        assertEquals("100", vector.getAttribute("android:viewportWidth"))
        assertEquals("100", vector.getAttribute("android:viewportHeight"))
        // One filled path and nothing else: no ring, no dots, no group.
        val children = (0 until vector.childNodes.length).map { vector.childNodes.item(it) }.filterIsInstance<Element>()
        assertEquals(listOf("path"), children.map { it.tagName })
        val path = children.single()
        assertEquals("", path.getAttribute("android:strokeColor"))
        assertTrue(path.getAttribute("android:fillColor").matches(Regex("#(FF)?[0-9A-Fa-f]{6}")))
        val drawn = Regex("""M([\d.]+),([\d.]+)H([\d.]+)V([\d.]+)H([\d.]+)Z""").findAll(path.getAttribute("android:pathData")).map { m ->
            val (x0, y0, x1, y1, back) = m.destructured
            assertEquals(x0, back)
            IBeam.Part(x0.toDouble(), y0.toDouble(), x1.toDouble(), y1.toDouble())
        }.toList()
        assertEquals(IBeam.rects, drawn)
        // So the mark stands 72 units of 100 tall over the 24 dp: inside the 20 dp a status bar icon keeps off its edges.
        assertTrue(IBeam.rects.maxOf { it.y1 } - IBeam.rects.minOf { it.y0 } <= 100 * 20 / 24.0)
    }
}
