package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Orb
import sh.invincible.bot.core.OrbMotion
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.Primary

/*
 * A wide screen's sidebar, as T3 Code's (your words, 26 November 2026: "agent first (the primary), and project/tasks/coding
 * t3code style for the agents"): the mark, a task to give and the sidebar folded away; the primary's row pinned, its orb and
 * what it is doing (it opens its own conversation); then the work in one list by attention, every task a row of three
 * lines: what needs you, what is new to you, what is at work (folded), what is settled (folded); and at its foot the
 * agents, the machine it talks to, and everything else ("…"). It asks the node nothing of its own. The web's sidebar.ts.
 */

/** Which of the sidebar's folds are open (kept while the app is open). */
private var workingOpen by mutableStateOf(false)
private var doneOpenSide by mutableStateOf(false)

@Composable
fun Sidebar(app: AppModel, nav: Nav, give: () -> Unit, places: () -> Unit, collapse: () -> Unit) {
    val table by app.table.collectAsState()
    val inbox by app.inbox.collectAsState()
    val paired by app.paired.collectAsState()
    val fleet by app.fleet.collectAsState()
    val live by app.chat.live.collectAsState()
    val work = rememberWork(app)
    val brand = LocalBrand.current
    val top = nav.top
    val current = top.removePrefix("task:").takeIf { top.startsWith("task:") }
    Column(Modifier.width(Space.sidebar).fillMaxHeight().background(brand.paper)) {
        // ---- the head: the mark, a task to give, the sidebar folded away ----
        Row(Modifier.fillMaxWidth().padding(start = Space.s4, end = Space.s1, top = Space.s2), verticalAlignment = Alignment.CenterVertically) {
            // The app's mark (AppMark: the icon's field on nothing, so no tile sits on a light page), then the wordmark.
            AppMark(20.dp)
            Spacer(Modifier.width(9.dp))
            Text("INVINCIBLE", style = Type.section.copy(letterSpacing = 2.4.sp), modifier = Modifier.weight(1f).semantics { contentDescription = "Invincible" })
            IconButton(onClick = give, enabled = table.asOf == null, modifier = Modifier.semantics { contentDescription = "Give a task" }) { Icon(ComposeIcon, null, Modifier.size(20.dp)) }
            IconButton(onClick = collapse, modifier = Modifier.semantics { contentDescription = "Hide the sidebar" }) { Icon(PanelIcon, null, Modifier.size(20.dp)) }
        }
        // ---- the primary, pinned: its orb still beside a pane with orbs of its own, moving as it does beside any other ----
        val standing = if (live) AgentState.WORKING else table.primary.state
        val elsewhere = top == Nav.HOME || top == "chat" || top == "agents" || top.startsWith("task:") || top.startsWith("agent:")
        val line = table.primary.line
        Row(
            Modifier
                .padding(horizontal = Space.s3, vertical = Space.s2)
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.large)
                .border(BorderStroke(1.dp, brand.line), MaterialTheme.shapes.large)
                .background(if (top == "chat") brand.raised else brand.paper)
                .clickable { app.chat.fresh(); nav.open("chat") }
                .clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = "${Primary.name}: $line"
                    if (top == "chat") selected = true
                }
                .padding(Space.s3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s3),
        ) {
            PrimaryOrb(34.dp, if (elsewhere) null else OrbMotion.mood(standing), key = "primary:side")
            Column(Modifier.weight(1f)) {
                Text(Primary.name, style = Type.rowTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold))
                Text(line, style = Type.meta, color = when (Orb.tone(table.primary.state)) { Orb.Tone.WARN -> brand.needs; Orb.Tone.ACCENT -> brand.working; Orb.Tone.OK -> brand.done; else -> MaterialTheme.colorScheme.onSurfaceVariant }, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        // ---- the work, by attention ----
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            if (work == null) {
                item { Text(if (app.problem.value != null) "The work can't be read just now." else "Asking your node…", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.s4)) }
                return@LazyColumn
            }
            val beyond = Work.inboxBeyond(inbox.count, app.asks(), work.needs)
            val needs = work.needs.size + beyond
            if (needs > 0) {
                item(key = "needs-head") { SectionHead("Needs you", needs, brand.needs) }
                if (beyond > 0) item(key = "inbox") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .then(if (top == "inbox") Modifier.background(brand.raised) else Modifier)
                            .clickable { nav.open("inbox") }
                            .clearAndSetSemantics { role = Role.Button; contentDescription = "Inbox, $beyond waiting" }
                            .heightIn(min = Space.touch)
                            .padding(horizontal = Space.s4),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.s2),
                    ) {
                        Icon(TrayIcon, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("Inbox", style = Type.rowTitle, modifier = Modifier.weight(1f))
                        Text("$beyond waiting", style = Type.word, color = brand.needs)
                    }
                }
                items(work.needs, key = { "n:${it.id}" }) { row -> WorkRow(row, { nav.open(Nav.task(row.id)) }, face = 16.dp, current = row.id == current, inset = Space.s4) }
            }
            if (work.active.isNotEmpty()) {
                item(key = "active-head") { SectionHead("Active") }
                items(work.active, key = { "a:${it.id}" }) { row -> WorkRow(row, { nav.open(Nav.task(row.id)) }, face = 16.dp, current = row.id == current, inset = Space.s4) }
            }
            if (work.working.isNotEmpty()) {
                item(key = "working-head") { FoldHead("Working", work.working.size, workingOpen, { workingOpen = !workingOpen }, inset = Space.s4) }
                // A folded section still shows the task that is open now, as T3 Code's does.
                items(if (workingOpen) work.working else work.working.filter { it.id == current }, key = { "w:${it.id}" }) { row ->
                    WorkRow(row, { nav.open(Nav.task(row.id)) }, face = 16.dp, current = row.id == current, inset = Space.s4)
                }
            }
            if (work.done.isNotEmpty()) {
                item(key = "done-head") { FoldHead("Done", work.done.size, doneOpenSide, { doneOpenSide = !doneOpenSide }, inset = Space.s4) }
                items(if (doneOpenSide) work.done else work.done.filter { it.id == current }, key = { "d:${it.id}" }) { row ->
                    WorkRow(row, { nav.open(Nav.task(row.id)) }, face = 16.dp, current = row.id == current, inset = Space.s4)
                }
            }
            if (work.empty && needs == 0) item(key = "empty") {
                Text("No tasks yet. Each task you or ${Primary.name} give an agent is a row here: what needs you first, then what is new, at work, and done.", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.s4))
            }
        }
        // ---- the foot: the agents, the machine it talks to, everything else ----
        Hairline()
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.s2, vertical = Space.s1), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s1)) {
            val count = table.snapshot?.agents?.size
            Pill(if (count == null) "Agents" else "Agents $count", agentsIcon, "The agents${count?.let { ": $it" } ?: ""}", top == "agents") { nav.open("agents") }
            val self = paired?.nodeName ?: paired?.fleetName ?: "This node"
            val tone = fleet?.let { if (it.online == it.nodes) brand.done else if (it.online == 0) brand.failed else brand.needs }
            Row(
                Modifier.clip(CircleShape).clickable { nav.open("settings") }.clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = fleet?.let { "$self: ${it.online} of ${it.nodes} machines online" } ?: self
                }.heightIn(min = Space.touch).padding(horizontal = Space.s2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Dot(tone ?: MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f), size = 7)
                Text(fleet?.takeIf { it.nodes > 1 }?.let { "$self · ${it.online}/${it.nodes}" } ?: self, style = Type.meta, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 104.dp))
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = places, modifier = Modifier.semantics { contentDescription = "Everything else: places, settings, this device" }) { Icon(MoreIcon, null) }
        }
    }
}

/** A pill in the sidebar's foot: an icon and a few words, opening a place. */
@Composable
private fun Pill(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .clip(CircleShape)
            .then(if (selected) Modifier.background(brand.raised) else Modifier)
            .clickable(onClick = onClick)
            .clearAndSetSemantics { role = Role.Button; contentDescription = label; if (selected) this.selected = true }
            .heightIn(min = Space.touch)
            .padding(horizontal = Space.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, null, Modifier.size(16.dp))
        Text(text, style = Type.meta)
    }
}
