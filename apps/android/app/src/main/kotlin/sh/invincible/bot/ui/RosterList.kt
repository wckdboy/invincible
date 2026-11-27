package sh.invincible.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Primary

/*
 * The roster (the owner's word, 27 November 2026: "something like t3code on desktop, and openmausbot/grokbot on mobile";
 * the web's views/sidebar.ts): what needs you first, with its count; your agent, with its line; then each agent (its mark,
 * its state in its shape, its name and its latest line, muted) and each room. At its foot the work, Settings, everything
 * else and the machine it talks to. A phone's drawer and a tablet's sidebar are the same list, drawn from the table the
 * phone has (the one it kept, until the node answers: AppModel.table), so it is whole the moment it opens.
 */

/** The roster's list: what needs you, your agent, the agents and the rooms. [current] is the page open (Nav's address),
 * marked; [go] opens a place by its address. [trailing] closes the list (a phone's drawer asks for notifications there). */
@Composable
fun RosterList(app: AppModel, current: String, go: (String) -> Unit, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    val table by app.table.collectAsState()
    val needsYou by app.needsYou.collectAsState()
    val live by app.chat.live.collectAsState()
    val agents = table.rows.filter { it.kind == "agent" }
    val rooms = table.rows.filter { it.kind == "room" }
    // (A task's thread marks its agent's row, as the web's roster does.)
    val marked = current.removePrefix("task:").takeIf { current.startsWith("task:") }?.let { id -> table.tasks.firstOrNull { it.id == id }?.assignee?.let(Nav::agent) } ?: current
    Column(modifier.verticalScroll(rememberScrollState())) {
        // (Always there, so its count coming moves nothing under it.)
        RosterPlace(TrayIcon, "Needs you", count = needsYou.takeIf { it > 0 }, selected = current == "inbox") { go("inbox") }
        RosterSeat(
            name = Primary.name,
            line = table.primary.line,
            state = if (live) AgentState.WORKING else table.primary.state,
            needs = table.primary.tone == "warn",
            selected = current == Nav.ROOT,
            face = { PrimaryMark(24.dp) },
        ) { go(Nav.ROOT) }
        if (agents.isNotEmpty()) {
            RosterHeading("Agents")
            for (row in agents) {
                RosterSeat(row.name, row.line, row.state, row.needs, selected = marked == Nav.agent(row.id), face = { Face(row.id, row.avatar, 24.dp, state = AgentMark.state(row.state), description = null) }) {
                    go(Nav.agent(row.id))
                }
            }
        }
        if (rooms.isNotEmpty()) {
            RosterHeading("Rooms")
            for (row in rooms) {
                RosterSeat(row.name, row.line, row.state, row.needs, selected = current == Nav.room(row.id), face = { Text("#", style = Type.rowTitle, color = MaterialTheme.colorScheme.onSurfaceVariant) }) {
                    go(Nav.room(row.id))
                }
            }
        }
        trailing()
    }
}

/** The roster's foot: the work, Settings, everything else, and the machine it talks to (a word beside it only where something
 * is off: never the colour alone), unless its head names it already ([machine] false: a phone's drawer). */
@Composable
fun RosterFoot(app: AppModel, current: String, go: (String) -> Unit, places: () -> Unit, machine: Boolean = true) {
    val paired by app.paired.collectAsState()
    val fleet by app.fleet.collectAsState()
    val brand = LocalBrand.current
    // A newer build out (Updates: its feed asked once a day; a developer's build asks nothing): said at the foot's head
    // until it's taken, in ink; Settings has its download.
    val context = androidx.compose.ui.platform.LocalContext.current
    var newer by remember { mutableStateOf<sh.invincible.bot.app.Updates.Newer?>(null) }
    LaunchedEffect(Unit) { newer = sh.invincible.bot.app.Updates.newer(context) }
    Column(Modifier.fillMaxWidth().padding(bottom = Space.s1)) {
        Hairline(Modifier.padding(bottom = Space.s1))
        if (newer != null) RosterPlace(UpdateIcon, "Update Invincible", selected = current == "settings") { go("settings") }
        RosterPlace(LayersIcon, "Work", quiet = true, selected = current == Nav.HOME) { go(Nav.HOME) }
        RosterPlace(GearIcon, "Settings", quiet = true, selected = current == "settings") { go("settings") }
        RosterPlace(MoreIcon, "Everything else", quiet = true, onClick = places)
        if (!machine) return@Column
        val self = paired?.nodeName ?: paired?.fleetName ?: "This node"
        val off = fleet?.let { if (it.online == 0) "offline" else if (it.online < it.nodes) "${it.online} of ${it.nodes} online" else null }
        Row(
            Modifier
                .padding(start = Space.s3, top = Space.s1)
                .clip(CircleShape)
                .clickable { go("settings") }
                .clearAndSetSemantics {
                    role = Role.Button
                    contentDescription = fleet?.let { "$self: ${it.online} of ${it.nodes} machines online" } ?: self
                }
                .heightIn(min = Space.touch)
                .padding(horizontal = Space.s2),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (off != null) Dot(if (fleet?.online == 0) brand.failed else brand.needs, size = 7)
            Text(listOfNotNull(self, off).joinToString(" · "), style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
        }
    }
}

/** A heading over a group (Agents, Rooms), small and quiet. */
@Composable
private fun RosterHeading(text: String) {
    Text(text, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = Space.margin, top = Space.s4, bottom = Space.s1).semantics { heading() })
}

/** One seat in the roster: its mark, its name, and its latest line (muted; in ink while it needs you, red once it failed). */
@Composable
private fun RosterSeat(name: String, line: String, state: AgentState?, needs: Boolean, selected: Boolean, face: @Composable () -> Unit, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.s2)
            .clip(MaterialTheme.shapes.medium)
            .background(if (selected) brand.raised else Color.Transparent)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(name, state?.words, line.takeIf { it.isNotEmpty() }).distinct().joinToString(", ")
                if (selected) this.selected = true
            }
            .heightIn(min = 52.dp)
            .padding(horizontal = Space.s2, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { face() }
        Column(Modifier.weight(1f)) {
            Text(name, style = Type.rowTitle.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (line.isNotEmpty()) {
                val tone = when {
                    state == AgentState.FAILED -> brand.failed
                    needs -> brand.ink
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(line, style = Type.meta, color = tone, fontWeight = if (needs) FontWeight.SemiBold else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** A place in the roster: its icon in a column of its own, its name, and its count where it counts (in ink and weight). */
@Composable
private fun RosterPlace(icon: ImageVector, label: String, count: Int? = null, quiet: Boolean = false, selected: Boolean = false, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.s2)
            .clip(MaterialTheme.shapes.medium)
            .background(if (selected) brand.raised else Color.Transparent)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(label, count?.let { "$it waiting" }).joinToString(", ")
                if (selected) this.selected = true
            }
            .heightIn(min = Space.touch)
            .padding(horizontal = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = if (quiet) brand.quiet else MaterialTheme.colorScheme.onSurface)
        }
        Text(label, style = Type.rowTitle, color = if (quiet) brand.quiet else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        count?.let { Text("$it", style = Type.word, color = brand.ink) }
        Spacer(Modifier.width(Space.s1))
    }
}
