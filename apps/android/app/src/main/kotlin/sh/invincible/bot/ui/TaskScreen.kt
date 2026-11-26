@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.OrbMotion
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Steps
import sh.invincible.bot.core.TaskWords
import sh.invincible.bot.core.TeamTask
import sh.invincible.bot.core.TrailEntry
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/*
 * A task as a thread of its own (your words, 26 November 2026: "project/tasks/coding t3code style for the agents"), as
 * T3 Code has a thread: what it is (its project, its title), who gave it and the brief, its agent's work folded into steps
 * ("Worked for 6m 12s ›"; while it works, the steps as they come and one live line), an outward step asking in place, what
 * the agent said, and then, apart from the agent's words and in its own colour, what proves it (the Verified card: each
 * gate's command and how it ended, the reviewer that didn't write it, its changes, its cost, and Ship it). Beside it on a
 * wide screen, and in a sheet on a phone, its details. The web's views/task.ts; everything is what the app already reads:
 * the team, the task's trail (POST /api/team/trail: the runner's own lines, never the agent's account), its conversation
 * (POST /api/team/room), its changes (POST /api/team/changes), your prices.
 */

/** A running task's new lines are asked for this often while its thread is on screen. */
private const val EVERY_MS = 1500L

/** Whether the details card is beside the thread on a wide screen (kept while the app is open). */
private var detailsShown by mutableStateOf(true)

@Composable
fun TaskScreen(app: AppModel, id: String, nav: Nav, wide: Boolean, roomy: Boolean) {
    val table by app.table.collectAsState()
    val inbox by app.inbox.collectAsState()
    val prices by app.prices.collectAsState()
    val projects by app.projects.collectAsState()
    val snapshot = table.snapshot
    val task = table.tasks.firstOrNull { it.id == id }
    val scope = rememberCoroutineScope()
    var trail by remember(id) { mutableStateOf(Steps.Trail()) }
    var trailRead by remember(id) { mutableStateOf(false) }
    var room by remember(id) { mutableStateOf<Json?>(null) }
    var changes by remember(id) { mutableStateOf<Json?>(null) }
    var problem by remember(id) { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf(false) }
    var giving by remember { mutableStateOf(false) }
    var shipping by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    val status = task?.status

    // ---- reading what it did: the trail, page by page; again while it runs; once more as it ends ----
    LaunchedEffect(id, status) {
        val c = app.client ?: return@LaunchedEffect
        while (true) {
            val page = try {
                c.post("/api/team/trail", Json.obj("task" to id, "after" to trail.after))
            } catch (e: NodeError) {
                problem = e.message
                trailRead = true
                delay(EVERY_MS * 3)
                continue
            }
            val before = trail
            trail = Steps.take(trail, page["entries"].list.map(TrailEntry::of))
            trailRead = true
            problem = null
            when (Steps.next(page["task"]["status"].string ?: status ?: "", page["more"].bool == true, trail !== before)) {
                Steps.Next.NOW -> continue
                Steps.Next.WAIT -> delay(EVERY_MS)
                Steps.Next.DONE -> break
            }
        }
    }
    // Its conversation: what was said since it was given, read again every few seconds while it is open.
    LaunchedEffect(id, task?.room) {
        val r = task?.room ?: return@LaunchedEffect
        while (true) {
            runCatching { app.client?.post("/api/team/room", Json.obj("id" to r)) }.getOrNull()?.let { room = it }
            delay(if (status == "running" || status == "queued") 4_000 else 8_000)
        }
    }
    // What it changed, where this device may look into its agent's VM: asked once, and again as the work moves on.
    val agent = snapshot?.agents?.firstOrNull { it.id == task?.assignee }
    LaunchedEffect(id, status, task?.changes?.files) {
        if (task == null || agent?.repository == null || status == "proposed" || status == "queued") return@LaunchedEffect
        runCatching { app.client?.post("/api/team/changes", Json.obj("id" to task.assignee, "task" to task.id)) }.getOrNull()?.let { changes = it }
    }
    // On screen, an ended task's result is read: no longer new to you, on any device (Work.seenOnOpen).
    LaunchedEffect(id, trailRead, task?.updatedAt) {
        if (!trailRead || snapshot == null) return@LaunchedEffect
        Work.seenOnOpen(id, table.tasks, snapshot.seen)?.let { who -> runCatching { app.seen(who) } }
    }

    if (snapshot == null || task == null) {
        Column(Modifier.fillMaxSize()) {
            PageBar(if (snapshot == null) "" else "This task isn't here", { nav.back() })
            Waiting(
                when {
                    snapshot == null && app.problem.collectAsState().value != null -> "The work can't be read just now."
                    snapshot == null -> "Asking your node…"
                    else -> "It may have been given on another node, or its agent was removed. Home has the work, by what needs you."
                },
            )
        }
        return
    }
    val name = agent?.name ?: snapshot.removed.firstOrNull { it.first == task.assignee }?.second ?: task.assignee
    val project = Work.projectsOfAgents(snapshot.agents, projects)(task.assignee)
    val running = task.status == "running"
    val asks = if (running) inbox.actions.filter { Roster.agentOfCaller(it["by"].string ?: "") == task.assignee && (it["expires"].long ?: Long.MAX_VALUE) > System.currentTimeMillis() } else emptyList()
    val proof = remember(trail, task.status, task.gates) { Steps.proofOf(task.status, task.gates, trail.entries) }
    val sideBySide = wide && roomy && detailsShown
    val details: @Composable () -> Unit = {
        Details(app, task, name, proof, changes, prices, agent?.workspace, snapshot.rooms.firstOrNull { it.direct && it.members == listOf(task.assignee) }?.id, nav)
    }

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().imePadding()) {
            ThreadHead(task, name, project, agent?.avatar, wide, back = { nav.back() }, showBack = !wide || nav.depth > 1, detailsOn = sideBySide, details = {
                if (wide && roomy) detailsShown = !detailsShown else sheet = true
            }, openAgent = { nav.go(Nav.agent(task.assignee)) })
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                LazyColumn(Modifier.fillMaxSize().widthIn(max = 760.dp), state = list, contentPadding = PaddingValues(horizontal = Space.margin, vertical = Space.s3), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                    item(key = "dispatch") { Dispatch(task, name, snapshot.agents.firstOrNull { it.id == task.proposedBy }?.name) }
                    item(key = "brief") { Brief(task.goal) }
                    facts(task, table.tasks).takeIf { it.isNotEmpty() }?.let { f -> item(key = "facts") { Text(f, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
                    problem?.let { p -> item(key = "problem") { Problem(p) } }
                    item(key = "work") { WorkDone(task, name, trail.entries, trailRead, table.tasks) }
                    items(asks, key = { "a:${it["id"].string}" }) { a ->
                        Box(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).border(BorderStroke(1.dp, LocalBrand.current.needs.copy(alpha = 0.45f)), MaterialTheme.shapes.large)) {
                            AskItem(a, null, name, decide = { approve -> scope.launch { runCatching { app.decide(a["id"].string!!, approve) } } }, more = { nav.go("inbox") })
                        }
                    }
                    item(key = "asks") { InPlace(app, task, name, give = { giving = true }) }
                    TaskWords.end(task)?.said?.let { said -> item(key = "said") { Said(task, name, agent?.avatar, said) } }
                    if (task.status == "done" || task.status == "failed") item(key = "proof") {
                        ProofCard(app, task, name, proof, changes, prices, ship = { shipping = true }, again = { giving = true })
                    }
                    items(conversation(room, task), key = { "m:${it["id"].string ?: it["createdAt"].long}" }) { m -> Message(m, snapshot.agents) }
                    item(key = "end") { Spacer(Modifier.size(Space.s2)) }
                }
            }
            if (running) LiveLine(trail.entries, stop = { scope.launch { control(app, task.id, "stop") } })
            MessageDock(
                placeholder = "Tell $name…",
                key = "task:${task.id}",
                hint = when (task.status) { "running" -> "$name answers once this work ends"; "queued" -> "$name answers before starting on it"; else -> null },
            ) { words ->
                scope.launch {
                    try {
                        app.client?.post("/api/team/messages", Json.obj("room" to task.room, "text" to words))
                        room = app.client?.post("/api/team/room", Json.obj("id" to task.room)) ?: room
                        list.toEnd()
                    } catch (e: NodeError) {
                        problem = e.message
                    }
                }
                true
            }
        }
        if (sideBySide) {
            Column(Modifier.width(Space.details).fillMaxHeight().padding(top = Space.s3, end = Space.s3, bottom = Space.s3)) {
                Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).border(BorderStroke(1.dp, LocalBrand.current.line), MaterialTheme.shapes.large).background(LocalBrand.current.raised).verticalScroll(rememberScrollState())) {
                    details()
                }
            }
        }
    }
    if (sheet) {
        ModalBottomSheet(onDismissRequest = { sheet = false }, sheetState = rememberFullSheet(), containerColor = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = Space.s4)) {
                Text("The task's details", style = Type.title, modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2).semantics { heading() })
                details()
            }
        }
    }
    if (giving) GiveAgainDialog(app, task, opened = { newId -> giving = false; nav.replace(Nav.task(newId)) }) { giving = false }
    if (shipping) ShipDialog(app, Json.obj("id" to task.id, "title" to task.title, "changes" to task.changes?.let { Json.obj("files" to it.files) })) { shipping = false }
}

private suspend fun control(app: AppModel, task: String, action: String) {
    runCatching { app.client?.post("/api/team/control", Json.obj("task" to task, "action" to action)) }
    app.refresh()
}

// ---- its head ----------------------------------------------------------------------------------------------------------

/**
 * The thread's head: back, what it is (its title; under it its project and its agent, or on a wide screen the crumb
 * "project / title"), its details, and its agent's orb (moving while it works: the orb in focus), which opens its page.
 */
@Composable
private fun ThreadHead(task: TeamTask, name: String, project: Work.Project, avatar: Json?, wide: Boolean, back: () -> Unit, showBack: Boolean, detailsOn: Boolean, details: () -> Unit, openAgent: () -> Unit) {
    val working = task.status == "running"
    Column {
        Row(Modifier.fillMaxWidth().padding(start = Space.s1, end = Space.s2, top = Space.s1, bottom = Space.s1), verticalAlignment = Alignment.CenterVertically) {
            if (showBack) IconButton(onClick = back) { Icon(BackIcon, contentDescription = "Back") } else Spacer(Modifier.width(Space.s3))
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { heading() }) {
                if (wide) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ProjectBadge(project)
                        Text(project.name, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        Text("/", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(task.title, style = Type.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                } else {
                    Text(task.title, style = Type.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${project.name} · $name", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            IconButton(onClick = details, modifier = Modifier.semantics { contentDescription = if (detailsOn) "Hide the details" else "The task's details"; stateDescription = if (detailsOn) "shown" else "hidden" }) {
                Icon(PanelIcon, null, tint = if (detailsOn) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(
                Modifier.size(Space.touch).clip(CircleShape).clickable(onClick = openAgent).semantics { role = Role.Button; contentDescription = "$name${if (working) ", working" else ""}: its page" },
                contentAlignment = Alignment.Center,
            ) {
                AgentOrb(task.assignee, avatar, 28.dp, mood = if (working) OrbMotion.Mood.WORKING else null, key = "task:${task.assignee}")
            }
        }
        Hairline()
    }
}

// ---- the thread ----------------------------------------------------------------------------------------------------------

/** Who gave it, and how, in a line (the dispatch): the primary or you to the agents, an agent's proposal, or by name. */
private fun dispatchWords(task: TeamTask, agent: String, proposer: String?): String = when {
    task.proposedBy != null -> if (task.status == "proposed") "${proposer ?: task.proposedBy} proposes it: it starts when you approve it." else "${proposer ?: task.proposedBy} proposed it, and it was approved."
    task.givenBy == "primary" -> "${Primary.name} gave it to the agents, and $agent took it as best suited."
    task.givenBy == "owner" -> "You gave it to the agents, and $agent took it as best suited."
    else -> "Given to $agent by name."
}

/** When something in a thread happened, as the thread says it: "just now" for the last minute, and for a moment a few
 * seconds ahead (a node's clock can be ahead of this phone's), as Home and the agents say it; Android's own words
 * ("3 minutes ago") after that. */
internal fun threadAgo(at: Long, now: Long = System.currentTimeMillis()): CharSequence =
    if (now - at < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(at, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)

@Composable
private fun Dispatch(task: TeamTask, name: String, proposer: String?) {
    val ago = threadAgo(task.createdAt)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
        if (task.givenBy == "primary" || task.proposedBy == "primary") PrimaryOrb(18.dp) else Icon(LayersIcon, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            buildAnnotatedString {
                append(dispatchWords(task, name, proposer))
                append("  ")
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(ago.toString()) }
            },
            style = Type.meta,
        )
    }
}

/** The brief, as it was given: its own surface, the words as they were written. */
@Composable
private fun Brief(goal: String) {
    val brand = LocalBrand.current
    Text(
        goal.ifBlank { "(Its brief isn't kept on this phone.)" },
        style = Type.body,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .border(BorderStroke(1.dp, brand.line), MaterialTheme.shapes.large)
            .background(brand.raised)
            .padding(horizontal = Space.s4, vertical = Space.s3)
            .semantics { contentDescription = "The brief: $goal" },
    )
}

/** What else is so of it, in a line: sensitive mode, your stepping in, an outcome's step, a fix, where it began, and what
 * waits on it. */
private fun facts(task: TeamTask, all: List<TeamTask>): String {
    val dependents = all.filter { task.id in it.dependsOn }
    return listOfNotNull(
        task.models.takeIf { it.isNotEmpty() }?.let { "Sensitive mode: on ${it.joinToString(", ")} alone" },
        TaskWords.stepped(task),
        task.outcome?.let { "A step of an outcome ${Primary.name} owns" },
        task.fix?.let { "It fixes pull request ${it.pr?.let { pr -> "#$pr" } ?: it.branch}" },
        task.from?.let { "Started where step ${it.step} of another task left its files" },
        dependents.takeIf { it.isNotEmpty() }?.let { d -> "${d.joinToString(", ") { "“${it.title}”" }} ${if (d.size == 1) "waits" else "wait"} on it." },
    ).joinToString(" · ")
}

/**
 * Its agent's work, folded: while it works, who and since when, then its steps as they come; once it has ended, one line
 * ("Ada worked for 6m 12s · ran 14 commands ›") that opens to the steps. Queued: what it waits for.
 */
@Composable
private fun WorkDone(task: TeamTask, name: String, entries: List<TrailEntry>, read: Boolean, all: List<TeamTask>) {
    val groups = remember(entries) { Steps.groups(entries) }
    val summary = remember(entries, task.record) { Steps.summary(entries, task.record) }
    var open by rememberSaveable(task.id) { mutableStateOf(false) }
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
        when {
            !read -> Text("Reading what $name did…", style = Type.meta, color = quiet)
            groups.isNotEmpty() && task.status == "running" -> {
                val span = Work.shortSpan(System.currentTimeMillis() - task.createdAt)
                Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(name) }; append(if (span == "now") " · just started" else " · working for $span") }, style = Type.body)
                for (g in groups) StepLine(g)
            }
            groups.isNotEmpty() -> {
                val words = Steps.summaryWords(summary)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.small)
                        .clickable { open = !open }
                        .semantics(mergeDescendants = true) { role = Role.Button; stateDescription = if (open) "shown" else "folded" }
                        .heightIn(min = Space.touch),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.s1),
                ) {
                    Icon(ChevronIcon, null, Modifier.size(16.dp).rotate(if (open) 90f else 0f), tint = quiet)
                    Text(
                        buildAnnotatedString {
                            append("$name worked for ${Steps.workedFor(summary.ms)}")
                            if (words.isNotEmpty()) withStyle(SpanStyle(color = quiet)) { append(" · $words") }
                        },
                        style = Type.body,
                    )
                }
                if (open) for (g in groups) StepLine(g)
            }
            task.status == "running" -> Text("$name is starting on it", style = Type.body)
            task.status == "queued" -> Text(waitsFor(task, name, all), style = Type.body, color = quiet)
        }
    }
}

/** What a queued task waits for: the tasks it depends on that aren't done and verified yet, or its agent's turn. */
private fun waitsFor(task: TeamTask, name: String, all: List<TeamTask>): String {
    val waits = task.dependsOn.mapNotNull { id -> all.firstOrNull { it.id == id } }.filter { !(it.status == "done" && it.verified) }
    return if (waits.isEmpty()) "Queued: $name starts on it next."
    else "Queued: it starts once ${waits.joinToString(" and ") { "“${it.title}”" }} ${if (waits.size == 1) "is" else "are"} done and verified."
}

/** A step's icon, by what it was and how it went. */
private fun stepIcon(g: Steps.Group): ImageVector = when (g.kind) {
    Steps.Kind.GATE -> if (g.tone == Steps.Tone.OK) CheckIcon else CrossIcon
    Steps.Kind.REVIEW -> ReviewIcon
    Steps.Kind.NOTE -> if (g.tone == Steps.Tone.WARN) AlertIcon else InfoIcon
    Steps.Kind.PLAN -> PlanIcon
    Steps.Kind.EDIT -> EditIcon
    Steps.Kind.READ -> FileIcon
    Steps.Kind.SUBMITTED -> ShieldIcon
    Steps.Kind.RUN -> TerminalIcon
}

/** A folded group of steps: its line, and what is in it a tap away (a plan's, a gate's or the review's lines, or more
 * than one command or file). */
@Composable
private fun StepLine(g: Steps.Group) {
    val brand = LocalBrand.current
    val tone = when (g.tone) { Steps.Tone.OK -> brand.done; Steps.Tone.FAILED -> brand.failed; Steps.Tone.WARN -> brand.needs; Steps.Tone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant }
    val opens = g.items.size > 1 || (g.items.isNotEmpty() && (g.kind == Steps.Kind.PLAN || g.kind == Steps.Kind.REVIEW || g.kind == Steps.Kind.GATE))
    var open by rememberSaveable("step:${g.from}") { mutableStateOf(false) }
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (opens) Modifier.clip(MaterialTheme.shapes.small).clickable { open = !open }.semantics(mergeDescendants = true) { role = Role.Button; stateDescription = if (open) "shown" else "folded" } else Modifier)
                .heightIn(min = 32.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s2),
        ) {
            Icon(stepIcon(g), null, Modifier.size(15.dp), tint = tone)
            Text(g.text, style = Type.meta.copy(fontSize = Type.body.fontSize), color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        if (open) {
            Column(Modifier.padding(start = 23.dp, bottom = Space.s1), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                for (item in g.items) {
                    Text(
                        buildAnnotatedString {
                            append(item.text)
                            if (item.exit != null && item.exit != 0) withStyle(SpanStyle(color = brand.failed)) { append("  exit ${item.exit}") }
                        },
                        style = if (g.kind == Steps.Kind.PLAN || g.kind == Steps.Kind.REVIEW) Type.meta else Type.mono,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** What only you can move on in place: a proposal to approve, work cut short to resume, stopped work, queued work. */
@Composable
private fun InPlace(app: AppModel, task: TeamTask, name: String, give: () -> Unit) {
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current
    @Composable
    fun callout(text: String, tone: Color, actions: @Composable () -> Unit) {
        Column(
            Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).border(BorderStroke(1.dp, tone.copy(alpha = 0.45f)), MaterialTheme.shapes.large).background(tone.copy(alpha = 0.05f)).padding(Space.s4),
            verticalArrangement = Arrangement.spacedBy(Space.s3),
        ) {
            Text(text, style = Type.body)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2)) { actions() }
        }
    }
    when (task.status) {
        "proposed" -> callout("${task.proposedBy?.let { if (it == "primary") Primary.name else it } ?: name} proposes this. Nothing runs until you approve it.", brand.needs) {
            ActionButton("Approve", { scope.launch { control(app, task.id, "approve") } })
            ActionButton("Decline", { scope.launch { control(app, task.id, "stop") } }, primary = false)
        }
        "interrupted" -> callout("The node was cut off while this ran. Look at what it did, then resume it, or give it again.", brand.needs) {
            ActionButton("Resume", { scope.launch { control(app, task.id, "resume") } })
            ActionButton("Give again…", give, primary = false)
        }
        "stopped" -> callout("Stopped before it was done.", MaterialTheme.colorScheme.onSurfaceVariant) {
            ActionButton("Resume", { scope.launch { control(app, task.id, "resume") } }, primary = false)
            ActionButton("Give again…", give, primary = false)
        }
        "queued" -> ActionButton("Stop it", { scope.launch { control(app, task.id, "stop") } }, primary = false, icon = StopIcon)
    }
}

/** What the agent said of its work: its own words, never the proof. */
@Composable
private fun Said(task: TeamTask, name: String, avatar: Json?, said: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.s1), modifier = Modifier.semantics(mergeDescendants = false) { contentDescription = "What $name said" }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AgentOrb(task.assignee, avatar, 16.dp)
            Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(name) }; append(" said") }, style = Type.meta)
        }
        Markdown(said)
    }
}

/**
 * What proves it, apart from what the agent says and in its own colour: the Verified card, or why it isn't verified. Its
 * seal, the ways a pass can say less than it seems, each gate's command and how it ended, the reviewer that didn't write
 * it, what it changed, its cost, and what can be done with it (Ship it, Give again, Resume, its pull request).
 */
@Composable
private fun ProofCard(app: AppModel, task: TeamTask, name: String, proof: Steps.Proof, changes: Json?, prices: Map<String, sh.invincible.bot.core.Price>?, ship: () -> Unit, again: () -> Unit) {
    val brand = LocalBrand.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val verified = task.status == "done" && task.verified
    val tone = if (verified) brand.done else brand.failed
    val end = TaskWords.end(task)
    val actions = TaskWords.actions(task)
    val files = task.changes?.files ?: changes?.get("files")?.list?.size ?: 0
    val added = changes?.get("files")?.list?.sumOf { it["added"].int ?: 0 }
    val removed = changes?.get("files")?.list?.sumOf { it["removed"].int ?: 0 }
    val caveats = listOfNotNull(
        if (proof.sameModel) "The review was by the same model that did the work: no other reviewer model could answer." else null,
        if (proof.provesNothing) (if (verified) "Each gate passed before the work too, so none shows it was done: the reviewer decided alone." else "Each gate passes before any work, so none can show this work was done.") else null,
        if (proof.gates.isEmpty() && verified) "No commands were given to prove it: the reviewer decided alone." else null,
    )
    val shape = MaterialTheme.shapes.large
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(BorderStroke(1.dp, tone.copy(alpha = 0.5f)), shape)
            .background(tone.copy(alpha = 0.06f))
            .padding(Space.s4)
            .semantics { contentDescription = if (verified) "Verified: by its gates and a reviewer that didn't write it" else "Not verified: ${end?.why ?: ""}" },
        verticalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Box(Modifier.size(22.dp).clip(CircleShape).background(tone), contentAlignment = Alignment.Center) {
                Icon(if (verified) CheckIcon else CrossIcon, null, Modifier.size(14.dp), tint = brand.paper)
            }
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = tone)) { append(if (verified) "Verified" else "Not verified") }
                    withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(if (verified) " · by its gates and a reviewer that didn't write it" else " · ${end?.why ?: "its gates or the review did not pass"}") }
                },
                style = Type.body,
            )
        }
        for (c in caveats) Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Icon(AlertIcon, null, Modifier.size(15.dp).padding(top = 2.dp), tint = brand.needs)
            Text(c, style = Type.meta)
        }
        if (proof.gates.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) { for (gate in proof.gates) GateLine(gate, stacked = true) }
        proof.review?.let { r ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                Icon(ReviewIcon, null, Modifier.size(15.dp).padding(top = 2.dp), tint = if (r.verdict == "pass") brand.done else brand.needs)
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(if (r.verdict == "pass") "The reviewer passed it" else "The reviewer sent it back") }
                        r.notes.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() }?.let { append(": “${it.take(200)}”") }
                    },
                    style = Type.meta,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
            Text(
                buildAnnotatedString {
                    if (files > 0) {
                        append("$files file${if (files == 1) "" else "s"}")
                        if (added != null && removed != null) {
                            append(" ")
                            withStyle(SpanStyle(color = brand.done)) { append("+$added") }
                            append(" ")
                            withStyle(SpanStyle(color = brand.failed)) { append("−$removed") }
                        } else append(" kept")
                    } else withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("No changes kept") }
                },
                style = Type.meta,
                modifier = Modifier.weight(1f),
            )
            Text(if (prices != null || task.record == null) Steps.costWords(task.budgetUsd, task.record, prices ?: emptyMap()) else "", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val shipped = task.shipped
        if (actions.isNotEmpty() || shipped != null || verified) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                if ("ship" in actions) ActionButton("Ship it…", ship, icon = ExternalIcon)
                if ("resume" in actions) ActionButton("Resume", { scope.launch { control(app, task.id, "resume") } }, primary = false)
                // Verified work with nothing to ship (no repository, or shipped already) can still be given again, revised.
                if ("again" in actions || verified) ActionButton("Give again…", again, primary = !verified, icon = RetryIcon)
                shipped?.url?.let { url ->
                    TextButton(onClick = { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }, modifier = Modifier.heightIn(min = Space.touch)) {
                        Icon(ExternalIcon, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(Space.s1))
                        Text(shipped.pr?.let { "Pull request #$it" } ?: "Its pull request")
                    }
                }
            }
        }
    }
}

/** A clock for how long a gate took: "0:42", "12:05". */
private fun clock(ms: Long): String {
    val seconds = maxOf(0L, ms / 1000)
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}

/**
 * A gate as its latest round left it: its state's mark, its command, and how it ended (exit, time, its first words).
 * [stacked]: how it ended on a line of its own under its command (the Verified card's, where the command needs the room);
 * else at its end, short ([end]: the details card's words for it).
 */
@Composable
private fun GateLine(gate: Steps.GateRow, stacked: Boolean = false, end: String? = null) {
    val brand = LocalBrand.current
    val (icon, tone) = when (gate.state) {
        Steps.GateState.PASSED -> CheckIcon to brand.done
        Steps.GateState.FAILED -> CrossIcon to brand.failed
        Steps.GateState.RUNNING -> PlayIcon to brand.working
        Steps.GateState.WAITING -> ClockIcon to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val how = end ?: if (gate.exit != null) listOfNotNull("exit ${gate.exit}", gate.ms?.let(::clock), gate.said.takeIf { it.isNotEmpty() }).joinToString(" · ") else "not run"
    if (stacked) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2), modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = gate.state.wire }) {
            Icon(icon, null, Modifier.padding(top = 2.dp).size(14.dp), tint = tone)
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(gate.command, style = Type.mono, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(how, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2), modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = gate.state.wire }) {
        Icon(icon, null, Modifier.size(14.dp), tint = tone)
        Text(gate.command, style = Type.mono, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(how, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
    }
}

/** What was said in the task's conversation from when it was given until the next task given there (not the system's). */
private fun conversation(room: Json?, task: TeamTask): List<Json> {
    room ?: return emptyList()
    val next = room["tasks"].list.filter { it["id"].string != task.id && (it["createdAt"].long ?: 0) > task.createdAt }.minOfOrNull { it["createdAt"].long ?: Long.MAX_VALUE } ?: Long.MAX_VALUE
    return room["messages"].list.filter { (it["createdAt"].long ?: 0) >= task.createdAt && (it["createdAt"].long ?: 0) < next && it["speaker"].string != "system" }
}

@Composable
private fun Message(m: Json, agents: List<sh.invincible.bot.core.Agent>) {
    val owner = m["speaker"].string == "owner"
    val speaker = when (val s = m["speaker"].string ?: "") {
        "owner" -> "You"
        // (As the iPhone's timeline names it, the PWA's teamSpeaker: the vectors hold that one to the web's words.)
        "primary" -> "Your agent"
        else -> m["speakerName"].string ?: agents.firstOrNull { it.id == s }?.name ?: s
    }
    val ago = threadAgo(m["createdAt"].long ?: 0)
    Column(
        Modifier.fillMaxWidth().then(if (owner) Modifier.clip(MaterialTheme.shapes.large).background(LocalBrand.current.raised).padding(Space.s3) else Modifier),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(speaker) }; withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("  $ago") } }, style = Type.meta)
        if (owner) Text(m["text"].string ?: "", style = Type.body) else Markdown(m["text"].string ?: "")
    }
}

/** The one live line while it works: what it runs now, and since when; Stop. */
@Composable
private fun LiveLine(entries: List<TrailEntry>, stop: () -> Unit) {
    val step = Steps.liveStep(entries) ?: return
    val brand = LocalBrand.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(step.since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000 - now % 1000)
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(start = Space.margin, end = Space.s2).heightIn(min = Space.touch).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        Dot(brand.working)
        Text(
            buildAnnotatedString {
                if (step.command) {
                    append("Running ")
                    withStyle(SpanStyle(fontFamily = Type.mono.fontFamily)) { append(step.text) }
                } else append(step.text)
            },
            style = Type.meta.copy(fontSize = Type.body.fontSize),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(clock(now - step.since), style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = stop) { Text("Stop") }
    }
}

// ---- its details -----------------------------------------------------------------------------------------------------------

/**
 * The details: the agent's VM (Peek, Terminal), where its work began, its changes, its gates as they run, the reviewer,
 * its cost against its budget, and what waits on it. Beside the thread on a wide screen; a sheet on a phone.
 */
@Composable
private fun Details(app: AppModel, task: TeamTask, name: String, proof: Steps.Proof, changes: Json?, prices: Map<String, sh.invincible.bot.core.Price>?, vm: Json?, direct: String?, nav: Nav) {
    val table by app.table.collectAsState()
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    val brand = LocalBrand.current
    val files = changes?.get("files")?.list?.size ?: task.changes?.files
    val added = changes?.get("files")?.list?.sumOf { it["added"].int ?: 0 }
    val removed = changes?.get("files")?.list?.sumOf { it["removed"].int ?: 0 }
    val dependents = table.tasks.filter { task.id in it.dependsOn }
    val reviewer = mapOf("passed" to "passed it", "sent back" to "sent it back", "reading" to "is reading it", "waits" to "waits for the gates", "none" to "not reached")[proof.reviewer] ?: proof.reviewer
    val agent = table.snapshot?.agents?.firstOrNull { it.id == task.assignee }
    val shipWords = when {
        task.shipped != null -> task.shipped.pr?.let { "Pull request #$it" } ?: "Shipped"
        task.status == "done" && task.verified && task.changes != null && task.fix == null -> "Ready to ship"
        task.fix != null -> "Onto ${task.fix.branch} when verified"
        task.changes != null || agent?.repository != null -> "Ship it when verified"
        else -> "Nothing to ship: no repository"
    }
    @Composable
    fun row(icon: ImageVector, value: @Composable () -> Unit, end: (@Composable () -> Unit)? = null) {
        Row(Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = Space.s4), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
            Icon(icon, null, Modifier.size(16.dp), tint = quiet)
            Box(Modifier.weight(1f)) { value() }
            end?.invoke()
        }
    }
    @Composable
    fun label(left: String, right: String) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.s4).padding(top = Space.s3, bottom = Space.s1).semantics(mergeDescendants = true) { heading() }, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(left, style = Type.section, color = quiet)
            Text(right, style = Type.section, color = quiet)
        }
    }
    Column(Modifier.fillMaxWidth().padding(vertical = Space.s2)) {
        val sandbox = vm?.get("id")?.string
        row(MonitorIcon, { Text(if (vm != null) "$name's VM" else "$name has no VM yet", style = Type.meta.copy(fontSize = Type.body.fontSize), color = if (vm != null) MaterialTheme.colorScheme.onSurface else quiet) }) {
            if (vm != null) Row {
                TextButton(onClick = { nav.go("desktop:${task.assignee}") }) { Text("Peek") }
                if (sandbox != null) TextButton(onClick = { nav.go("terminal:$sandbox:${task.assignee}") }) { Text("Terminal") }
            }
        }
        row(CodeIcon, {
            Text(
                task.fix?.branch ?: task.changes?.base?.let { "from ${it.take(10)}" } ?: if (agent?.repository != null) "its repository, as fetched" else "no repository",
                style = if (task.fix != null || task.changes?.base != null) Type.mono else Type.meta.copy(fontSize = Type.body.fontSize),
                color = if (task.fix != null || task.changes?.base != null) MaterialTheme.colorScheme.onSurface else quiet,
            )
        }, task.from?.let { { Text("step ${it.step}", style = Type.small, color = quiet) } })
        row(FileIcon, {
            Text(
                if (files != null) "Changes · $files file${if (files == 1) "" else "s"}" else if (task.status == "running") "Changes as it works" else "No changes kept",
                style = Type.meta.copy(fontSize = Type.body.fontSize),
                color = if (files != null) MaterialTheme.colorScheme.onSurface else quiet,
            )
        }, if (added != null && removed != null && (files ?: 0) > 0) ({
            Text(buildAnnotatedString { withStyle(SpanStyle(color = brand.done)) { append("+$added") }; append(" "); withStyle(SpanStyle(color = brand.failed)) { append("−$removed") } }, style = Type.meta)
        }) else null)
        Hairline(Modifier.padding(top = Space.s1))
        label(if (proof.gates.isNotEmpty()) "Gates · ${proof.passed} of ${proof.gates.size} passed" else "No gates", "Reviewer $reviewer")
        for (gate in proof.gates) {
            // (While it works, a gate not run yet is next; after, it was not run.)
            val end = when (gate.state) {
                Steps.GateState.RUNNING -> "running"
                Steps.GateState.WAITING -> if (task.status == "running") "next" else "not run"
                else -> gate.ms?.let(::clock) ?: "exit ${gate.exit}"
            }
            Box(Modifier.padding(horizontal = Space.s4, vertical = 4.dp)) { GateLine(gate, end = end) }
        }
        if (proof.gates.isEmpty()) Text("No commands were given to prove it: the independent reviewer decides alone.", style = Type.meta, color = quiet, modifier = Modifier.padding(horizontal = Space.s4))
        Hairline(Modifier.padding(top = Space.s3))
        label("This task", if (prices != null || task.record == null) Steps.costWords(task.budgetUsd, task.record, prices ?: emptyMap()).ifEmpty { "no budget" } else "")
        for (d in dependents) row(LayersIcon, { Text("“${d.title}” waits on it", style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis) }) { Text(d.status, style = Type.small, color = quiet) }
        row(ExternalIcon, { Text(shipWords, style = Type.meta.copy(fontSize = Type.body.fontSize)) })
        if (direct != null) TextButton(onClick = { nav.go(Nav.agent(task.assignee)) }, modifier = Modifier.padding(horizontal = Space.s2)) { Text("$name's page") }
    }
}

/** The same task given again (Give again…): what was asked, with what came of it last time; it opens the new one. */
@Composable
private fun GiveAgainDialog(app: AppModel, task: TeamTask, opened: (String) -> Unit, done: () -> Unit) {
    val scope = rememberCoroutineScope()
    var said by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val body = remember(task) { TaskWords.giveAgain(task) }
    AlertDialog(
        onDismissRequest = done,
        title = { Text("Give it again?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text("“${task.title}”, to the same agent, with the same gates.", style = Type.body)
                if (body["goal"].string != task.goal.split("\n\nLast time (")[0]) Text("It carries what came of it last time, so the next try starts from there.", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
                said?.let { Text(it, style = Type.meta, color = LocalBrand.current.failed) }
            }
        },
        confirmButton = {
            TextButton(enabled = !sending, onClick = {
                sending = true
                scope.launch {
                    try {
                        val made = app.client?.post("/api/team/tasks", body as Json.Obj)
                        app.refresh()
                        made?.get("task")?.get("id")?.string?.let(opened) ?: done()
                    } catch (e: NodeError) {
                        said = e.message
                    } finally {
                        sending = false
                    }
                }
            }) { Text("Give it again") }
        },
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}
