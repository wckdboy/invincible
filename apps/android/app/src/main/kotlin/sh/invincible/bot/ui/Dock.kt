package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/**
 * A message box docked at a page's foot (the web's composer): what leads it ([lead], "+" on Home), a field that grows to
 * six lines, and a round send; a [hint] under it where there is one ("Ada answers once this work ends"). On a keyboard,
 * Enter sends and Shift+Enter starts a new line. [send] is handed the words, trimmed; true: they went, and the box empties.
 * [key] keeps what you wrote while you are away from the page (each conversation its own).
 */
@Composable
fun MessageDock(
    placeholder: String,
    key: String,
    enabled: Boolean = true,
    hint: String? = null,
    lead: (@Composable () -> Unit)? = null,
    before: (@Composable () -> Unit)? = null,
    after: (@Composable () -> Unit)? = null,
    /** A second way to send what's written, by its words, beside the send (shown once something is written). */
    also: Pair<String, (String) -> Boolean>? = null,
    send: (String) -> Boolean,
) {
    val brand = LocalBrand.current
    var text by rememberSaveable(key) { mutableStateOf("") }
    fun deliver() {
        val words = text.trim()
        if (words.isNotEmpty() && enabled && send(words)) text = ""
    }
    // One big box (the owner's word, 27 November 2026): the words across all of it, and under them what leads on the left and
    // what sends on the right, the second way to send ([also]) beside Send.
    val focus = androidx.compose.runtime.remember { androidx.compose.ui.focus.FocusRequester() }
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2)) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            before?.invoke()
            ComposerBox(
                focus = focus,
                modifier = Modifier.weight(1f),
                field = { ComposerField(text, { text = it }, placeholder, focus, enabled = enabled, enter = ::deliver) },
                leading = { lead?.invoke() },
                trailing = {
                    also?.let { (label, go) -> ComposerChoice(label, filled = false, ready = enabled && text.isNotBlank()) { if (go(text.trim())) text = "" } }
                    ComposerDisc(SendIcon, "Send", ready = enabled && text.isNotBlank(), onClick = ::deliver)
                },
            )
            after?.invoke()
        }
        hint?.let { Text(it, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = Space.s4, top = Space.s1)) }
    }
}
