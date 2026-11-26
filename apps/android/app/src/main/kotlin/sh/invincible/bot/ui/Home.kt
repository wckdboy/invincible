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
import sh.invincible.bot.core.AgentMark
import androidx.compose.foundation.layout.width

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
fun HomeScreen(app: AppModel, nav: Nav, drawer: (() -> Unit)?, search: () -> Unit, places: () -> Unit, give: () -> Unit) {
    val table by app.table.collectAsState()
    val live by app.chat.live.collectAsState()
    val problem by app.problem.collectAsState()
    val usage by app.usage.collectAsState()
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
    val said = work?.let { Work.atAGlance(it.working, needs, table.primary.line) } ?: Work.Glance(table.primary.line, false)
    // What the node's model calls cost today, after what needs you and what is at work (the iPhone's line).
    val spent = usage?.takeIf { it.spentUsd > 0 && said.text != table.primary.line }?.let { "${if (it.complete) "" else "at least "}${sh.invincible.bot.core.Usage.usd(it.spentUsd)} ${if (it.per == "day") "today" else "this month"}" }
    val glance = if (spent != null) Work.Glance("${said.text} · $spent", said.needs) else said
    Column(Modifier.fillMaxSize().imePadding()) {
        HomeHead(glance, drawer = drawer, open = { app.chat.fresh(); nav.go("chat") }, places = places)
        val shown = work?.let { Work.inProject(it, filtered?.takeIf { key -> it.projects.any { p -> p.key == key } }) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s6)) {
            problem?.let { p -> item(key = "problem") { Refused(app, p) } }
            table.asOf?.takeIf { waited }?.let { at ->
                item(key = "kept") {
                    val ago = if (now - at < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(at, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Text("As your node last said it, $ago. Asking it again.", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1))
                }
            }
            // (On a phone, notifications are asked for in the drawer, once, never as a card here; a wide screen has no drawer.)
            if (drawer == null) item(key = "reach") { ReachCard(app) }
            // The agents, each a tap from here: their marks the only colour on the page.
            item(key = "agents") { AgentStrip(app) { nav.go(Nav.agent(it)) } }
            if (work == null) {
                item(key = "wait") {
                    Text(if (problem != null) "The work can't be read just now." else "Asking your node…", style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.margin))
                }
                return@LazyColumn
            }
            item(key = "needs") { NeedsYou(app, work, openTask = { nav.go(Nav.task(it)) }, openAll = { nav.go("inbox") }, watch = { nav.go("mac:$it") }) }
            if (work.projects.size > 1) item(key = "filters") { ProjectFilters(work.projects, filtered) { filtered = it } }
            // The work by proof: in hand first (a running task one tap from here), then proven, then failed; the rest folds.
            val groups = Work.ByProof(shown!!)
            fun section(key: String, title: String, rows: List<Work.Row>, failed: Boolean = false) {
                if (rows.isEmpty()) return
                item(key = "$key-head") { SectionHead(title, rows.size, tone = if (failed) brand.danger else null) }
                items(rows, key = { "$key:${it.id}" }) { row ->
                    Column {
                        Hairline(inset = Space.margin)
                        WorkRow(row, onOpen = { nav.go(Nav.task(row.id)) })
                    }
                }
            }
            section("working", "Working", groups.working)
            section("proven", "Proven", groups.proven)
            section("failed", "Failed", groups.failed, failed = true)
            if (groups.done.isNotEmpty()) {
                item(key = "done-head") {
                    Column {
                        Hairline(inset = Space.margin)
                        FoldHead("Done", groups.done.size, doneOpen, onToggle = { doneOpen = !doneOpen })
                    }
                }
                if (doneOpen) items(groups.done, key = { "d:${it.id}" }) { row ->
                    Column {
                        Hairline(inset = Space.margin)
                        WorkRow(row, onOpen = { nav.go(Nav.task(row.id)) })
                    }
                }
            }
            if (groups.empty && shown.needs.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (filtered != null) "Nothing in this project." else "Nothing under way. Ask ${Primary.name} below, or give an agent a task: each is a row here, from its first step to its proof.",
                        style = Type.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(Space.margin),
                    )
                }
            }
        }
        if (live) {
            // While it answers in the chat you left, the bar is that chat's: a press shows it.
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
            // The bar: search and ask, the message box, a task to give. (A task is given once the node has answered: never
            // from the agents this phone kept.)
            HomeBar(app, search = search, give = give, canGive = table.asOf == null, sent = { nav.go("chat") })
        }
    }
}

/**
 * Its header: the I-beam (the primary, in ink: on a phone, a tap opens the drawer), its name and the line at a glance (in
 * full ink and weight when something needs you), a tap on which opens its own conversation. On a wide screen, which has its
 * sidebar and no drawer, "…" for everything else. The machine is named in the drawer, and only when something is off.
 */
@Composable
private fun HomeHead(glance: Work.Glance, drawer: (() -> Unit)?, open: () -> Unit, places: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier.fillMaxWidth().padding(start = Space.s1, end = Space.s1, top = Space.s2, bottom = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s1),
    ) {
        if (drawer != null) {
            IconButton(onClick = drawer, modifier = Modifier.size(Space.touch).semantics { contentDescription = "Everything: the drawer" }) { PrimaryMark(36.dp) }
        } else {
            Box(Modifier.size(Space.touch), contentAlignment = Alignment.Center) { PrimaryMark(36.dp) }
        }
        Column(
            Modifier
                .weight(1f)
                .clip(MaterialTheme.shapes.medium)
                .clickable(onClick = open)
                .clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = "${Primary.name}: ${glance.text}. Ask it"
                }
                .padding(horizontal = Space.s2, vertical = Space.s1),
        ) {
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
        if (drawer == null) IconButton(onClick = places, modifier = Modifier.semantics { contentDescription = "Everything else" }) { Icon(MoreIcon, null) }
    }
}

/**
 * The agents in a strip, each its mark (still, its state in its shape), its name and its state in a word (red only where
 * it failed): a tap opens its page. The primary is the I-beam above, never here.
 */
@Composable
private fun AgentStrip(app: AppModel, open: (String) -> Unit) {
    val table by app.table.collectAsState()
    val brand = LocalBrand.current
    val agents = table.rows.filter { it.kind == "agent" }
    if (agents.isEmpty()) return
    androidx.compose.foundation.lazy.LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Space.s2),
        modifier = Modifier.fillMaxWidth().padding(vertical = Space.s1),
    ) {
        items(agents, key = { it.id }) { row ->
            val word = row.state?.words
            Column(
                Modifier
                    .width(84.dp)
                    .clip(MaterialTheme.shapes.medium)
                    .clickable { open(row.id) }
                    .clearAndSetSemantics {
                        role = Role.Button
                        contentDescription = listOfNotNull(row.name, word).joinToString(", ")
                    }
                    .padding(vertical = Space.s2),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                AgentMarkView(row.id, row.avatar, 44.dp, state = AgentMark.state(row.state))
                Spacer(Modifier.size(Space.s1))
                Text(row.name, style = Type.rowTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    word ?: " ",
                    style = Type.meta,
                    color = when (row.state) { AgentState.FAILED -> brand.danger; AgentState.NEEDS, AgentState.WORKING -> brand.ink; else -> brand.quiet },
                    fontWeight = if (row.state == AgentState.NEEDS) androidx.compose.ui.text.font.FontWeight.SemiBold else null,
                    maxLines = 1,
                )
            }
        }
    }
}

/**
 * The bar at Home's foot (the iPhone's): search and ask, the primary's message box, where what you write starts a
 * conversation with it (the one you had open stays among your chats), and a task to give. [sent]: it went, and its answer
 * is coming in that conversation.
 */
@Composable
private fun HomeBar(app: AppModel, search: () -> Unit, give: () -> Unit, canGive: Boolean, sent: () -> Unit) {
    val brand = LocalBrand.current
    MessageDock(
        placeholder = "Ask ${Primary.name}…",
        key = "home",
        before = {
            IconButton(onClick = search, modifier = Modifier.size(Space.touch).clip(CircleShape).border(BorderStroke(1.dp, brand.line), CircleShape).semantics { contentDescription = "Search, or ask" }) { Icon(SearchIcon, null) }
        },
        after = {
            IconButton(onClick = give, enabled = canGive, modifier = Modifier.size(Space.touch).clip(CircleShape).border(BorderStroke(1.dp, brand.line), CircleShape).semantics { contentDescription = "Give a task" }) { Icon(PlusIcon, null) }
        },
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
