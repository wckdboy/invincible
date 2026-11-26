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
import androidx.compose.ui.draw.clip
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
            // Its orb, the one in focus on its own page: moving while it works, still otherwise.
            AgentOrb(id, person?.avatar, 96.dp, mood = if (row?.state == AgentState.WORKING) sh.invincible.bot.core.OrbMotion.Mood.WORKING else null, description = person?.name, key = "agent:$id")
            Text(person?.name ?: id, style = MaterialTheme.typography.headlineSmallEmphasized)
            StateChip(row?.state)
            row?.let { Text(Roster.besideChip(it.line, it.state), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            person?.let { p ->
                Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                    // Paused, an agent starts nothing new until you resume it; what it's doing now finishes.
                    TextButton(onClick = {
                        scope.launch { runCatching { app.client?.post("/api/team/control", Json.obj("agent" to id, "action" to if (p.enabled) "pause" else "resume")); app.refresh() } }
                    }) { Text(if (p.enabled) "Pause ${p.name}" else "Resume ${p.name}") }
                    // Its orb's colour, chosen once the node has answered (never from the agents this phone kept).
                    if (table.asOf == null) TextButton(onClick = { colouring = true }) { Text("Its colour") }
                }
            }
        }
    }
    if (colouring) person?.let { p -> ColourDialog(app, id, p.name, p.avatar) { colouring = false } }
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
                for (m in members.take(5)) AgentOrb(m.id, m.avatar, 56.dp, description = m.name)
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
        PageBar(if (headerGone) title else "", back, actions)
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

/** A task as it stands: its title, its state in a word, its latest line; a proposal waits for your yes or no. */
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
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Text("Task", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val brand = LocalBrand.current
            val ink = when {
                said == null -> state?.tone?.let(brand::of) ?: MaterialTheme.colorScheme.onSurfaceVariant
                said.verdict == Steps.Verdict.PROVEN -> brand.ink
                said.verdict.wrong -> brand.danger
                else -> brand.quiet
            }
            word?.let { w -> Text(w, style = MaterialTheme.typography.labelMedium, color = ink) }
        }
        Text(t["title"].string ?: "", style = MaterialTheme.typography.titleMediumEmphasized)
        // Work that ended short says why (a run's word for it in words: "gave-up" is "gave up"); work under way, its latest step.
        val ended = status == "failed" || status == "stopped" || status == "interrupted"
        val why = t["error"].string?.lineSequence()?.first()?.trim()?.let { mapOf("gave-up" to "gave up", "unverified" to "not verified")[it] ?: it }
        (if (ended) why ?: t["progress"].string else t["progress"].string)?.takeIf { it.isNotBlank() }?.let {
            Text(it.lineSequence().first(), style = MaterialTheme.typography.bodyMedium, color = if (ended && why != null) LocalBrand.current.failed else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        t["changes"]["files"].int?.let { Text("$it file${if (it == 1) "" else "s"} changed, kept", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        val shipped = t["shipped"]
        val context = androidx.compose.ui.platform.LocalContext.current
        shipped["url"].string?.let { url ->
            TextButton(onClick = { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }) {
                Text(shipped["pr"].int?.let { "Pull request #$it" } ?: "Its pull request")
            }
        }
        var problem by remember { mutableStateOf<String?>(null) }
        var shipping by remember { mutableStateOf(false) }
        fun control(action: String) = scope.launch {
            try {
                app.client?.post("/api/team/control", Json.obj("task" to t["id"].string, "action" to action))
                problem = null
                app.refresh()
            } catch (e: NodeError) {
                problem = e.message
            }
        }
        // What a task offers, as the iPhone's card does: by where it stands; and its own thread, where all of it is.
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            t["id"].string?.let { tid -> TextButton(onClick = { openTask(tid) }) { Text("Open") } }
            when {
                status == "proposed" -> Decision(no = "Decline", yes = "Start it", onNo = { control("stop") }, onYes = { control("approve") })
                status == "queued" || status == "running" -> OutlinedButton(onClick = { control("stop") }) { Text("Stop", color = LocalBrand.current.failed) }
                status == "done" && verified && t["changes"] != null && t["fix"] == null && shipped == null ->
                    androidx.compose.material3.Button(onClick = { shipping = true }) { Text("Ship it") }
                status == "failed" || status == "stopped" || status == "interrupted" -> OutlinedButton(onClick = { control("resume") }) { Text("Resume") }
            }
        }
        problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.failed) }
        if (shipping) ShipDialog(app, t) { shipping = false }
    }
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

/** A box to write in, with Send; [asTask] offers the same words as a task instead. */
@Composable
fun Composer(placeholder: String, asTask: String?, sending: Boolean, stop: (() -> Unit)? = null, onSend: (String, Boolean) -> Unit) {
    var text by remember { mutableStateOf("") }
    var task by remember { mutableStateOf(false) }
    val brand = LocalBrand.current
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Space.s3, vertical = Space.s2)) {
        if (asTask != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = task, onCheckedChange = { task = it })
                Text(asTask, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            androidx.compose.material3.OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(placeholder) },
                maxLines = 6,
                modifier = Modifier.weight(1f),
            )
            if (stop != null) {
                OutlinedButton(onClick = stop, modifier = Modifier.padding(bottom = 4.dp)) { Text("Stop") }
            } else {
                androidx.compose.material3.Button(
                    onClick = {
                        onSend(text.trim(), task)
                        text = ""
                    },
                    enabled = text.isNotBlank() && !sending,
                    modifier = Modifier.padding(bottom = 4.dp),
                    shapes = androidx.compose.material3.ButtonDefaults.shapes(),
                ) { Text("Send", color = if (text.isNotBlank()) brand.onInk else MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}
