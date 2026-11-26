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
    send: (String) -> Boolean,
) {
    val brand = LocalBrand.current
    var text by rememberSaveable(key) { mutableStateOf("") }
    val shape = RoundedCornerShape(26.dp)
    fun deliver() {
        val words = text.trim()
        if (words.isNotEmpty() && enabled && send(words)) text = ""
    }
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2)) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
        before?.invoke()
        Row(
            Modifier.weight(1f).clip(shape).border(BorderStroke(1.dp, brand.line), shape).background(brand.raised).padding(Space.s1),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(Space.s1),
        ) {
            if (lead != null) lead() else Spacer(Modifier.size(Space.s2))
            TextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(placeholder, style = Type.body) },
                textStyle = Type.body,
                maxLines = 6,
                enabled = enabled,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                keyboardActions = KeyboardActions(),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = placeholder.trimEnd('…') }
                    // A hardware keyboard's Enter sends; Shift+Enter is a new line (a phone's own keyboard keeps its return).
                    .onPreviewKeyEvent { e ->
                        val physical = e.nativeKeyEvent.deviceId != android.view.KeyCharacterMap.VIRTUAL_KEYBOARD
                        if (physical && e.type == KeyEventType.KeyDown && e.key == Key.Enter && !e.isShiftPressed) {
                            deliver()
                            true
                        } else false
                    },
            )
            FilledIconButton(onClick = ::deliver, enabled = enabled && text.isNotBlank()) { Icon(SendIcon, contentDescription = "Send") }
        }
        after?.invoke()
        }
        hint?.let { Text(it, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = Space.s4, top = Space.s1)) }
    }
}
