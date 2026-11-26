package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The app's mark, the I-beam, drawn from its parts (IBeam): held to scripts/mark.ts, the icons' own renderer, through the
 * vectors (their `mark`), so the mark in the app is the one on the home screen. The iPhone's MarkTests, case for case.
 */
class IBeamTest {
    private val mark = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["mark"]

    @Test fun itsRectanglesAndItsBoxAreTheIconsOwn() {
        assertEquals(mark["rects"].list.map { r -> r.list.map { it.double!! } }, IBeam.rects.map { listOf(it.x0, it.y0, it.x1, it.y1) })
        assertEquals(mark["box"].double!!, IBeam.BOX, 0.0)
    }

    @Test fun itFillsExactlyTheIconsPolygonAtAnySize() {
        // The polygon scripts/mark.ts gives SVG, in its 100-unit box.
        val points = mark["polygon"].string!!.split(" ").map { pair -> pair.split(",").map { it.toDouble() } }
        for (side in listOf(18.0, 48.0, 100.0)) {
            val parts = IBeam.parts(side, side)
            // A grid over the frame, each point inside the parts exactly where it is inside the polygon (the box centred,
            // at BOX).
            val unit = side * IBeam.BOX / 100
            for (i in 0 until 40) for (j in 0 until 40) {
                val x = (i + 0.5) * side / 40
                val y = (j + 0.5) * side / 40
                val drawn = parts.any { x >= it.x0 && x < it.x1 && y >= it.y0 && y < it.y1 }
                val icon = inside(points, (x - side / 2) / unit + 50, (y - side / 2) / unit + 50)
                assertEquals("at ($x, $y) in a $side dp frame", icon, drawn)
            }
        }
    }

    @Test fun itIsCentredAndKeepsItsProportionsInAFrameThatIsntSquare() {
        val parts = IBeam.parts(200.0, 100.0)
        val left = parts.minOf { it.x0 }
        val right = parts.maxOf { it.x1 }
        val top = parts.minOf { it.y0 }
        val bottom = parts.maxOf { it.y1 }
        // The 100-unit box on the shorter side: 0.7 of 100, its mark 56 × 72 units of it, centred.
        assertEquals(56 * 0.7, right - left, 1e-9)
        assertEquals(72 * 0.7, bottom - top, 1e-9)
        assertEquals(100.0, (left + right) / 2, 1e-9)
        assertEquals(50.0, (top + bottom) / 2, 1e-9)
    }

    /** Whether (x, y) is inside the polygon, by the even-odd rule. */
    private fun inside(points: List<List<Double>>, x: Double, y: Double): Boolean {
        var odd = false
        var j = points.size - 1
        for (i in points.indices) {
            val (xi, yi) = points[i]
            val (xj, yj) = points[j]
            if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) odd = !odd
            j = i
        }
        return odd
    }
}
