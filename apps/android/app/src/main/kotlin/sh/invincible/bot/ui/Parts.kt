@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.ButtonShapes
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.invincible.bot.core.AgentState

/** A state in a word, in its colour: a still chip, never an animation. None for an agent at rest. */
@Composable
fun StateChip(state: AgentState?) {
    val words = state?.words ?: return
    val color = LocalBrand.current.of(state.tone) ?: MaterialTheme.colorScheme.onSurfaceVariant
    Text(
        words,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/**
 * A state's dot: a plain round of its ink beside its word, still (the iPhone's OrbPip, I9; the owner's bar: nothing moving
 * at rest). The word beside it says what goes on; the dot is never alone. ([live] is kept for the places that pass it: a
 * dot no longer sends out waves, nor is it lit.)
 */
@Composable
fun Dot(color: Color, size: Int = 8, @Suppress("UNUSED_PARAMETER") live: Boolean = false) {
    Canvas(Modifier.size(size.dp)) { drawCircle(color) }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmallEmphasized,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(horizontal = Space.margin, vertical = Space.s2).semantics { heading() },
    )
}

/**
 * A page's bar (Material's top app bar): back to where it opened from, what it is, and what it offers. The page already
 * sits below the status bar, so the bar adds no inset of its own. What it offers comes last, since pages pass it as a
 * trailing lambda (PageBarTest).
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun PageBar(title: String, back: () -> Unit, navigation: (@Composable () -> Unit)? = null, titleContent: (@Composable () -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    TopAppBar(
        // (A page may name itself with more than words: an agent's, its glass beside its name.)
        title = { if (titleContent != null) titleContent() else Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        // (Back, unless the page says otherwise: the primary's conversation, at the root, opens the roster there instead.)
        navigationIcon = navigation ?: { IconButton(onClick = back) { Icon(BackIcon, contentDescription = "Back") } },
        actions = actions,
        windowInsets = WindowInsets(0),
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
    )
}

/**
 * A decision, as Material 3 Expressive draws one: the two answers as a connected pair, the yes filled, each changing
 * shape as it's pressed.
 */
@Composable
fun Decision(no: String, yes: String, onNo: () -> Unit, onYes: () -> Unit, enabled: Boolean = true) {
    Row(horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween)) {
        OutlinedButton(
            onClick = onNo,
            enabled = enabled,
            shapes = ButtonShapes(ButtonGroupDefaults.connectedLeadingButtonShape, ButtonGroupDefaults.connectedLeadingButtonPressShape),
        ) { Text(no) }
        // (An answer, among others on a page: a grey pill, never a filled button. A screen has one of those at most.)
        androidx.compose.material3.FilledTonalButton(
            onClick = onYes,
            enabled = enabled,
            colors = pillColors(),
            shapes = ButtonShapes(ButtonGroupDefaults.connectedTrailingButtonShape, ButtonGroupDefaults.connectedTrailingButtonPressShape),
        ) { Text(yes) }
    }
}

/** A raised card, as the Inbox's cards are. */
@Composable
fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.margin, vertical = Space.s1)
            .clip(MaterialTheme.shapes.large)
            .background(LocalBrand.current.raised)
            .padding(Space.s4),
        verticalArrangement = Arrangement.spacedBy(Space.s2),
    ) { content() }
}

/** What the node said went wrong, in its words, where it shows. */
@Composable
fun Problem(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.margin, vertical = Space.s1)
            .clip(MaterialTheme.shapes.medium)
            .background(LocalBrand.current.needs.copy(alpha = 0.12f))
            .padding(Space.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        // (Beside the first line, its foot on that line's baseline: centred on a paragraph, it read as a list's bullet.)
        androidx.compose.foundation.layout.Box(Modifier.alignBy { it.measuredHeight }) { Dot(LocalBrand.current.needs) }
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.alignByBaseline())
    }
}

/** A sheet that opens all the way (no half-open stop): every sheet of the app's. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun rememberFullSheet(): androidx.compose.material3.SheetState =
    androidx.compose.material3.rememberBottomSheetState(androidx.compose.material3.SheetValue.Hidden, setOf(androidx.compose.material3.SheetValue.Hidden, androidx.compose.material3.SheetValue.Expanded))

/**
 * An answer on a card (Approve, Allow once, Give again…): one tap. A filled one for the answer it leads with, an outlined
 * one in a hairline for the others. Drawn 36 dp tall and quiet, as the web's small buttons are; Material keeps its touch
 * target 48 dp all the same.
 */
@Composable
fun ActionButton(text: String, onClick: () -> Unit, primary: Boolean = true, enabled: Boolean = true, icon: ImageVector? = null) {
    val padding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 0.dp)
    val content: @Composable RowScope.() -> Unit = {
        if (icon != null) {
            Icon(icon, null, Modifier.size(16.dp))
            androidx.compose.foundation.layout.Spacer(Modifier.size(6.dp))
        }
        Text(text, style = Type.word.copy(fontSize = 14.sp))
    }
    if (primary) Button(onClick = onClick, enabled = enabled, contentPadding = padding, modifier = Modifier.heightIn(min = 36.dp), content = content)
    else OutlinedButton(onClick = onClick, enabled = enabled, contentPadding = padding, modifier = Modifier.heightIn(min = 36.dp), border = androidx.compose.foundation.BorderStroke(1.dp, LocalBrand.current.line), content = content)
}
