@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/*
 * Home: the primary, first (your words, 26 November 2026: "agent first (the primary)"; on a phone no tab bar, "a '…' sheet for
 * everything else"). Its mark, the one that moves on the screen, its name and a line of how things stand, the machine it
 * runs on, and "…". Then what needs you, each with its answer in place (Needs.kt); then the work in one list by attention
 * (what is new to you, then what is at work, quieter; what is settled folds), each task a row of three lines that opens
 * its thread, with a filter for each project; and its message box docked at the foot, where whatever you ask it starts a
 * conversation with it. The phone opens here; a tablet has it beside the same work in its sidebar. The web's home.ts.
 * (What happened while you were away is where the web has it: at the head of a new conversation with it.)
 */

/** The project the list is filtered to, while the app is open (null: every project). */
private var filtered by mutableStateOf<String?>(null)

/** Whether Home's Done section is open (as the sidebar's folds, kept while the app is open). */
internal var doneOpen by mutableStateOf(false)

@Composable
fun HomeScreen(app: AppModel, nav: Nav, places: () -> Unit, give: () -> Unit) {
    val table by app.table.collectAsState()
    val live by app.chat.live.collectAsState()
    val problem by app.problem.collectAsState()
    val work = rememberWork(app)
    val brand = LocalBrand.current
    // Its line from the agents this phone kept (KeptTable), until the node answers: after a moment, a still line says
    // so, so what Home shows is never taken for what the node says now.
    var waited by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(table.asOf) {
        waited = false
        if (table.asOf != null) {
            kotlinx.coroutines.delay(1_500)
            waited = true
            while (true) {
                now = System.currentTimeMillis()
                kotlinx.coroutines.delay(60_000)
            }
        }
    }
    // (The one count of what needs you, as every place says it: AppModel.needsYou.)
    val needs by app.needsYou.collectAsState()
    val glance = work?.let { Work.atAGlance(it.working, needs, table.primary.line) } ?: Work.Glance(table.primary.line, false)
    Column(Modifier.fillMaxSize().imePadding()) {
        HomeHead(app, glance, open = { app.chat.fresh(); nav.go("chat") }, settings = { nav.go("settings") }, places = places)
        val shown = work?.let { Work.inProject(it, filtered?.takeIf { key -> it.projects.any { p -> p.key == key } }) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s6)) {
            problem?.let { p -> item(key = "problem") { Refused(app, p) } }
            table.asOf?.takeIf { waited }?.let { at ->
                item(key = "kept") {
                    val ago = if (now - at < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(at, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Text("As your node last said it, $ago. Asking it again.", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1))
                }
            }
            item(key = "reach") { ReachCard(app) }
            if (work == null) {
                item(key = "wait") {
                    Text(if (problem != null) "The work can't be read just now." else "Asking your node…", style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.margin))
                }
                return@LazyColumn
            }
            item(key = "needs") { NeedsYou(app, work, openTask = { nav.go(Nav.task(it)) }, openAll = { nav.go("inbox") }, watch = { nav.go("mac:$it") }) }
            item(key = "work-head") {
                Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                    Text("Work", style = Type.title, modifier = Modifier.padding(start = Space.margin, end = Space.margin, top = Space.s4).semantics { heading() })
                    ProjectFilters(work.projects, filtered) { filtered = it }
                }
            }
            val rows = shown!!.active + shown.working
            items(rows, key = { "r:${it.id}" }) { row ->
                Column {
                    Hairline(inset = Space.margin)
                    WorkRow(row, onOpen = { nav.go(Nav.task(row.id)) })
                }
            }
            if (shown.done.isNotEmpty()) {
                item(key = "done-head") {
                    Column {
                        Hairline(inset = Space.margin)
                        FoldHead("Done", shown.done.size, doneOpen, onToggle = { doneOpen = !doneOpen })
                    }
                }
                if (doneOpen) items(shown.done, key = { "d:${it.id}" }) { row ->
                    Column {
                        Hairline(inset = Space.margin)
                        WorkRow(row, onOpen = { nav.go(Nav.task(row.id)) })
                    }
                }
            }
            if (rows.isEmpty() && shown.done.isEmpty() && shown.needs.isEmpty()) {
                item(key = "empty") {
                    Column(Modifier.fillMaxWidth().padding(Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                        Text(
                            if (filtered != null) "Nothing in this project." else "Nothing under way. Ask ${Primary.name} below, or give an agent a task: each is a row here, from its first step to verified.",
                            style = Type.body,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (filtered == null && table.asOf == null) OutlinedButton(onClick = give, border = BorderStroke(1.dp, brand.line), modifier = Modifier.heightIn(min = Space.touch)) {
                            Icon(LayersIcon, null, Modifier.size(18.dp))
                            Spacer(Modifier.size(Space.s2))
                            Text("Give a task")
                        }
                    }
                }
            }
        }
        if (live) {
            // While it answers in the chat you left, the box is that chat's: a press shows it.
            val title by app.chat.title.collectAsState()
            Row(
                Modifier.fillMaxWidth().clickable { nav.go("chat") }.semantics(mergeDescendants = true) { role = Role.Button }.heightIn(min = 56.dp).padding(horizontal = Space.margin, vertical = Space.s3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.s2),
            ) {
                Dot(brand.working)
                Text(title?.let { "Answering in “$it”" } ?: "Answering", style = Type.body, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("Show", style = Type.word, color = brand.ink)
            }
        } else {
            // (A task is given once the node has answered: never from the agents this phone kept.)
            Dock(app, give = give, canGive = table.asOf == null, sent = { nav.go("chat") })
        }
    }
}

/**
 * Its header: the I-beam (the primary, in ink), its name and the line at a glance (in full ink and weight when something
 * needs you), the machine it runs on (its dot says how the fleet stands), and "…" for everything else. Its mark and name
 * open its own conversation.
 */
@Composable
private fun HomeHead(app: AppModel, glance: Work.Glance, open: () -> Unit, settings: () -> Unit, places: () -> Unit) {
    val brand = LocalBrand.current
    val paired by app.paired.collectAsState()
    val fleet by app.fleet.collectAsState()
    Row(
        Modifier.fillMaxWidth().padding(start = Space.s3, end = Space.s1, top = Space.s2, bottom = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        Row(
            Modifier
                .weight(1f)
                .clip(MaterialTheme.shapes.medium)
                .clickable(onClick = open)
                .clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = "${Primary.name}: ${glance.text}. Ask it"
                }
                .padding(Space.s1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s3),
        ) {
            PrimaryMark(40.dp)
            Column(Modifier.weight(1f)) {
                Text(Primary.name, style = Type.display, maxLines = 1)
                Text(
                    glance.text,
                    style = Type.meta.copy(fontSize = Type.body.fontSize),
                    color = if (glance.needs) brand.needs else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (glance.needs) androidx.compose.ui.text.font.FontWeight.SemiBold else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
        // The machine it runs on, by its name; its dot says how the fleet stands once it answers.
        val self = paired?.nodeName ?: paired?.fleetName ?: "This node"
        val tone = fleet?.let { if (it.online == it.nodes) brand.done else if (it.online == 0) brand.failed else brand.needs }
        Row(
            Modifier
                .clip(CircleShape)
                .border(BorderStroke(1.dp, brand.line), CircleShape)
                .clickable(onClick = settings)
                .clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = fleet?.let { "$self: ${it.online} of ${it.nodes} machines online" } ?: self
                }
                .heightIn(min = 32.dp)
                .padding(horizontal = Space.s3, vertical = Space.s1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // (A dot only where something is off, and its words beside it: never the colour alone.)
            val off = fleet?.let { if (it.online == 0) "offline" else if (it.online < it.nodes) "${it.online} of ${it.nodes} online" else null }
            if (off != null) Dot(tone ?: MaterialTheme.colorScheme.onSurfaceVariant, size = 7)
            Text(listOfNotNull(self, off).joinToString(" · "), style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
        }
        IconButton(onClick = places, modifier = Modifier.semantics { contentDescription = "Everything else" }) { Icon(MoreIcon, null) }
    }
}

/**
 * Its message box, docked at the foot (as the web's): "+" gives a task, and what you write starts a conversation with it
 * (the one you had open stays among your chats). [sent]: it went, and its answer is coming in that conversation.
 */
@Composable
private fun Dock(app: AppModel, give: () -> Unit, canGive: Boolean, sent: () -> Unit) {
    MessageDock(
        placeholder = "Ask ${Primary.name}…",
        key = "home",
        lead = { IconButton(onClick = give, enabled = canGive, modifier = Modifier.semantics { contentDescription = "Give a task" }) { Icon(PlusIcon, null) } },
    ) { words ->
        app.chat.fresh()
        app.chat.send(words)
        sent()
        true
    }
}

/** Centred words where a page has nothing to show yet: what is there, or what is being asked. */
@Composable
fun Waiting(text: String) {
    Box(Modifier.fillMaxWidth().padding(Space.s8), contentAlignment = Alignment.Center) {
        Text(text, style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}
