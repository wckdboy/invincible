package sh.invincible.bot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import sh.invincible.bot.core.IBeam

/*
 * Invincible's mark, the I-beam (core/IBeam.kt, from scripts/mark.ts), as a page shows it: one solid form in one ink, the
 * page's (black on light, white on dark), on nothing, so it sits on a light page as on a dark one. It is the app's own mark
 * and the primary's: the one you talk to is the I-beam, never an orb, and it is still (what it is doing is said in words).
 */

/** The I-beam in `color`, in a `size` frame. Its three parts are one path, so no seam shows where they meet. Decorative
 * unless named ([description]). */
@Composable
fun IBeamMark(size: Dp, color: Color = LocalBrand.current.ink, description: String? = null) {
    val named = if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier.clearAndSetSemantics { }
    Canvas(Modifier.size(size).then(named)) {
        val path = Path()
        for (part in IBeam.parts(this.size.width.toDouble(), this.size.height.toDouble())) {
            path.addRect(Rect(part.x0.toFloat(), part.y0.toFloat(), part.x1.toFloat(), part.y1.toFloat()))
        }
        drawPath(path, color)
    }
}

/** The app's mark where a page shows it (joining, Settings' About, the sidebar's head). Decorative: what it is in is named. */
@Composable
fun AppMark(size: Dp) = IBeamMark(size)

/** The primary, wherever it is shown (Home's head, a chat, the sidebar, who gave a task): the I-beam in ink. */
@Composable
fun PrimaryMark(size: Dp, description: String? = null) = IBeamMark(size, description = description)
