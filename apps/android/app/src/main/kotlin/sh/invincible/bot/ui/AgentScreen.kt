@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.Icon
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.ChatList
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Steps
import sh.invincible.bot.core.TeamTask
import sh.invincible.bot.core.TaskWords
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.AgentMark

/** A line of an agent's timeline: something said, or a task as it stands. */
private data class Entry(val at: Long, val key: String, val speaker: String?, val mine: Boolean, val text: String, val task: Json?, val speakerId: String? = null)

/**
 * An agent's page: its face and state, then its timeline (what you and it said, and its tasks as they stand, oldest
 * first), and a box to write to it or to give it a task. Opening it is looking, so what ended here is no longer new.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(app: AppModel, id: String, back: () -> Unit, openTask: (String) -> Unit = {}, go: (String) -> Unit = {}) {
    val table by app.table.collectAsState()
    val row = table.rows.firstOrNull { it.kind == "agent" && it.id == id }
    val person = table.snapshot?.agents?.firstOrNull { it.id == id }
    // Its VM: its screen, watched and taken over, or a terminal in it; Back returns here.
    var watching by rememberSaveable(id) { mutableStateOf(false) }
    var inTerminal by rememberSaveable(id) { mutableStateOf(false) }
    var vmMenu by remember { mutableStateOf(false) }
    var colouring by remember(id) { mutableStateOf(false) }
    var about by rememberSaveable(id) { mutableStateOf(false) }
    BackHandler(enabled = watching) { watching = false }
    if (watching) {
        DesktopScreen(app, id, person?.name ?: id) { watching = false }
        return
    }
    val sandbox = person?.workspace?.get("id").string
    if (inTerminal && sandbox != null) {
        TerminalScreen(app, sandbox, person?.name ?: id) { inTerminal = false }
        return
    }
    Timeline(
        app,
        key = "agent:$id",
        roomOf = { c -> c.post("/api/team/direct", Json.obj("id" to id))["room"].let { it.string ?: it["id"].string } },
        seen = Json.obj("agent" to id),
        assignee = id,
        placeholder = "Ask ${person?.name ?: id}",
        taskPlaceholder = "Give ${person?.name ?: id} a task",
        title = person?.name ?: id,
        back = back,
        openTask = openTask,
        // Its face and its name in a pill, as Grok Bot's (the owner's word, 28 November 2026): a tap opens what it is. What
        // it is doing, or its role where it does nothing, is said with its name.
        barTitle = {
            val line = row?.let { Roster.besideChip(it.line, it.state) }?.takeIf { it.isNotBlank() } ?: person?.role
            ChatPill(person?.name ?: id, line = listOfNotNull(row?.state?.words, line).joinToString(", "), open = { about = true }) {
                AgentMarkView(id, person?.avatar ?: row?.avatar, 24.dp, state = AgentMark.state(row?.state), live = true, knock = table.knocks[id] ?: 0, dot = false)
            }
        },
        barAlways = true,
        // What it asks of you, answered in its own chat: each approval a message in the flow, its answers under it.
        needs = { rememberWork(app)?.let { work -> NeedsYou(app, work, openTask = openTask, openAll = { go("chat") }, watch = { go("mac:$it") }, openConnectors = { go("connectors") }, chat = id, flow = true) } },
        // Its VM, in its menu, as the iPhone offers it: one without a desktop says so (the node's refusal) and how to get one.
        actions = {
            if (sandbox != null && app.can("sandbox")) {
                androidx.compose.foundation.layout.Box {
                    androidx.compose.material3.IconButton(onClick = { vmMenu = true }) { Icon(MoreIcon, contentDescription = "${person?.name ?: id}'s options") }
                    androidx.compose.material3.DropdownMenu(expanded = vmMenu, onDismissRequest = { vmMenu = false }) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Its screen") }, onClick = { vmMenu = false; watching = true })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Its terminal") }, onClick = { vmMenu = false; inTerminal = true })
                    }
                }
            }
        },
    ) {
        // (No head on the page, as the web's and the iPhone's: the bar says the agent, and a tap on it what it is.)
    }
    if (about) {
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { about = false }, containerColor = MaterialTheme.colorScheme.surface) {
            val scope = rememberCoroutineScope()
            Column(
                Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.margin).padding(bottom = Space.s4),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Space.s2),
            ) {
                // Its glass, its dot saying how it stands: the one in focus, so its light breathes while it works.
                AgentMarkView(id, person?.avatar, 96.dp, state = AgentMark.state(row?.state), description = person?.name, live = true)
                Text(person?.name ?: id, style = MaterialTheme.typography.headlineSmallEmphasized)
                StateChip(row?.state)
                row?.let { Text(Roster.besideChip(it.line, it.state), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                person?.let { p ->
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                        // Paused, an agent starts nothing new until you resume it; what it's doing now finishes.
                        TextButton(onClick = {
                            scope.launch { runCatching { app.client?.post("/api/team/control", Json.obj("agent" to id, "action" to if (p.enabled) "pause" else "resume")); app.refresh() } }
                        }) { Text(if (p.enabled) "Pause ${p.name}" else "Resume ${p.name}") }
                        // Its glass, chosen once the node has answered (never from the agents this phone kept).
                        if (table.asOf == null) TextButton(onClick = { about = false; colouring = true }) { Text("Its glass") }
                    }
                }
            }
        }
    }
    if (colouring) person?.let { p -> GlassDialog(app, id, p.name, p.avatar) { colouring = false } }
}

/** A room's page: who sits in it, what was said there and its tasks, and a box to write to them all. */
@Composable
fun RoomScreen(app: AppModel, id: String, back: () -> Unit, openTask: (String) -> Unit = {}) {
    val table by app.table.collectAsState()
    val row = table.rows.firstOrNull { it.kind == "room" && it.id == id }
    val room = table.snapshot?.rooms?.firstOrNull { it.id == id }
    val members = room?.members?.mapNotNull { m -> table.snapshot?.agents?.firstOrNull { it.id == m } } ?: emptyList()
    Timeline(
        app,
        key = "room:$id",
        roomOf = { id },
        seen = Json.obj("room" to id),
        assignee = null,
        placeholder = "Write to ${room?.name ?: "the room"}",
        title = room?.name ?: "A room",
        back = back,
        openTask = openTask,
        // (Its name in a pill, as an agent's is, with what it is doing; who sits in it heads the page below.)
        barTitle = { ChatPill(room?.name ?: "A room", line = row?.line, open = null) { RoomFace(24.dp) } },
        barAlways = true,
    ) {
        Column(Modifier.fillMaxWidth().padding(Space.margin), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.s2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(-Space.s3)) {
                for (m in members.take(5)) AgentMarkView(m.id, m.avatar, 56.dp, description = m.name)
            }
            Text(room?.name ?: "A room", style = MaterialTheme.typography.headlineSmallEmphasized)
            row?.let { Text(it.line, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * A conversation's timeline under its [header], oldest first, read again every four seconds while it's open (two while
 * work runs there), and a box to write in; [assignee] offers the same words as a task for that agent instead. The bar
 * above names it ([title], or [barTitle] where the page draws more than words) once the header has scrolled out of sight,
 * or always ([barAlways]: a page with no head of its own, an agent's).
 */
@Composable
private fun Timeline(
    app: AppModel,
    key: String,
    roomOf: suspend (sh.invincible.bot.core.NodeClient) -> String?,
    seen: Json,
    assignee: String?,
    placeholder: String,
    taskPlaceholder: String? = null,
    title: String,
    back: () -> Unit,
    openTask: (String) -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    barTitle: (@Composable () -> Unit)? = null,
    barAlways: Boolean = false,
    needs: (@Composable () -> Unit)? = null,
    header: @Composable () -> Unit,
) {
    val table by app.table.collectAsState()
    var room by remember(key) { mutableStateOf<String?>(null) }
    var entries by remember(key) { mutableStateOf<List<Entry>>(emptyList()) }
    var problem by remember(key) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val names = table.snapshot?.agents?.associate { it.id to it.name } ?: emptyMap()

    suspend fun read(): Boolean {
        val c = app.client ?: return false
        return try {
            val r = room ?: roomOf(c).also { room = it } ?: return false
            val view = c.post("/api/team/room", Json.obj("id" to r))
            val said = view["messages"].list.map { m ->
                val speaker = m["speaker"].string ?: ""
                val who = when (speaker) { "owner" -> null; "primary" -> Primary.name; "system" -> "The agents"; else -> m["speakerName"].string ?: names[speaker] ?: speaker }
                Entry(m["createdAt"].long ?: 0, "m:${m["id"].string ?: m["createdAt"].long}", who, speaker == "owner", m["text"].string ?: "", null, speaker)
            }
            val tasks = view["tasks"].list.filter { assignee == null || it["assignee"].string == assignee }.map { t -> Entry(t["createdAt"].long ?: t["updatedAt"].long ?: 0, "t:${t["id"].string}", null, false, "", t) }
            entries = (said + tasks).sortedBy { it.at }
            problem = null
            true
        } catch (e: NodeError) {
            problem = e.message
            false
        }
    }

    // Read as it opens; then again as the live stream says the team moved (what was said, its tasks), as the web's room
    // follows it: no oftener than every two seconds, and on a timer only while the stream is down.
    LaunchedEffect(key) {
        runCatching { app.client?.post("/api/team/seen", seen) }
        read()
    }
    FollowTopics(app, listOf("team"), key, everyMs = 2_000, gapMs = 2_000) { read() }
    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty()) list.toEnd()
        // (For the performance runner: what was said here, as many as are shown.)
        sh.invincible.bot.app.PerfProbe.mark("said ${entries.size}")
    }

    val headerGone by remember { derivedStateOf { list.firstVisibleItemIndex > 0 } }
    val agents = table.snapshot?.agents ?: emptyList()
    val times = rememberListTime()
    val minute = rememberMinute()
    val marks = remember(entries, times) { ChatList.timeMarks(entries.map { e -> e.at.takeIf { it > 0 } }, times.zone).toSet() }
    Column(Modifier.fillMaxSize().imePadding()) {
        val named = headerGone || barAlways
        PageBar(if (named) title else "", back, actions = actions, titleContent = if (named) barTitle else null)
        // Every item it lists, each by its key, made in one place (TimelineItem.of: ChatItemsTest holds every key once).
        val shown = TimelineItem.of(entries.map { it.key }, problem = problem != null, needs = needs != null)
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s4)) {
            items(shown, key = { it.key }) { item ->
                when (item) {
                    TimelineItem.Header -> header()
                    TimelineItem.Problem -> problem?.let { Problem(it) }
                    // When it went on, small and centred over what went on with it (ChatList.timeMarks, the PWA's).
                    is TimelineItem.Entry -> {
                        val i = item.index
                        val e = entries[i]
                        if (i in marks) TimeMark(times.mark(e.at, minute * 60_000))
                        if (e.task != null) TaskCard(app, e.task, openTask) else Said(e, face = { SpeakerFace(e.speakerId, agents) }, named = assignee == null)
                    }
                    // What it asks of you: in the flow after its words, never pinned over the box.
                    TimelineItem.Needs -> needs?.invoke()
                }
            }
        }
        Composer(
            placeholder = placeholder,
            asTask = if (assignee != null) "Give it as a task" else null,
            taskPlaceholder = taskPlaceholder,
            sending = false,
            onSend = { text, task ->
                val r = room ?: return@Composer
                scope.launch {
                    try {
                        if (task && assignee != null) {
                            val title = text.lineSequence().first().take(200)
                            app.client?.post("/api/team/tasks", Json.obj("room" to r, "assignee" to assignee, "title" to title, "goal" to text))
                        } else {
                            app.client?.post("/api/team/messages", Json.obj("room" to r, "text" to text))
                        }
                        read()
                        app.refresh()
                    } catch (e: NodeError) {
                        problem = e.message
                    }
                }
            },
        )
    }
}

/**
 * What was said in a conversation: yours in an ink bubble; theirs in a quiet grey one beside their face, their name over it
 * in a room ([named]); what the agents' own system said (someone joined, work handed over), one muted centred line.
 */
@Composable
private fun Said(e: Entry, face: @Composable () -> Unit, named: Boolean) {
    val brand = LocalBrand.current
    if (e.speakerId == "system") {
        Text(e.text, Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        return
    }
    if (!e.mine) {
        TheirBubble(face = face, name = if (named) e.speaker else null) { Markdown(e.text) }
        return
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), horizontalArrangement = Arrangement.End) {
        Text(
            e.text,
            color = brand.onInk,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.widthIn(max = 320.dp).clip(MaterialTheme.shapes.large).background(brand.ink).padding(horizontal = Space.s3, vertical = Space.s2),
        )
    }
}

/** Who said it, beside what they said: your agent's I-beam, or an agent's glass (one since removed, its own still). */
@Composable
private fun SpeakerFace(id: String?, agents: List<sh.invincible.bot.core.Agent>) {
    if (id == "primary") PrimaryMark(28.dp) else AgentMarkView(id ?: "", agents.firstOrNull { it.id == id }?.avatar, 28.dp)
}

/**
 * A task as a chat's compact row (I10's phone-gaps, the lead's word of 28 November 2026): its title and one grey word for
 * where it stands (TaskWords.word: working, waiting, done, failed, stopped); a tap opens its thread, where its proof, Stop,
 * Ship it, Resume and Give again are. A proposal waits on your yes: an ask, its answers in place (Approve, Decline).
 */
@Composable
private fun TaskCard(app: AppModel, t: Json, openTask: (String) -> Unit) {
    val status = t["status"].string ?: ""
    val title = t["title"].string ?: ""
    val brand = LocalBrand.current
    if (status != "proposed") {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { t["id"].string?.let(openTask) }
                .semantics(mergeDescendants = true) { role = Role.Button }
                .heightIn(min = Space.touch)
                .padding(horizontal = Space.margin, vertical = Space.s1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s2),
        ) {
            Text(title, style = Type.body, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(TaskWords.word(status), style = Type.meta, color = brand.quiet)
        }
        return
    }
    // A proposal waits on your yes: an ask, as it would ask it, in a bubble beside whoever proposed it (its own agent, or
    // another, your agent among them), its answers under it; a tap on it opens its thread.
    val scope = rememberCoroutineScope()
    val table by app.table.collectAsState()
    val agents = table.snapshot?.agents ?: emptyList()
    var problem by remember { mutableStateOf<String?>(null) }
    fun control(action: String) = scope.launch {
        try {
            app.client?.post("/api/team/control", Json.obj("task" to t["id"].string, "action" to action))
            problem = null
            app.refresh()
        } catch (e: NodeError) {
            problem = e.message
        }
    }
    val assignee = t["assignee"].string
    val by = t["proposedBy"].string?.takeIf { it != assignee && it != "owner" && it != "you" }
    val name = agents.firstOrNull { it.id == assignee }?.name ?: assignee ?: "it"
    val goal = t["goal"].string?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() && it != title }
    TheirBubble(
        face = { SpeakerFace(by ?: assignee, agents) },
        below = {
            androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                AnswerPill("Approve", { control("approve") })
                TextButton(onClick = { control("stop") }) { Text("Decline") }
            }
            problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
        },
    ) {
        Column(Modifier.clickable { t["id"].string?.let(openTask) }.semantics(mergeDescendants = true) { role = Role.Button }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(if (by != null) "Shall $name start “$title”?" else "Shall I start “$title”?", style = Type.body)
            goal?.let { Text(it, style = Type.meta, color = brand.quiet, maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
        }
    }
}

/** A compact task's last line (TaskCard), and whether it is said in red. */
internal data class TaskLine(val text: String, val failed: Boolean)

/**
 * A compact task's last line, under its title and [word] (how it stands): where it ended short, why, in red; otherwise its
 * latest step; then what it kept. Why is said once: where it is only its word again ("gave-up" under "Gave up"), the line
 * says what else there is, as where no error was given.
 */
internal fun taskLine(status: String, word: String?, error: String?, progress: String?, files: Int?): TaskLine? {
    val ended = status == "failed" || status == "stopped" || status == "interrupted"
    val why = error?.lineSequence()?.first()?.trim()?.let { mapOf("gave-up" to "gave up", "unverified" to "not verified")[it] ?: it }
        ?.takeUnless { it.equals(word, ignoreCase = true) }
    val step = (if (ended) why ?: progress else progress)?.lineSequence()?.firstOrNull()?.takeIf { it.isNotBlank() }
    val kept = files?.let { "$it file${if (it == 1) "" else "s"} kept" }
    val text = listOfNotNull(step, kept).joinToString(" · ").takeIf { it.isNotEmpty() } ?: return null
    return TaskLine(text, ended && why != null)
}

/** An agent's verified work as a pull request: its title first (the task's, to change), on a new branch, as it was verified. */
@Composable
internal fun ShipDialog(app: AppModel, t: Json, done: () -> Unit) {
    var title by remember { mutableStateOf((t["title"].string ?: "").take(120)) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val files = t["changes"]["files"].int
    androidx.compose.material3.AlertDialog(
        onDismissRequest = done,
        title = { Text("Ship it as a pull request?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text("${files?.let { "$it file${if (it == 1) "" else "s"}" } ?: "Its changes"}, on a new invincible/… branch of its repository, as it was verified. Its checks are followed after.", style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.OutlinedTextField(value = title, onValueChange = { title = it.take(120) }, label = { Text("Pull request title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                problem?.let { Text(it, color = LocalBrand.current.failed) }
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank(), onClick = {
                scope.launch {
                    try {
                        app.client?.post("/api/team/ship", Json.obj("task" to t["id"].string, "title" to title.trim()))
                        app.refresh()
                        done()
                    } catch (e: NodeError) {
                        problem = e.message
                    }
                }
            }) { Text("Open pull request") }
        },
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}

/**
 * A box to write in, as your agent's chat's: Grok Bot's pill, growing into the big box as the words wrap, and a round
 * send, or Stop. [asTask] offers the same words as a task instead, behind the pill's + (I10's phone-gaps: +, the words,
 * send): chosen, the + shows it (the task's mark in the ink) and [taskPlaceholder] is in the box.
 */
@Composable
fun Composer(placeholder: String, asTask: String?, sending: Boolean, stop: (() -> Unit)? = null, taskPlaceholder: String? = null, onSend: (String, Boolean) -> Unit) {
    var text by remember { mutableStateOf("") }
    var task by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    fun send() {
        if (text.isBlank() || sending) return
        onSend(text.trim(), task)
        text = ""
    }
    // The pill, as the chat's: the same words as a task (a toggle) on the left, the words, and Send (or Stop) on the right.
    val brand = LocalBrand.current
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2)) {
        ComposerBox(
            focus = focus,
            field = { ComposerField(text, { text = it }, if (task && taskPlaceholder != null) taskPlaceholder else placeholder, focus, enter = ::send) },
            leading = {
                if (asTask != null) {
                    Box {
                        androidx.compose.material3.IconButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = if (task) "$asTask: chosen" else "More ways to send" }) {
                            Box(Modifier.size(32.dp).clip(CircleShape).background(if (task) brand.ink else Color.Transparent), contentAlignment = Alignment.Center) {
                                Icon(if (task) LayersIcon else PlusIcon, null, Modifier.size(20.dp), tint = if (task) brand.paper else MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            androidx.compose.material3.DropdownMenuItem(
                                text = { Text(asTask) },
                                leadingIcon = { Icon(LayersIcon, null) },
                                trailingIcon = { if (task) Icon(CheckIcon, contentDescription = "Chosen") },
                                onClick = { menu = false; task = !task },
                            )
                        }
                    }
                }
            },
            trailing = {
                if (stop != null) ComposerDisc(StopIcon, "Stop", ready = true, onClick = stop)
                else ComposerDisc(SendIcon, if (task) "Give it as a task" else "Send", ready = text.isNotBlank() && !sending, onClick = ::send)
            },
        )
    }
}
