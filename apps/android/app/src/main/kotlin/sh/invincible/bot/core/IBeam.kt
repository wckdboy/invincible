package sh.invincible.bot.core

/*
 * Invincible's mark, the I-beam (scripts/mark.ts, the owner's choice of 26 November 2026: "minimal bold monochrome"): one
 * solid form in one ink, the steel section and the letter I, three rectangles (two flanges and the web between them). The
 * app icon is drawn from the same rectangles (scripts/brand.ts), and IBeamTest holds these to them through the vectors. In
 * the app it is the app's own mark (joining, About, the sidebar's head) and the primary's: the one you talk to is shown by
 * the I-beam in ink, never an orb; the agents keep their marks, the only colour on a page besides what went wrong.
 */
object IBeam {
    /** A rectangle, from its top left corner (x0, y0) to its bottom right (x1, y1). */
    data class Part(val x0: Double, val y0: Double, val x1: Double, val y1: Double)

    /** The top flange, the web, the bottom flange, in the 100-unit box (scripts/mark.ts, MARK_RECTS). */
    val rects = listOf(Part(22.0, 14.0, 78.0, 30.0), Part(41.0, 30.0, 59.0, 70.0), Part(22.0, 70.0, 78.0, 86.0))

    /** How much of a frame's shorter side the 100-unit box spans (MARK_BOX), so it sits in a frame as on the icon's tile. */
    const val BOX = 0.7

    /** Its parts in a frame `width` × `height`: the 100-unit box centred, on the shorter side, at BOX. */
    fun parts(width: Double, height: Double): List<Part> {
        val unit = minOf(width, height) * BOX / 100
        val left = width / 2 - 50 * unit
        val top = height / 2 - 50 * unit
        return rects.map { Part(left + it.x0 * unit, top + it.y0 * unit, left + it.x1 * unit, top + it.y1 * unit) }
    }
}
