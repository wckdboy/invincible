@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.Attachments
import sh.invincible.bot.app.Bubble
import kotlinx.coroutines.delay
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Underway
import sh.invincible.bot.core.UnderwayWords
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/**
 * The primary's chat: its face and what it's doing at the top, the conversation, and a box to write in. Its answer comes in
 * as it writes it, with the steps it takes on the way under it; Stop asks the node to stop it, and leaving never does.
 * A fresh chat opens with what happened while you were away, from the node's own record (no model writes it).
 */
@Composable
fun ChatScreen(app: AppModel, back: () -> Unit, openTask: (String) -> Unit = {}) {
    val chat = app.chat
    val bubbles by chat.bubbles.collectAsState()
    val live by chat.live.collectAsState()
    val title by chat.title.collectAsState()
    val problem by chat.problem.collectAsState()
    val table by app.table.collectAsState()
    var listing by remember { mutableStateOf(false) }
    var away by remember { mutableStateOf<List<Json>>(emptyList()) }
    // A suggestion pressed: handed to the message box (counted, so the same one pressed again is handed again).
    var offered by remember { mutableStateOf<Pair<Int, String>?>(null) }
    val list = rememberLazyListState()

    LaunchedEffect(Unit) {
        away = app.away()
        if (away.isNotEmpty()) app.sawAway()
    }
    // Its answer is followed as it comes, unless you've scrolled up to read: then it stays where you are.
    val following = remember { androidx.compose.runtime.derivedStateOf { !list.canScrollForward || list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= list.layoutInfo.totalItemsCount - 2 } == true } }
    LaunchedEffect(bubbles.size) { if (bubbles.isNotEmpty()) list.toEnd() }
    LaunchedEffect(bubbles.lastOrNull()?.text?.length) { if (bubbles.isNotEmpty() && following.value) list.toEnd() }
    // (A block is drawn only once its fence closes, after the last words came: the end moves once more as it finishes.)
    LaunchedEffect(live) { if (!live && bubbles.isNotEmpty() && following.value) list.toEnd() }

    // Back from your chats returns to this chat, not past it.
    BackHandler(enabled = listing) { listing = false }
    if (listing) {
        Chats(app, close = { listing = false }, opened = { listing = false })
        return
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar(title ?: Primary.name, back) {
            TextButton(onClick = { listing = true }) { Text("Chats") }
            TextButton(onClick = { chat.fresh() }, enabled = !live) { Text("New") }
        }
        LazyColumn(Modifier.weight(1f), state = list) {
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                    // Its orb, the one in focus here: moving while it answers (before the node has said so), else still.
                    PrimaryOrb(40.dp, if (live) sh.invincible.bot.core.OrbMotion.Mood.WORKING else null, key = "primary:chat")
                    Text(table.primary.line, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            // A new conversation: what you might ask it first (the PWA's welcome's), a press puts it in the message box.
            if (bubbles.isEmpty() && !live) {
                item {
                    androidx.compose.foundation.layout.FlowRow(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2), horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                        for ((label, words) in SUGGESTIONS) {
                            androidx.compose.material3.OutlinedButton(
                                onClick = { offered = (offered?.first ?: 0) + 1 to words },
                                border = androidx.compose.foundation.BorderStroke(1.dp, LocalBrand.current.line),
                                modifier = Modifier.heightIn(min = Space.touch),
                            ) { Text(label) }
                        }
                    }
                }
            }
            if (bubbles.isEmpty() && away.isNotEmpty()) {
                item {
                    Panel {
                        Text("While you were away", style = MaterialTheme.typography.titleSmallEmphasized)
                        val brand = LocalBrand.current
                        for (line in away) {
                            val color = when (line["tone"].string) { "ok" -> brand.done; "warn" -> brand.needs; "danger" -> brand.failed; else -> MaterialTheme.colorScheme.onSurfaceVariant }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                                Dot(color)
                                Text(line["text"].string ?: "", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            // Its latest answer's choices may be tapped, once it's done: the choice goes as your reply.
            itemsIndexed(bubbles) { i, b -> Message(b, if (i == bubbles.lastIndex && !live) { choice -> chat.send(choice) } else null) }
            problem?.let { p -> item { Problem(p) } }
        }
        // What is under way in this chat: its agents' tasks given here (Stop on each), its looks that wait (Cancel).
        UnderwayBar(app, live, openTask)
        ChatComposer(app, live, offered = offered)
    }
}

/**
 * Above a chat's message box, what is under way there (your word, 24 November 2026, after OpenMausBot's hand-off rows):
 * each task it gave an agent from this chat that hasn't ended, its agent's face and how it stands, opened with a tap and
 * stopped with its own Stop; and each look it set itself here, when it comes and what at, called off with Cancel. Asked
 * of the node every few seconds while a task is under way or it is answering, just after a look of its comes due (so it
 * goes from here as it takes it), else every half minute.
 */
@Composable
private fun UnderwayBar(app: AppModel, live: Boolean, openTask: (String) -> Unit) {
    val conversation by app.chat.conversation.collectAsState()
    val table by app.table.collectAsState()
    var shown by remember { mutableStateOf(Underway()) }
    var asked by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(conversation, live, asked) {
        val id = conversation ?: run { shown = Underway(); return@LaunchedEffect }
        while (true) {
            runCatching { app.client?.post("/api/conversations/underway", Json.obj("id" to id)) }.getOrNull()?.let { shown = Underway.of(it) }
            delay(UnderwayWords.nextAskMs(shown, live))
        }
    }
    if (shown.isEmpty) return
    Panel(Modifier.padding(horizontal = Space.margin, vertical = Space.s1).semantics { contentDescription = "Under way in this chat" }) {
        for (task in shown.tasks) {
            val row = table.rows.firstOrNull { it.kind == "agent" && it.id == task.assignee }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                Row(Modifier.weight(1f).clickable { openTask(task.id) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    AgentOrb(task.assignee, row?.avatar, 28.dp, description = task.name)
                    Column(Modifier.weight(1f)) {
                        Text("${task.name} · ${UnderwayWords.state(task)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(task.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                TextButton(onClick = { scope.launch { runCatching { app.client?.post("/api/team/control", Json.obj("task" to task.id, "action" to "stop")) }; asked++ } }, modifier = Modifier.semantics { contentDescription = "Stop ${task.name}'s work on this" }) { Text("Stop") }
            }
        }
        for (look in shown.looks) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                // In the column the agents' faces take (28 dp), as the iPhone's and the web's rows have it.
                Icon(ClockIcon, null, Modifier.padding(horizontal = 4.dp).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(UnderwayWords.look(look), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { scope.launch { runCatching { app.client?.post("/api/looks/cancel", Json.obj("id" to look.id)) }; asked++ } }, modifier = Modifier.semantics { contentDescription = "It won't look again then" }) { Text("Cancel") }
            }
        }
    }
}

/**
 * The chat's message box: your words, and the files they carry (a photo, drawn again smaller and without its metadata;
 * a text file), sent up to the node first and named by the message. While it answers it is Stop. [offered] puts words
 * in it (a suggestion pressed, counted so the same one pressed again does it again); [sent] is told once a message has
 * gone (the primary's home then shows the chat it began).
 */
@Composable
internal fun ChatComposer(app: AppModel, live: Boolean, offered: Pair<Int, String>? = null, sent: (() -> Unit)? = null) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var files by remember { mutableStateOf<List<Attachments.Prepared>>(emptyList()) }
    var said by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val brand = LocalBrand.current
    fun add(read: suspend () -> Attachments.Prepared) = scope.launch {
        if (files.size >= Attachments.PER_MESSAGE) {
            said = "A message carries ${Attachments.PER_MESSAGE} files at most."
            return@launch
        }
        try {
            files = files + read()
            said = null
        } catch (e: Attachments.Refused) {
            said = e.message
        }
    }
    fun addPhoto(uri: android.net.Uri): kotlinx.coroutines.Job {
        val photos = files.count { it.type.startsWith("image/") }
        return add { Attachments.picture(context, uri, if (photos == 0) "Photo" else "Photo ${photos + 1}") }
    }
    val photo = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let(::addPhoto) }
    // What another app shared: its words in the box, unsent; its pictures attached, drawn again as a photo is.
    val shared by app.shared.collectAsState()
    LaunchedEffect(shared) {
        val s = shared ?: return@LaunchedEffect
        app.shared.value = null
        s.words?.let { text = if (text.isBlank()) it else "$text\n\n$it" }
        for (picture in s.pictures) {
            addPhoto(picture).join()
        }
    }
    val textFile = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri -> uri?.let { u -> add { Attachments.text(context, u) } } }
    LaunchedEffect(offered) { offered?.let { text = it.second } }
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
        if (files.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(androidx.compose.foundation.rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                for (f in files) {
                    // (A button, not an input chip: that one reads to a screen reader as a checkbox, unchecked.)
                    androidx.compose.material3.AssistChip(
                        onClick = { files = files - f },
                        label = { Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        trailingIcon = { Icon(CloseIcon, null, Modifier.size(AssistChipDefaults.IconSize)) },
                        modifier = Modifier.semantics { contentDescription = "Remove ${f.name}" },
                    )
                }
            }
        }
        said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
        // As the iPhone's: a paperclip, a rounded field that grows to six lines, and a round send, or stop while it answers.
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.s1)) {
            androidx.compose.foundation.layout.Box(Modifier.padding(bottom = 4.dp)) {
                androidx.compose.material3.IconButton(onClick = { menu = true }, enabled = !live && !sending) { Icon(AttachIcon, contentDescription = "Attach") }
                androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    androidx.compose.material3.DropdownMenuItem(text = { Text("A photo") }, onClick = {
                        menu = false
                        photo.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
                    })
                    androidx.compose.material3.DropdownMenuItem(text = { Text("A text file") }, onClick = {
                        menu = false
                        textFile.launch("text/*")
                    })
                }
            }
            androidx.compose.material3.TextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text("Message ${Primary.name}") },
                maxLines = 6,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
                colors = androidx.compose.material3.TextFieldDefaults.colors(
                    focusedContainerColor = brand.raised, unfocusedContainerColor = brand.raised, disabledContainerColor = brand.raised,
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    disabledIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
                modifier = Modifier.weight(1f),
            )
            if (live) {
                androidx.compose.material3.FilledTonalIconButton(onClick = app.chat::stop, modifier = Modifier.padding(bottom = 4.dp)) {
                    Icon(StopIcon, contentDescription = "Stop ${Primary.name} answering")
                }
            } else {
                androidx.compose.material3.FilledIconButton(
                    enabled = (text.isNotBlank() || files.isNotEmpty()) && !sending,
                    modifier = Modifier.padding(bottom = 4.dp),
                    onClick = {
                        val client = app.client ?: return@FilledIconButton
                        sending = true
                        scope.launch {
                            try {
                                val refs = files.map { Attachments.upload(client, it) }
                                app.chat.send(text, refs)
                                text = ""
                                files = emptyList()
                                said = null
                                sent?.invoke()
                            } catch (e: sh.invincible.bot.core.NodeError) {
                                said = e.message
                            } catch (e: Attachments.Refused) {
                                said = e.message
                            } finally {
                                sending = false
                            }
                        }
                    },
                ) { Icon(SendIcon, contentDescription = if (sending) "Sending" else "Send") }
            }
        }
    }
}

@Composable
private fun Message(b: Bubble, choose: ((String) -> Unit)?) {
    val brand = LocalBrand.current
    // A look of its come back: its own note, never shown as yours.
    b.look?.let { look ->
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), horizontalArrangement = Arrangement.spacedBy(Space.s1, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            Icon(ClockIcon, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(UnderwayWords.looked(look), Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        return
    }
    if (b.mine) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), horizontalArrangement = Arrangement.End) {
            Column(Modifier.widthIn(max = 320.dp).clip(MaterialTheme.shapes.large).background(brand.ink).padding(horizontal = Space.s3, vertical = Space.s2)) {
                if (b.text.isNotEmpty()) Text(b.text, color = brand.onInk, style = MaterialTheme.typography.bodyLarge)
                for (f in b.files) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Icon(AttachIcon, null, Modifier.size(16.dp), tint = brand.onInk.copy(alpha = 0.8f))
                        Text(f, color = brand.onInk.copy(alpha = 0.8f), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
        if (b.text.isNotEmpty()) Markdown(b.text, choose = choose)
        for (step in b.steps.takeLast(4)) Text("· $step", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // Work under way is a word beside a live dot in its colour, its light going out, never a spinner.
        if (b.streaming) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Dot(brand.working, live = true)
            Text(if (b.text.isEmpty()) "Thinking" else "Writing", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        b.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
        if (b.status == "stopped" && b.error == null) Text("Stopped", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** What you might ask it first (the PWA's welcome's, the iPhone's): a press puts it in the message box, to send or change. */
private val SUGGESTIONS = listOf(
    "Catch me up" to "What has my fleet been doing today, and does anything need me?",
    "Plan" to "Plan this week's work on Invincible as a short, ordered list.",
    "Recall" to "What do we remember about how the fleet is deployed?",
    "Place" to "Which of my machines should run a long build, and why?",
)

/** Your kept chats, the latest first: one opens where it was ([opened]), and its answer still being written goes on there. */
@Composable
internal fun Chats(app: AppModel, close: () -> Unit, opened: () -> Unit) {
    val chats by app.chat.chats.collectAsState()
    LaunchedEffect(Unit) { app.chat.loadChats() }
    val brand = LocalBrand.current
    Column(Modifier.fillMaxSize()) {
        PageBar("Chats", close)
        LazyColumn(Modifier.weight(1f)) {
            items(chats, key = { it["id"].string ?: "" }) { c ->
                val state = c["state"].string
                Row(
                    Modifier.fillMaxWidth().clickable { c["id"].string?.let(app.chat::open); opened() }.padding(horizontal = Space.margin, vertical = Space.s3),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.s2),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(c["title"].string ?: "A chat", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        state?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (it == "working") brand.working else MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    if (c["unread"].bool == true) Dot(brand.done)
                    if (state == "working") Dot(brand.working, live = true)
                }
            }
        }
    }
}

/** To the very end of what's there: the foot of the last item, however tall (an answer is one item). */
suspend fun androidx.compose.foundation.lazy.LazyListState.toEnd() = scrollToItem(maxOf(0, layoutInfo.totalItemsCount - 1), Int.MAX_VALUE / 2)
