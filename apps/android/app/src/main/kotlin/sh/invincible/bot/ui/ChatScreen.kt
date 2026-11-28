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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
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
import sh.invincible.bot.core.ChatList
import sh.invincible.bot.core.Underway
import sh.invincible.bot.core.UnderwayWords
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary
import androidx.compose.ui.text.withStyle

/**
 * The primary's chat: its face and what it's doing at the top, the conversation, and a box to write in. Its answer comes in
 * as it writes it, with the steps it takes on the way under it; Stop asks the node to stop it, and leaving never does.
 * A fresh chat opens with what happened while you were away, from the node's own record (no model writes it).
 */
@Composable
fun ChatScreen(app: AppModel, back: () -> Unit, roster: (() -> Unit)? = null, root: Boolean = false, openTask: (String) -> Unit = {}, give: (() -> Unit)? = null) {
    val chat = app.chat
    val bubbles by chat.bubbles.collectAsState()
    val live by chat.live.collectAsState()
    val opening by chat.opening.collectAsState()
    // The app opens on your latest kept chat (ChatModel.openLatest), saying it is reading it, never its welcome first.
    LaunchedEffect(root) { if (root) chat.openLatest() }
    val title by chat.title.collectAsState()
    val problem by chat.problem.collectAsState()
    val table by app.table.collectAsState()
    var listing by remember { mutableStateOf(false) }
    var away by remember { mutableStateOf<List<Json>>(emptyList()) }
    // A suggestion pressed: handed to the message box (counted, so the same one pressed again is handed again).
    var offered by remember { mutableStateOf<Pair<Int, String>?>(null) }
    val list = rememberLazyListState()
    val times = rememberListTime()
    val minute = rememberMinute()
    val marks = remember(bubbles, times) { ChatList.timeMarks(bubbles.map { it.at }, times.zone).toSet() }

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
        // Almost no chrome (the owner's word, 27 November 2026): at the root its top-left opens the roster (a phone's drawer;
        // a wide screen has it beside), elsewhere it goes back; its name; and one menu, a new chat and your chats.
        // (A phone's way to the roster: a back arrow that counts what needs you, as Messages' counts what is unread.)
        val needs by app.needsYou.collectAsState()
        val lead: (@Composable () -> Unit)? = when {
            !root -> null
            roster != null -> ({ RosterBack(needs, roster) })
            else -> ({})
        }
        PageBar(title ?: Primary.name, back, navigation = lead) {
            var options by remember { mutableStateOf(false) }
            androidx.compose.foundation.layout.Box {
                androidx.compose.material3.IconButton(onClick = { options = true }) { Icon(MoreIcon, contentDescription = "Chat options") }
                androidx.compose.material3.DropdownMenu(expanded = options, onDismissRequest = { options = false }) {
                    // (One menu: a new chat, a task to give, every chat, a side question.)
                    androidx.compose.material3.DropdownMenuItem(text = { Text("New chat") }, enabled = !live, onClick = { options = false; chat.fresh() })
                    give?.let { g -> androidx.compose.material3.DropdownMenuItem(text = { Text("Give a task") }, onClick = { options = false; g() }) }
                    androidx.compose.material3.DropdownMenuItem(text = { Text("Chats") }, onClick = { options = false; listing = true })
                    androidx.compose.material3.DropdownMenuItem(text = { Text("Ask on the side") }, onClick = { options = false; chat.askAside("") })
                }
            }
        }
        // While this phone's node is refused, the chat, where the app opens, says so above the conversation, whatever is
        // scrolled to: the refusal, Try again, Forget this node, as Work and the agents do at their heads.
        val nodeProblem by app.problem.collectAsState()
        sh.invincible.bot.core.refusalShown(nodeProblem)?.let { Refused(app, it) }
        // A new conversation's welcome, and your kept chats it lists (read as it shows).
        val welcome = bubbles.isEmpty() && !live && !opening
        val kept by chat.chats.collectAsState()
        LaunchedEffect(welcome) { if (welcome) chat.loadChats() }
        LazyColumn(Modifier.weight(1f), state = list) {
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                    // The primary, the I-beam in ink (still: its line says what it is doing).
                    PrimaryMark(40.dp)
                    Text(table.primary.line, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            // A new conversation: the welcome, as the web's (Welcome.kt): your agent's mark, large, and what it does; what you
            // might ask it first, a press puts it in the message box; your recent chats and All chats.
            // (Its latest kept chat being read: said so, in place of the welcome, which would only be replaced.)
            if (opening && bubbles.isEmpty()) item { Text("Reading your latest chat…", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2)) }
            if (welcome) {
                item(key = "welcome") { WelcomeHero() }
                item(key = "asks") { WelcomeAsks(SUGGESTIONS) { words -> offered = (offered?.first ?: 0) + 1 to words } }
                item(key = "recent") { RecentChatsList(kept, open = { chat.open(it) }, all = { listing = true }) }
            }
            // (What needs your answer is counted once: the head above says it, live, so the card leaves its own count out.)
            val awayShown = sh.invincible.bot.core.Away.shown(away, countShown = table.primary.tone == "warn")
            if (bubbles.isEmpty() && awayShown.isNotEmpty() && !opening) {
                item {
                    Panel {
                        Text("While you were away", style = MaterialTheme.typography.titleSmallEmphasized)
                        val brand = LocalBrand.current
                        for (line in awayShown) {
                            val color = when (line["tone"].string) { "ok" -> brand.done; "warn" -> brand.needs; "danger" -> brand.failed; else -> MaterialTheme.colorScheme.onSurfaceVariant }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                                Dot(color)
                                Text(line["text"].string ?: "", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            // Its latest answer's choices may be tapped, once it's done: the choice goes as your reply. When it went on is said
            // small and centred over the message it went on with (ChatList.timeMarks, the PWA's).
            itemsIndexed(bubbles) { i, b ->
                if (i in marks) b.at?.let { TimeMark(times.mark(it, minute * 60_000)) }
                Message(b, if (i == bubbles.lastIndex && !live) { choice -> chat.send(choice) } else null)
            }
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
/**
 * A phone's way to the roster from the chat it opens on (the iPhone's, as Messages' back counts what is unread): a back
 * arrow, with how many things need you beside it. A swipe from the left edge opens the roster too.
 */
@Composable
private fun RosterBack(needs: Int, open: () -> Unit) {
    Row(
        Modifier
            .padding(start = Space.s1)
            .heightIn(min = Space.touch)
            .clip(androidx.compose.foundation.shape.CircleShape)
            .clickable(onClick = open)
            .semantics(mergeDescendants = true) {
                role = androidx.compose.ui.semantics.Role.Button
                contentDescription = if (needs > 0) "Your agents: $needs need you" else "Your agents"
            }
            .padding(horizontal = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Icon(BackIcon, contentDescription = null)
        if (needs > 0) Text("$needs", style = Type.word)
    }
}

@Composable
private fun UnderwayBar(app: AppModel, live: Boolean, openTask: (String) -> Unit) {
    val conversation by app.chat.conversation.collectAsState()
    val table by app.table.collectAsState()
    val online by app.online.collectAsState()
    var shown by remember { mutableStateOf(Underway()) }
    var asked by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    suspend fun ask(): Boolean {
        val id = conversation ?: return false
        val got = runCatching { app.client?.post("/api/conversations/underway", Json.obj("id" to id)) }.getOrNull() ?: return false
        shown = Underway.of(got)
        return true
    }
    // Asked as the chat opens (and when a look is called off here); then as the live stream says the team or the chats
    // moved (a task moved on, a look set, taken or come due), as the web's under way is: nothing on a timer while the
    // stream is open.
    LaunchedEffect(conversation, asked) {
        if (conversation == null) shown = Underway() else ask()
    }
    FollowTopics(app, listOf("team", "turns"), conversation, everyMs = null, gapMs = 2_000) { ask() }
    // While the stream is down: on its own time, as before there was a stream.
    LaunchedEffect(conversation, live, online) {
        if (online != false || conversation == null) return@LaunchedEffect
        while (true) {
            delay(UnderwayWords.nextAskMs(shown, live))
            ask()
        }
    }
    if (shown.isEmpty) return
    Panel(Modifier.padding(horizontal = Space.margin, vertical = Space.s1).semantics { contentDescription = "Under way in this chat" }) {
        for (task in shown.tasks) {
            val row = table.rows.firstOrNull { it.kind == "agent" && it.id == task.assignee }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                Row(Modifier.weight(1f).clickable { openTask(task.id) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    AgentMarkView(task.assignee, row?.avatar, 28.dp, description = task.name)
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
    // Words that didn't reach it, or weren't sent while it worked: back in the box.
    val returned by app.chat.returned.collectAsState()
    LaunchedEffect(returned) {
        val back = returned ?: return@LaunchedEffect
        text = if (text.isBlank()) back else "$text\n\n$back"
        app.chat.returnedTaken()
    }
    // While it works the box stays open: Return (the send) steers it, Queue keeps the words for after this turn, and
    // "/btw …" asks on the side (the web's sendMessage, the vectors' composer).
    fun steerOrQueue(how: sh.invincible.bot.core.Composer.Action) {
        sh.invincible.bot.core.Composer.aside(text)?.let { question ->
            app.chat.askAside(question)
            text = ""
            return
        }
        if (files.isNotEmpty()) {
            said = sh.invincible.bot.core.Composer.FILES_WAIT
            return
        }
        if (app.chat.deliver(how, text)) text = ""
    }
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
        QueuePanel(app)
        // One big box (the owner's word, 27 November 2026, as the iPhone's and the web's): the words across all of it, and
        // under them the paperclip on the left and what sends on the right: Send, or while it answers Queue, Steer and Stop.
        val focus = remember { androidx.compose.ui.focus.FocusRequester() }
        fun send() {
            val client = app.client ?: return
            if ((text.isBlank() && files.isEmpty()) || sending) return
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
        }
        val written = text.isNotBlank()
        val aside = sh.invincible.bot.core.Composer.aside(text) != null
        ComposerBox(
            focus = focus,
            field = {
                ComposerField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = if (live) sh.invincible.bot.core.Composer.placeholder(app.chat.canQueue) else "Ask your agent…",
                    focus = focus,
                    enter = { if (live) steerOrQueue(sh.invincible.bot.core.Composer.Action.STEER) else send() },
                )
            },
            leading = {
                androidx.compose.foundation.layout.Box {
                    androidx.compose.material3.IconButton(onClick = { menu = true }, enabled = !sending) { Icon(AttachIcon, contentDescription = "Attach, or ask on the side") }
                    androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("A photo") }, onClick = {
                            menu = false
                            photo.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
                        })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("A text file") }, onClick = {
                            menu = false
                            textFile.launch("text/*")
                        })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Ask on the side") }, onClick = {
                            menu = false
                            app.chat.askAside("")
                        })
                    }
                }
            },
            trailing = {
                if (live) {
                    // Queue (for after this turn) and Steer (now, at its next safe point), in words, then Stop.
                    if (app.chat.canQueue && !aside) ComposerChoice("Queue", filled = false, ready = written) { steerOrQueue(sh.invincible.bot.core.Composer.Action.QUEUE) }
                    ComposerChoice(if (aside) "Ask on the side" else "Steer", filled = true, ready = written) { steerOrQueue(sh.invincible.bot.core.Composer.Action.STEER) }
                    ComposerDisc(StopIcon, "Stop ${Primary.name} answering", ready = true, onClick = app.chat::stop)
                } else {
                    ComposerDisc(SendIcon, if (sending) "Sending" else "Send", ready = (written || files.isNotEmpty()) && !sending, onClick = ::send)
                }
            },
        )
    }
}

/**
 * What waits above the message box while it works (the web's chat-queue.ts, in its words: Composer): what became of
 * something you sent, steers on their way to it, and what you queued behind the chat, each with Send now, Edit and
 * Remove; a held queue says why, with Resume and Discard. And a side question, asked apart, with Bring back.
 */
@Composable
private fun QueuePanel(app: AppModel) {
    val chat = app.chat
    val notice by chat.notice.collectAsState()
    val steering by chat.steering.collectAsState()
    val queue by chat.queue.collectAsState()
    val held by chat.held.collectAsState()
    val live by chat.live.collectAsState()
    val aside by chat.aside.collectAsState()
    val brand = LocalBrand.current
    var editing by remember { mutableStateOf<sh.invincible.bot.app.ChatModel.Queued?>(null) }
    var edited by remember { mutableStateOf("") }
    if (notice != null || steering.isNotEmpty() || queue.isNotEmpty()) {
        Column(Modifier.fillMaxWidth().padding(vertical = Space.s1), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            notice?.let { (title, detail) ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    Column(Modifier.weight(1f)) {
                        Text(title, style = Type.word)
                        if (detail.isNotEmpty()) Text(detail, style = Type.meta, color = brand.quiet)
                    }
                    TextButton(onClick = chat::dismissNotice) { Text("OK") }
                }
            }
            if (steering.isNotEmpty()) {
                Text(sh.invincible.bot.core.Composer.steering(steering.size), style = Type.word)
                for (t in steering) Text(t, style = Type.meta, color = brand.quiet, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (queue.isNotEmpty()) {
                val (count, rest) = sh.invincible.bot.core.Composer.queueHead(queue.size, held, live)
                Text(androidx.compose.ui.text.buildAnnotatedString {
                    withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)) { append(count) }
                    append(rest)
                }, style = Type.meta)
                if (held != null) Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    AnswerPill("Resume", chat::resumeQueue)
                    TextButton(onClick = chat::discardQueue) { Text("Discard", color = brand.danger) }
                }
                for (q in queue) {
                    Column(Modifier.padding(start = Space.s3)) {
                        Text(q.text + (q.by?.let { " · from $it" } ?: ""), style = Type.meta, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.s1)) {
                            TextButton(onClick = { chat.sendQueued(q.id) }) { Text("Send now") }
                            TextButton(onClick = { edited = q.text; editing = q }) { Text("Edit") }
                            TextButton(onClick = { chat.removeQueued(q.id) }) { Text("Remove") }
                        }
                    }
                }
            }
        }
    }
    editing?.let { q ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit the queued message") },
            text = { androidx.compose.material3.OutlinedTextField(value = edited, onValueChange = { edited = it }, maxLines = 6) },
            confirmButton = { TextButton(enabled = edited.isNotBlank(), onClick = { chat.editQueued(q.id, edited); editing = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
    aside?.let { a -> AsideSheet(app, a, working = live) }
}

/** Ask on the side (the web's chat-aside.ts): the question, its answer apart from the chat as it comes, and Bring back. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AsideSheet(app: AppModel, a: sh.invincible.bot.app.ChatModel.Aside, working: Boolean) {
    val brand = LocalBrand.current
    var question by remember(a.question) { mutableStateOf(a.question) }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = app.chat::closeAside, containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.margin).padding(bottom = Space.s6), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
            Text("Ask on the side", style = Type.title)
            Text(sh.invincible.bot.core.Composer.asideNote(working), style = Type.meta, color = brand.quiet)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                androidx.compose.material3.OutlinedTextField(
                    value = question,
                    onValueChange = { question = it },
                    placeholder = { Text(sh.invincible.bot.core.Composer.asidePlaceholder(working)) },
                    maxLines = 6,
                    modifier = Modifier.weight(1f),
                )
                AnswerPill("Ask", { app.chat.askAside(question) }, enabled = question.isNotBlank() && !(a.asking && a.question.isNotEmpty()))
            }
            if (a.asking && a.question.isNotEmpty() && a.answer.isEmpty()) Text(sh.invincible.bot.core.Composer.ASIDE_ANSWERING, style = Type.meta, color = brand.quiet)
            if (a.answer.isNotEmpty()) Markdown(a.answer)
            a.problem?.let { Text(it, style = Type.meta, color = brand.danger) }
            if (a.id != null && a.answer.isNotEmpty() && !a.asking) AnswerPill("Bring back", app.chat::bringBack)
        }
    }
}

/** When a chat went on, small and centred over the message it went on with (as Grok Bot's chats say it). */
@Composable
internal fun TimeMark(words: String) {
    Text(
        words,
        Modifier.fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s3, bottom = Space.s1),
        style = Type.meta,
        color = LocalBrand.current.quiet,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
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

/**
 * Your kept chats, as the web's "Your chats" (views/chat.ts openHistory): where they are kept; a search, every word of it in
 * a chat's title (ChatList.filter); the chats by day, the latest first (ChatList.groups: Pinned, Today, Yesterday, This
 * week, Earlier), each a chat's row (ChatRow). One opens where it was ([opened]), and its answer still being written goes on
 * there.
 */
@Composable
internal fun Chats(app: AppModel, close: () -> Unit, opened: () -> Unit) {
    val chats by app.chat.chats.collectAsState()
    val paired by app.paired.collectAsState()
    LaunchedEffect(Unit) { app.chat.loadChats() }
    val brand = LocalBrand.current
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    var query by rememberSaveable { mutableStateOf("") }
    val now = remember(chats) { System.currentTimeMillis() }
    val groups = sh.invincible.bot.core.ChatList.groups(sh.invincible.bot.core.ChatList.filter(chats, query), now)
    Column(Modifier.fillMaxSize()) {
        PageBar("Your chats", close)
        LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s6)) {
            item(key = "where") {
                Text(
                    "Kept privately on ${paired?.nodeName ?: paired?.fleetName ?: "your node"}. Temporary chats aren't kept.",
                    style = Type.meta,
                    color = quiet,
                    modifier = Modifier.padding(horizontal = Space.margin),
                )
            }
            item(key = "search") {
                androidx.compose.material3.OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Search your chats") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s3),
                )
            }
            for (g in groups) {
                item(key = "head:${g.label}") { Text(g.label, style = Type.meta, color = quiet, modifier = Modifier.padding(horizontal = Space.margin).padding(top = Space.s3, bottom = Space.s1)) }
                item(key = "rows:${g.label}") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = Space.margin).clip(MaterialTheme.shapes.medium).background(brand.raised)) {
                        g.items.forEachIndexed { i, c ->
                            if (i > 0) Hairline(inset = Space.s3)
                            ChatRow(c, now) { id -> app.chat.open(id); opened() }
                        }
                    }
                }
            }
        }
    }
}

/** To the very end of what's there: the foot of the last item, however tall (an answer is one item). */
suspend fun androidx.compose.foundation.lazy.LazyListState.toEnd() = scrollToItem(maxOf(0, layoutInfo.totalItemsCount - 1), Int.MAX_VALUE / 2)
