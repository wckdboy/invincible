package sh.invincible.bot.ui

import android.graphics.BitmapFactory
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
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
import androidx.compose.ui.viewinterop.AndroidView
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Desktop
import sh.invincible.bot.core.DesktopHold
import sh.invincible.bot.core.DesktopWatch
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int

/**
 * An agent's screen, watched and taken over (the PWA's desktop viewer, the Apple app's AgentScreenView).
 * - An agent's VM: live, the node's stream of its screen (DesktopDecoder, MediaCodec onto a surface) while it is on screen
 *   and the app is in front; a stream that ends is watched again a little later each time, and after a few tries in a
 *   row, or a refusal, it gives way to the picture (DesktopWatch).
 * - The picture: a Mac's own screen ([onMac]: [id] is its node, while the primary is let use it), or a VM's where it isn't
 *   live, asked for about every two seconds.
 * - What you do there: a tap clicks at that place on its screen; text is typed (and never written to the ledger); a key,
 *   an address and scrolling are one press each. While it is live, a thing done brings back no picture (the stream shows
 *   it); otherwise each brings back the screen as it then is.
 * - Your take-over (a VM's): your input takes the desktop over if no one has it, as Take over does; while you have it,
 *   the agent's own desktop commands wait. The row says until when, and changes when the node says so, and once at the
 *   end: nothing counts down.
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
    // A VM's screen live: its surface, its size, and how it stands (DesktopWatch: drawing now; its last frame what the box
    // shows, between one stream and the next too; or given up for the picture, and why). What runs on reads it as it is
    // now (watch.state.value); what is drawn, as it was when drawn (live).
    var surface by remember { mutableStateOf<Surface?>(null) }
    var liveSize by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    val watch = remember { DesktopWatch() }
    val live by watch.state.collectAsState()
    // Your take-over as the node said it last, and when it ends by this phone's clock (ms).
    var held by remember { mutableStateOf<DesktopHold?>(null) }
    var heldEnds by remember { mutableStateOf<Double?>(null) }
    fun heard(next: DesktopHold?) {
        held = next
        heldEnds = next?.ends(System.currentTimeMillis().toDouble())
    }

    suspend fun send(action: Json?) = turn.withLock {
        val client = app.client ?: return@withLock
        sending = true
        if (action != null && !watch.state.value.watching) status = "Sending…"
        try {
            // Live, nothing comes back but whether you have it: the stream shows what was done.
            if (watch.state.value.watching && !onMac) {
                heard(DesktopHold.of(client.post("/api/team/desktop", Json.obj("id" to id, "action" to action, "picture" to false))["held"]))
                problem = null
                return@withLock
            }
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
                if (!onMac) heard(DesktopHold.of(next["held"]))
                // (A picture that comes back while it is live isn't shown over it.)
                if (!watch.state.value.watching) status = "Seen just now · ${next["width"].int}×${next["height"].int}"
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

    // Asked again while you're watching, and only then (and not while it is live).
    LaunchedEffect(id, front) {
        if (!front) return@LaunchedEffect
        while (true) {
            if (problem == null && !noDesktop && !sending && !watch.state.value.watching) send(null)
            delay(2_000)
        }
    }
    // A VM's screen live while you're watching: the node's stream decoded onto the surface, kept by DesktopWatch (watched
    // again after an end, and given way to the picture after four in a row, or at once on a refusal).
    LaunchedEffect(id, front, surface) {
        val target = surface
        if (!front || onMac || target == null) return@LaunchedEffect
        val client = app.client ?: return@LaunchedEffect
        // Each stream's own decoder, made when it opens and let go when it ends, even when it is left (the codec is the
        // phone's). MediaCodec's calls wait on it: each frame is decoded off the main thread.
        var decoder: DesktopDecoder? = null
        watch.run(
            open = {
                decoder = DesktopDecoder(target)
                client.frames("/api/team/desktop/stream", Json.obj("id" to id))
            },
            show = { frame -> withContext(Dispatchers.Default) { decoder?.show(frame) == true } },
            ended = {
                withContext(Dispatchers.Default) { decoder?.release() }
                decoder = null
            },
            wait = { delay(it) },
            began = {
                val size = decoder?.size ?: (1280 to 800)
                liveSize = size
                problem = null
                noDesktop = false
                status = "Live · ${size.first}×${size.second}"
            },
            stopped = { status = "As it was last seen" },
        )
    }
    // Your take-over ends by itself when nothing more is done there: said once, when it does.
    LaunchedEffect(heldEnds) {
        val ends = heldEnds ?: return@LaunchedEffect
        delay((ends - System.currentTimeMillis()).toLong().coerceAtLeast(0))
        held = null
        heldEnds = null
    }
    suspend fun hold(take: Boolean) {
        val client = app.client ?: return
        try {
            heard(DesktopHold.of(client.post(if (take) "/api/team/desktop/take" else "/api/team/desktop/release", Json.obj("id" to id))["held"]))
            problem = null
        } catch (e: NodeError) {
            problem = e.message
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar("$name's screen", back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
            // What the box shows, in the screen's own pixels: the stream's last frame while it is drawn, else the picture.
            val still = picture
            val (w, h) = liveSize?.takeIf { live.drawn } ?: ((shot?.get("width").int ?: 16) to (shot?.get("height").int ?: 10))
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(w.toFloat() / h)
                    .clip(MaterialTheme.shapes.medium)
                    .background(Color(0xFF141416))
                    .pointerInput(w, h) {
                        // The box has the screen's own shape, and what it shows fills it: a tap is read against the box.
                        detectTapGestures { at ->
                            if (watch.state.value.drawn || picture != null) Desktop.point(at.x.toDouble(), at.y.toDouble(), 0.0, 0.0, size.width.toDouble(), size.height.toDouble(), w, h)?.let { act(Desktop.click(it.x, it.y)) }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                // The live screen's surface, there from the start (the stream needs it to be decoded onto), under the
                // picture until a frame is drawn on it. A surface made again starts empty: the picture until the next frame.
                if (!onMac) {
                    AndroidView(
                        factory = { context ->
                            SurfaceView(context).apply {
                                holder.addCallback(object : SurfaceHolder.Callback {
                                    override fun surfaceCreated(holder: SurfaceHolder) { surface = holder.surface }
                                    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                                    override fun surfaceDestroyed(holder: SurfaceHolder) {
                                        surface = null
                                        watch.forget()
                                    }
                                })
                            }
                        },
                        update = { view ->
                            view.contentDescription = "$name's screen, live. A tap clicks at that place on it."
                            view.importantForAccessibility = if (live.drawn) View.IMPORTANT_FOR_ACCESSIBILITY_YES else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                if (!live.drawn && still != null) {
                    Image(still, contentDescription = "$name's screen. A tap clicks at that place on it.", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                } else if (!live.drawn) {
                    Text("Looking…", color = Color(0xFFEDEDEF), style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!onMac) {
                // (There from the first frame: nothing moves when the node first says whether you have it.)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                    val line = heldEnds?.let { "You have it until ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it.toLong()))}. $name's desktop commands wait." }
                        ?: "While you have it, $name's own desktop commands wait."
                    Text(line, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    OutlinedButton(onClick = { scope.launch { hold(held == null) } }) { Text(if (held == null) "Take over" else "Give back") }
                }
            }
            when (live.givenUp) {
                DesktopWatch.GivenUp.TRIED -> "The live picture of $name's screen isn't coming through, so it is shown every two seconds instead."
                DesktopWatch.GivenUp.BEHIND -> "This phone can't keep up with $name's screen live, so it is shown every two seconds instead."
                else -> null
            }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
                val ready = shot != null || live.drawn
                for ((label, key) in Desktop.keys) OutlinedButton(onClick = { act(Desktop.key(key)) }, enabled = ready) { Text(label) }
                OutlinedButton(onClick = { act(Desktop.scroll(up = true, times = 3)) }, enabled = ready) { Text("Scroll up") }
                OutlinedButton(onClick = { act(Desktop.scroll(up = false, times = 3)) }, enabled = ready) { Text("Scroll down") }
            }
            Text(
                "What you type goes to $name's screen and nowhere else: it isn't kept here, and the ledger says only that something was typed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
