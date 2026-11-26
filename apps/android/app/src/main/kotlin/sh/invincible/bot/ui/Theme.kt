package sh.invincible.bot.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.invincible.bot.core.AgentState

/*
 * The primary's look on Android: Android's own components, with the primary's accents, as the Apple app is Apple's with them.
 * Material 3 Expressive (the owner's word, 21 Nov): its motion (springs that answer a tap or a page opening), its
 * emphasized type and its shapes. The colours are the brand's, never the wallpaper's (apps/web/src/brand.ts INK, the
 * Apple app's asset catalog and Brand.swift): ink on paper, cream on the dark, the red of what went wrong, and one colour a
 * state (blue at work, amber needs you, red failed, green done), always with its word. Only the orb in focus moves (the
 * owner's word, 26 Nov): the primary's on Home, an agent's in its own thread while it works; nothing else moves at rest.
 */

@Immutable
data class Brand(
    val ink: Color,
    val onInk: Color,
    val paper: Color,
    val raised: Color,
    val line: Color,
    val quiet: Color,
    val danger: Color,
    val working: Color,
    val needs: Color,
    val failed: Color,
    val done: Color,
) {
    fun of(tone: AgentState.Tone): Color? = when (tone) {
        AgentState.Tone.WORK -> working
        AgentState.Tone.NEEDS -> needs
        AgentState.Tone.FAILED -> failed
        AgentState.Tone.OK -> done
        AgentState.Tone.NEUTRAL -> null
    }
}

private val Light = Brand(
    ink = Color(0xFF0A0A0B), onInk = Color(0xFFF8EBDC), paper = Color(0xFFFFFFFF), raised = Color(0xFFF4F4F5), line = Color(0x1F0A0A0B),
    quiet = Color(0xFF5E5E66), danger = Color(0xFFC4141B), working = Color(0xFF0A5FCC), needs = Color(0xFF946200), failed = Color(0xFFC4141B),
    done = Color(0xFF137A43),
)

private val Dark = Brand(
    ink = Color(0xFFF8EBDC), onInk = Color(0xFF0A0A0B), paper = Color(0xFF141416), raised = Color(0xFF1E1E21), line = Color(0x24F8EBDC),
    quiet = Color(0xFFA3A3AB), danger = Color(0xFFEE2C36), working = Color(0xFF58A6FF), needs = Color(0xFFF0B549), failed = Color(0xFFFF6B6B),
    done = Color(0xFF4CC38A),
)

val LocalBrand = staticCompositionLocalOf { Light }

/** The spacing scale (the PWA's --sp-*, Brand.swift's Space), in dp. */
object Space {
    val s1 = 4.dp
    val s2 = 8.dp
    val s3 = 12.dp
    val s4 = 16.dp
    val s5 = 20.dp
    val s6 = 24.dp
    val s8 = 32.dp
    val s10 = 40.dp
    val margin = 16.dp
    val touch = 48.dp
    /** A wide screen's sidebar (T3 Code's, about 268 wide on the web), and the details card beside a task's thread. */
    val sidebar = 280.dp
    val details = 320.dp
    /** Wide enough for the sidebar beside a pane; and for a task's details card beside its thread too. */
    val wide = 720.dp
    val roomy = 1100.dp
}

/**
 * The type scale beyond Material's own (the PWA's DESIGN.md: a phone's body 15, its meta 13; tighter tracking on titles,
 * tabular figures for times and money, mono only for commands and paths). Sizes in sp, so they follow the font scale.
 */
object Type {
    private val tnum = "tnum"
    val display = TextStyle(fontSize = 26.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.6).sp)
    val title = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.25).sp)
    val section = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp)
    val body = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, letterSpacing = 0.sp)
    val rowTitle = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.1).sp)
    val meta = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, letterSpacing = 0.sp, fontFeatureSettings = tnum)
    val small = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.1.sp, fontFeatureSettings = tnum)
    val word = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp, fontFeatureSettings = tnum)
    val mono = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace, letterSpacing = 0.sp)
    val badge = TextStyle(fontSize = 10.sp, lineHeight = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.sp)
}

/** Material's type, its titles and headings tracked tighter (the primary's titles are set close, as the web's Geist is). */
private fun invincibleTypography(): Typography {
    val t = Typography()
    fun TextStyle.tight(by: Double) = copy(letterSpacing = (fontSize.value * by).sp)
    return t.copy(
        displayLarge = t.displayLarge.tight(-0.025), displayMedium = t.displayMedium.tight(-0.025), displaySmall = t.displaySmall.tight(-0.02),
        headlineLarge = t.headlineLarge.tight(-0.02), headlineMedium = t.headlineMedium.tight(-0.02), headlineSmall = t.headlineSmall.tight(-0.015),
        titleLarge = t.titleLarge.tight(-0.012), titleMedium = t.titleMedium.tight(-0.006), titleSmall = t.titleSmall.tight(0.0),
    )
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun InvincibleTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val b = if (dark) Dark else Light
    val scheme = if (dark) {
        darkColorScheme(
            primary = b.ink, onPrimary = b.onInk, secondary = b.ink, onSecondary = b.onInk, background = b.paper, onBackground = b.ink,
            surface = b.paper, onSurface = b.ink, surfaceVariant = b.raised, onSurfaceVariant = b.quiet, surfaceContainer = b.raised,
            surfaceContainerHigh = b.raised, surfaceContainerLow = b.paper, outline = b.line, outlineVariant = b.line, error = b.failed,
            secondaryContainer = b.raised, onSecondaryContainer = b.ink,
        )
    } else {
        lightColorScheme(
            primary = b.ink, onPrimary = b.onInk, secondary = b.ink, onSecondary = b.onInk, background = b.paper, onBackground = b.ink,
            surface = b.paper, onSurface = b.ink, surfaceVariant = b.raised, onSurfaceVariant = b.quiet, surfaceContainer = b.raised,
            surfaceContainerHigh = b.raised, surfaceContainerLow = b.paper, outline = b.line, outlineVariant = b.line, error = b.failed,
            secondaryContainer = b.raised, onSecondaryContainer = b.ink,
        )
    }
    val shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(20.dp))
    CompositionLocalProvider(LocalBrand provides b) {
        MaterialExpressiveTheme(colorScheme = scheme, shapes = shapes, typography = invincibleTypography(), content = content)
    }
}
