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
 * The work (Home's address, "home"; the owner's word, 27 November 2026: the app opens on the primary's conversation, and
 * the work is a place the roster's foot opens, as the web's Work): what needs you, each with its answer in place
 * (Needs.kt); then the work in one list by attention (what is new to you, then what is at work, quieter; what is settled
 * folds), each task a row of three lines that opens its thread, with a filter for each project. The web's home.ts.
 */

/** The project the list is filtered to, while the app is open (null: every project). */
private var filtered by mutableStateOf<String?>(null)

/** Whether Home's Done section is open (as the sidebar's folds, kept while the app is open). */
internal var doneOpen by mutableStateOf(false)

@Composable
fun HomeScreen(app: AppModel, nav: Nav, back: () -> Unit) {
    val table by app.table.collectAsState()
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
    // (For the performance runner: Home has its work to show.)
    LaunchedEffect(work != null) { if (work != null) sh.invincible.bot.app.PerfProbe.mark("home usable") }
    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar("Work", back)
        val shown = work?.let { Work.inProject(it, filtered?.takeIf { key -> it.projects.any { p -> p.key == key } }) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.s6)) {
            problem?.let { p -> item(key = "problem") { Refused(app, p) } }
            table.asOf?.takeIf { waited }?.let { at ->
                item(key = "kept") {
                    val ago = if (now - at < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(at, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Text(sh.invincible.bot.core.keptLine(ago, refused = problem?.notYourNode != null), style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1))
                }
            }
            if (work == null) {
                item(key = "wait") {
                    Text(if (problem != null) "The work can't be read just now." else "Asking your node…", style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.margin))
                }
                return@LazyColumn
            }
            item(key = "needs") { NeedsYou(app, work, openTask = { nav.go(Nav.task(it)) }, openAll = { nav.go("inbox") }, watch = { nav.go("mac:$it") }, openConnectors = { nav.go("connectors") }) }
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
                        if (filtered != null) "Nothing in this project." else "Nothing under way. Ask ${Primary.name} in its chat, or give an agent a task: each is a row here, from its first step to its proof.",
                        style = Type.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(Space.margin),
                    )
                }
            }
        }
    }
}

/** Centred words where a page has nothing to show yet: what is there, or what is being asked. */
@Composable
fun Waiting(text: String) {
    Box(Modifier.fillMaxWidth().padding(Space.s8), contentAlignment = Alignment.Center) {
        Text(text, style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}
