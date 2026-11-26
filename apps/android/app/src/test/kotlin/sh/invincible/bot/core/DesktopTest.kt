package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** An agent's desktop as the PWA and the Apple app read it: the parity vectors' `desktop`, answer for answer. */
class DesktopTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["desktop"]!!

    private fun Json?.num(): Double = double!!

    @Test
    fun aTapLandsWhereThePictureShowsIt() {
        val cases = v["points"].list
        assertEquals(7, cases.size)
        for (c in cases) {
            val shown = c["shown"]
            val got = Desktop.point(
                c["tap"]["x"].num(), c["tap"]["y"].num(),
                shown["left"].num(), shown["top"].num(), shown["width"].num(), shown["height"].num(),
                c["screen"]["width"].int!!, c["screen"]["height"].int!!,
            )
            val want = c["point"].takeIf { it != null && it != Json.Null }?.let { Desktop.Point(it["x"].int!!, it["y"].int!!) }
            assertEquals("tap ${c["tap"]}", want, got)
        }
    }

    @Test
    fun anAddressIsWhatTheDesktopsBrowserTakes() {
        val cases = v["addresses"].list
        assertEquals(13, cases.size)
        for (c in cases) assertEquals("\"${c["text"].string?.take(40)}\"", c["address"].string, Desktop.address(c["text"].string!!))
    }

    @Test
    fun onlyAJpegOrPngOfAScreenWithASizeIsShown() {
        val cases = v["shots"].list
        assertEquals(6, cases.size)
        for (c in cases) assertEquals("${c["view"]}", c["shown"].bool, Desktop.shown(c["view"]!!))
    }

    @Test
    fun theNodesRefusalOfADesktopIsToldApart() {
        assertTrue(Desktop.saysNoDesktop(NodeError(424, "this VM has no desktop: make it again with one")))
        assertFalse(Desktop.saysNoDesktop(NodeError(424, "something else")))
        assertFalse(Desktop.saysNoDesktop(NodeError(500, "no desktop")))
    }
}
