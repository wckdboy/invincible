package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/*
 * The message box (the owner's word of 27 November 2026, "something like t3code on desktop, and openmausbot/grokbot on
 * mobile"; the web's and the iPhone's): one rounded box, its words across its whole width, its buttons on a line under
 * them, what leads (attach) on the left and what sends on the right. No button shares the words' line, so nothing
 * squeezes them: Queue, Steer and Stop beside the field had left a phone's box a few words wide while an answer was
 * written. A tap anywhere on it that is no button puts the keys in it.
 */

/** Its corners: a thumb's round, as the web's box. */
private val BOX = RoundedCornerShape(24.dp)

/** A button's disc in it (send, stop): drawn this size, touched at a thumb's. */
private val DISC = 32.dp

/** A line of its words, as the field draws one (Material's text field, at its least): the pill's height. */
private val LINE = 56.dp

/**
 * The box: [field] (a [ComposerField]) with [leading] on the left and [trailing] on the right. [compact], Grok Bot's pill
 * (the owner's structure, 28 November 2026): one row, what leads, the words, what sends, its corners a thumb's round, so
 * it reads as a pill on one line and grows into a box as the words wrap (to eight lines), its buttons at its foot. Not
 * compact: the words across its whole width and its buttons on a line under them, while there is more to choose than
 * fits beside the words (Queue, Steer and Stop as it works). [focus] is the field's, which a tap on the box asks for.
 */
@Composable
fun ComposerBox(focus: FocusRequester, modifier: Modifier = Modifier, compact: Boolean = true, field: @Composable () -> Unit, leading: @Composable RowScope.() -> Unit = {}, trailing: @Composable RowScope.() -> Unit) {
    val brand = LocalBrand.current
    val box = modifier
        .fillMaxWidth()
        .clip(BOX)
        .border(BorderStroke(1.dp, brand.line), BOX)
        .background(brand.raised)
        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { runCatching { focus.requestFocus() } }
    if (compact) {
        Row(box.padding(horizontal = Space.s1), verticalAlignment = Alignment.Bottom) {
            // (Its buttons centred on a line of words, and kept at its foot as the words wrap.)
            Row(Modifier.height(LINE), verticalAlignment = Alignment.CenterVertically) { leading() }
            Box(Modifier.weight(1f)) { field() }
            Row(Modifier.height(LINE), verticalAlignment = Alignment.CenterVertically) { trailing() }
        }
        return
    }
    Column(box) {
        Box(Modifier.fillMaxWidth().padding(top = Space.s1)) { field() }
        Row(
            Modifier.fillMaxWidth().padding(start = Space.s1, end = Space.s1, bottom = Space.s1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s1),
        ) {
            leading()
            Spacer(Modifier.weight(1f))
            trailing()
        }
    }
}

/**
 * The box's words: across its whole width, growing to eight lines, on nothing of their own. A hardware keyboard's Enter
 * does [enter] (where there is one) and Shift+Enter starts a new line; a phone's own keyboard keeps its return.
 */
@Composable
fun ComposerField(value: String, onValueChange: (String) -> Unit, placeholder: String, focus: FocusRequester, enabled: Boolean = true, enter: (() -> Unit)? = null) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, style = Type.body) },
        textStyle = Type.body,
        maxLines = 8,
        enabled = enabled,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent,
            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(focus)
            .semantics { contentDescription = placeholder.trimEnd('…') }
            .onPreviewKeyEvent { e ->
                val physical = e.nativeKeyEvent.deviceId != android.view.KeyCharacterMap.VIRTUAL_KEYBOARD
                if (enter != null && physical && e.type == KeyEventType.KeyDown && e.key == Key.Enter && !e.isShiftPressed) {
                    enter()
                    true
                } else false
            },
    )
}

/** A disc in the box (Send, Stop): in the ink while it can be pressed (the one filled thing then), quiet otherwise; the same size either way, so nothing moves. */
@Composable
fun ComposerDisc(icon: ImageVector, label: String, ready: Boolean, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Box(
        Modifier
            .sizeIn(minWidth = Space.touch, minHeight = Space.touch)
            .clip(CircleShape)
            .clickable(enabled = ready, onClick = onClick)
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = label
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(DISC).clip(CircleShape).background(if (ready) brand.ink else brand.line), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, Modifier.size(18.dp), tint = if (ready) brand.paper else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** One way a message goes while it works (Queue, Steer), in words: a capsule in the ink for the one sending does once something is written, quiet for the other, off while nothing is. */
@Composable
fun ComposerChoice(title: String, filled: Boolean, ready: Boolean, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Box(
        Modifier
            .heightIn(min = Space.touch)
            .clip(CircleShape)
            .clickable(enabled = ready, onClick = onClick)
            .semantics(mergeDescendants = true) { role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            title,
            style = Type.word,
            color = when {
                filled && ready -> brand.paper
                ready -> MaterialTheme.colorScheme.onSurface
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.heightIn(min = DISC).clip(CircleShape).background(if (filled && ready) brand.ink else brand.line).padding(horizontal = Space.s3, vertical = 6.dp),
        )
    }
}
