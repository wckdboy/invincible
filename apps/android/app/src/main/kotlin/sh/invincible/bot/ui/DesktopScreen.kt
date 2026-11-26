package sh.invincible.bot.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Desktop
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int

/**
 * An agent's screen, watched and taken over (the PWA's desktop viewer, the Apple app's AgentScreenView): a picture of
 * its desktop, asked for about every two seconds while it is on screen and the app is in front, and what you do there.
 * A tap on the picture clicks at that place on the agent's screen; text is typed (and never written to the ledger); a
 * key, an address and scrolling are one press each. Each thing done brings back the screen as it then is. [onMac]: [id]
 * is a Mac's node, and the screen is the Mac's own, while the primary is let use it (the Inbox's session).
 */
@Composable
fun DesktopScreen(app: AppModel, id: String, name: String, onMac: Boolean = false, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    val front by app.front.collectAsState()
    var shot by remember { mutableStateOf<Json?>(null) }
    var picture by remember { mutableStateOf<ImageBitmap?>(null) }
    var status by remember { mutableStateOf("Looking…") }
    var problem by remember { mutableStateOf<String?>(null) }
    var noDesktop by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf("") }
    var typed by remember { mutableStateOf("") }
    var hidden by remember { mutableStateOf(false) }
    // Each look or thing done waits for the one before it: none is dropped, and never two at once.
    val turn = remember { Mutex() }
    val brand = LocalBrand.current

    suspend fun send(action: Json?) = turn.withLock {
        val client = app.client ?: return@withLock
        sending = true
        if (action != null) status = "Sending…"
        try {
            val next = if (onMac) client.post("/api/screen/desktop", Json.obj("on" to id, "action" to action)) else client.post("/api/team/desktop", Json.obj("id" to id, "action" to action))
            val bytes = Desktop.picture(next)
            val image = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (image == null) {
                problem = "The desktop sent a picture this app doesn't show."
            } else {
                shot = next
                picture = image.asImageBitmap()
                problem = null
                noDesktop = false
                status = "Seen just now · ${next["width"].int}×${next["height"].int}"
            }
        } catch (e: NodeError) {
            // Nothing more is asked until you ask: a refusal is said once, not every two seconds.
            // (A Mac's refusal says what it is in its own words: it has no VM to make again.)
            if (!onMac && Desktop.saysNoDesktop(e)) noDesktop = true else problem = e.message
            status = if (shot == null) "Not seen" else "As it was last seen"
        } finally {
            sending = false
        }
    }
    fun act(action: Json?) {
        scope.launch { send(action) }
    }

    // Asked again while you're watching, and only then.
    LaunchedEffect(id, front) {
        if (!front) return@LaunchedEffect
        while (true) {
            if (problem == null && !noDesktop && !sending) send(null)
            delay(2_000)
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar("$name's screen", back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
            val (w, h) = (shot?.get("width").int ?: 16) to (shot?.get("height").int ?: 10)
            Box(
                Modifier.fillMaxWidth().aspectRatio(w.toFloat() / h).clip(MaterialTheme.shapes.medium).background(Color(0xFF141416)),
                contentAlignment = Alignment.Center,
            ) {
                picture?.let { image ->
                    Image(
                        image,
                        contentDescription = "$name's screen. A tap clicks at that place on it.",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize().pointerInput(w, h) {
                            // The box has the picture's own shape, so the picture fills it: a tap is read against the box.
                            detectTapGestures { at ->
                                Desktop.point(at.x.toDouble(), at.y.toDouble(), 0.0, 0.0, size.width.toDouble(), size.height.toDouble(), w, h)?.let { act(Desktop.click(it.x, it.y)) }
                            }
                        },
                    )
                } ?: Text("Looking…", color = Color(0xFFEDEDEF), style = MaterialTheme.typography.bodyMedium)
            }
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (noDesktop) {
                Text("$name's VM has no desktop just now. Make it again with a desktop from a terminal or the web app: its work in /work stays.", style = MaterialTheme.typography.bodyMedium, color = brand.failed)
            } else problem?.let { p ->
                Text(p, style = MaterialTheme.typography.bodyMedium, color = brand.failed)
                OutlinedButton(onClick = { act(null) }) { Text("Try again") }
            }
            fun open() {
                Desktop.address(address)?.let { act(Desktop.open(it)) }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    placeholder = { Text("An address to open") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { open() }),
                    modifier = Modifier.weight(1f),
                )
                AnswerPill("Open", { open() }, enabled = Desktop.address(address) != null)
            }
            fun type() {
                val text = typed
                typed = ""
                if (text.isNotEmpty()) act(Desktop.type(text))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    placeholder = { Text("Text to type on $name's screen") },
                    singleLine = true,
                    visualTransformation = if (hidden) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = if (hidden) KeyboardType.Password else KeyboardType.Text,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = { type() }),
                    modifier = Modifier.weight(1f),
                )
                AnswerPill("Type", { type() }, enabled = typed.isNotEmpty())
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = hidden, onCheckedChange = { hidden = it })
                Text("Hide what I type", style = MaterialTheme.typography.bodyMedium)
            }
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                for ((label, key) in Desktop.keys) OutlinedButton(onClick = { act(Desktop.key(key)) }, enabled = shot != null) { Text(label) }
                OutlinedButton(onClick = { act(Desktop.scroll(up = true, times = 3)) }, enabled = shot != null) { Text("Scroll up") }
                OutlinedButton(onClick = { act(Desktop.scroll(up = false, times = 3)) }, enabled = shot != null) { Text("Scroll down") }
            }
            Text(
                "What you type goes to $name's screen and nowhere else: it isn't kept here, and the ledger says only that something was typed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
