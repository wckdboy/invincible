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
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.Icon
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Steps
import sh.invincible.bot.core.TeamTask
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.AgentMark

/** A line of an agent's timeline: something said, or a task as it stands. */
private data class Entry(val at: Long, val key: String, val speaker: String?, val mine: Boolean, val text: String, val task: Json?)

/**
 * An agent's page: its face and state, then its timeline (what you and it said, and its tasks as they stand, oldest
 * first), and a box to write to it or to give it a task. Opening it is looking, so what ended here is no longer new.
 */
@Composable
fun AgentScreen(app: AppModel, id: String, back: () -> Unit, openTask: (String) -> Unit = {}) {
    val table by app.table.collectAsState()
    val row = table.rows.firstOrNull { it.kind == "agent" && it.id == id }
    val person = table.snapshot?.agents?.firstOrNull { it.id == id }
    // Its VM: its screen, watched and taken over, or a terminal in it; Back returns here.
    var watching by rememberSaveable(id) { mutableStateOf(false) }
    var inTerminal by rememberSaveable(id) { mutableStateOf(false) }
    var vmMenu by remember { mutableStateOf(false) }
    var colouring by remember(id) { mutableStateOf(false) }
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
        busy = row?.state == AgentState.WORKING,
        placeholder = "Write to ${person?.name ?: id}",
        title = person?.name ?: id,
        back = back,
        openTask = openTask,
        // Any VM, as the iPhone offers it: one without a desktop says so (the node's refusal) and how to get one.
        actions = {
            if (sandbox != null) {
                androidx.compose.foundation.layout.Box {
                    TextButton(onClick = { vmMenu = true }) { Text("Its VM") }
                    androidx.compose.material3.DropdownMenu(expanded = vmMenu, onDismissRequest = { vmMenu = false }) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Its screen") }, onClick = { vmMenu = false; watching = true })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Its terminal") }, onClick = { vmMenu = false; inTerminal = true })
                    }
                }
            }
        },
    ) {
        val scope = rememberCoroutineScope()
        Column(Modifier.fillMaxWidth().padding(Space.margin), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.s2)) {
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
                    if (table.asOf == null) TextButton(onClick = { colouring = true }) { Text("Its glass") }
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
        busy = table.snapshot?.tasks?.any { it.room == id && it.status == "running" } == true,
        placeholder = "Write to ${room?.name ?: "the room"}",
        title = room?.name ?: "A room",
        back = back,
        openTask = openTask,
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
 * above names it ([title]) once the header has scrolled out of sight.
 */
@Composable
private fun Timeline(
    app: AppModel,
    key: String,
    roomOf: suspend (sh.invincible.bot.core.NodeClient) -> String?,
    seen: Json,
    assignee: String?,
    busy: Boolean,
    placeholder: String,
    title: String,
    back: () -> Unit,
    openTask: (String) -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    header: @Composable () -> Unit,
) {
    val table by app.table.collectAsState()
    var room by remember(key) { mutableStateOf<String?>(null) }
    var entries by remember(key) { mutableStateOf<List<Entry>>(emptyList()) }
    var problem by remember(key) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val names = table.snapshot?.agents?.associate { it.id to it.name } ?: emptyMap()

    suspend fun read() {
        val c = app.client ?: return
        try {
            val r = room ?: roomOf(c).also { room = it } ?: return
            val view = c.post("/api/team/room", Json.obj("id" to r))
            val said = view["messages"].list.map { m ->
                val speaker = m["speaker"].string ?: ""
                val who = when (speaker) { "owner" -> null; "primary" -> Primary.name; "system" -> "The agents"; else -> m["speakerName"].string ?: names[speaker] ?: speaker }
                Entry(m["createdAt"].long ?: 0, "m:${m["id"].string ?: m["createdAt"].long}", who, speaker == "owner", m["text"].string ?: "", null)
            }
            val tasks = view["tasks"].list.filter { assignee == null || it["assignee"].string == assignee }.map { t -> Entry(t["createdAt"].long ?: t["updatedAt"].long ?: 0, "t:${t["id"].string}", null, false, "", t) }
            entries = (said + tasks).sortedBy { it.at }
            problem = null
        } catch (e: NodeError) {
            problem = e.message
        }
    }

    LaunchedEffect(key) {
        runCatching { app.client?.post("/api/team/seen", seen) }
        while (true) {
            read()
            delay(if (busy) 2_000 else 4_000)
        }
    }
    LaunchedEffect(entries.size) { if (entries.isNotEmpty()) list.toEnd() }

    val headerGone by remember { derivedStateOf { list.firstVisibleItemIndex > 0 } }
    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar(if (headerGone) title else "", back, actions = actions)
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s4)) {
            item { header() }
            problem?.let { item { Problem(it) } }
            items(entries, key = { it.key }) { e -> if (e.task != null) TaskCard(app, e.task, openTask) else Said(e) }
        }
        Composer(
            placeholder = placeholder,
            asTask = if (assignee != null) "Give it as a task" else null,
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

@Composable
private fun Said(e: Entry) {
    val brand = LocalBrand.current
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), horizontalArrangement = if (e.mine) Arrangement.End else Arrangement.Start) {
        if (e.mine) {
            Text(
                e.text,
                color = brand.onInk,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.widthIn(max = 320.dp).clip(MaterialTheme.shapes.large).background(brand.ink).padding(horizontal = Space.s3, vertical = Space.s2),
            )
        } else {
            Column(Modifier.widthIn(max = 360.dp)) {
                e.speaker?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Markdown(e.text)
            }
        }
    }
}

/**
 * A task as it stands: its title, its state in a word, its latest line. Where it offers you something (a proposal's yes or
 * no, verified work to ship, ended work to resume) it is a card with its answer in place, the timeline's action card
 * (the owner's word, 27 November 2026); otherwise a quiet row that opens its thread, Stop under its "…".
 */
@Composable
private fun TaskCard(app: AppModel, t: Json, openTask: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val status = t["status"].string ?: ""
    val verified = t["verified"].bool == true
    val state = when (status) {
        "running" -> AgentState.WORKING
        "proposed" -> AgentState.NEEDS
        "failed" -> AgentState.FAILED
        "queued" -> AgentState.QUEUED
        "done" -> if (verified) AgentState.VERIFIED else null
        else -> null
    }
    // Once it has ended, its verdict as its proof allows (never "Verified" where its gates proved nothing).
    val said = remember(t) { TeamTask.of(t).let { Steps.verdict(it.status, it.verified, it.error, it.record, Steps.facts(it.record)) } }
    val word = said?.word ?: when (status) {
        "done" -> "Done"
        "proposed" -> "Proposed"
        "stopped" -> "Stopped"
        "interrupted" -> "Interrupted"
        else -> state?.words
    }
    val shipped = t["shipped"]
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
    val ships = status == "done" && verified && t["changes"] != null && t["fix"] == null && shipped == null
    val offers = status == "proposed" || ships || status == "failed" || status == "stopped" || status == "interrupted"
    val brand = LocalBrand.current
    val ink = when {
        said == null -> state?.tone?.let(brand::of) ?: MaterialTheme.colorScheme.onSurfaceVariant
        said.verdict == Steps.Verdict.PROVEN -> brand.ink
        said.verdict.wrong -> brand.danger
        else -> brand.quiet
    }
    if (!offers) {
        var more by remember { mutableStateOf(false) }
        val title = t["title"].string ?: ""
        val progress = t["progress"].string?.takeIf { it.isNotBlank() }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.medium)
                .clickable { t["id"].string?.let(openTask) }
                .semantics(mergeDescendants = true) { role = Role.Button }
                .padding(start = Space.s2, top = Space.s2, bottom = Space.s2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    Text(title, style = Type.rowTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    word?.let { w -> Text(w, style = MaterialTheme.typography.labelMedium, color = ink) }
                }
                progress?.let {
                    Text(it.lineSequence().first(), style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                }
            }
            if (status == "queued" || status == "running") {
                // (Its "…" beside its title: where a line of its latest step is under the title, centred on the whole row
                // it sat between the two, a line above the step once the title scrolled under the bar.)
                androidx.compose.foundation.layout.Box(if (progress != null) Modifier.align(Alignment.Top).offset(y = (-12).dp) else Modifier) {
                    androidx.compose.material3.IconButton(onClick = { more = true }) { Icon(MoreIcon, contentDescription = "More for $title") }
                    androidx.compose.material3.DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("Stop", color = brand.failed) }, onClick = { more = false; control("stop") })
                    }
                }
            }
        }
        problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed, modifier = Modifier.padding(horizontal = Space.s2)) }
        return
    }
    // Each task a line shorter (I10's 16dae258, as the web's): its title and how it stands on one line; who gave or
    // proposed it, muted; its latest step, or how it ended and what it kept; its answers each a tap under it. The row
    // opens its thread.
    val ended = status == "failed" || status == "stopped" || status == "interrupted"
    val why = t["error"].string?.lineSequence()?.first()?.trim()?.let { mapOf("gave-up" to "gave up", "unverified" to "not verified")[it] ?: it }
    val task = remember(t) { sh.invincible.bot.core.TeamTask.of(t) }
    fun who(id: String): String = when (id) { "primary" -> Primary.name; "owner", "you" -> "you"; else -> id }
    val by = task.proposedBy?.let { "Proposed by ${who(it)}" } ?: task.givenBy?.let { "Given by ${who(it)}" }
    val step = (if (ended) why ?: t["progress"].string else t["progress"].string)?.lineSequence()?.firstOrNull()?.takeIf { it.isNotBlank() }
    val kept = t["changes"]["files"].int?.let { "$it file${if (it == 1) "" else "s"} kept" }
    val title = t["title"].string ?: ""
    var shipping by remember { mutableStateOf(false) }
    var again by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .clickable { t["id"].string?.let(openTask) }
            .padding(start = Space.s2, top = Space.s2, bottom = Space.s1),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Text(title, style = Type.rowTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            word?.let { w -> Text(w, style = MaterialTheme.typography.labelMedium, color = ink) }
        }
        by?.let { Text(it, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
        listOfNotNull(step, kept).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
            Text(it, style = Type.meta, color = if (ended && why != null) LocalBrand.current.failed else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
        val context = androidx.compose.ui.platform.LocalContext.current
        // Its answers, each a tap.
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1), modifier = Modifier.padding(top = Space.s1)) {
            when {
                status == "proposed" -> {
                    AnswerPill("Approve", { control("approve") })
                    TextButton(onClick = { control("stop") }) { Text("Decline") }
                }
                ships -> {
                    AnswerPill("Ship it…", { shipping = true })
                    TextButton(onClick = { again = true }) { Text("Give again…") }
                }
                ended -> {
                    AnswerPill("Resume", { control("resume") })
                    TextButton(onClick = { again = true }) { Text("Give again…") }
                }
            }
            shipped["url"].string?.let { url ->
                TextButton(onClick = { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }) {
                    Text(shipped["pr"].int?.let { "Pull request #$it" } ?: "Its pull request")
                }
            }
        }
        problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.failed) }
    }
    if (shipping) ShipDialog(app, t) { shipping = false }
    if (again) GiveAgainDialog(app, task, opened = openTask) { again = false }
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
 * A box to write in, as the primary's conversation's (the owner's word, 27 November 2026: a big composer, the same
 * everywhere): a rounded field that grows to six lines and a round send, or Stop; [asTask] offers the same words as a task
 * instead, a chip above it.
 */
@Composable
fun Composer(placeholder: String, asTask: String?, sending: Boolean, stop: (() -> Unit)? = null, onSend: (String, Boolean) -> Unit) {
    var text by remember { mutableStateOf("") }
    var task by remember { mutableStateOf(false) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    fun send() {
        if (text.isBlank() || sending) return
        onSend(text.trim(), task)
        text = ""
    }
    // One big box, as the chat's: the words across all of it; under them, the same words as a task on the left, and Send
    // (or Stop) on the right.
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2)) {
        ComposerBox(
            focus = focus,
            field = { ComposerField(text, { text = it }, placeholder, focus, enter = ::send) },
            leading = {
                if (asTask != null) androidx.compose.material3.FilterChip(selected = task, onClick = { task = !task }, label = { Text(asTask) }, modifier = Modifier.padding(start = Space.s1))
            },
            trailing = {
                if (stop != null) ComposerDisc(StopIcon, "Stop", ready = true, onClick = stop)
                else ComposerDisc(SendIcon, if (task) "Give it as a task" else "Send", ready = text.isNotBlank() && !sending, onClick = ::send)
            },
        )
    }
}
