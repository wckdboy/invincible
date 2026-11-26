package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Work

/*
 * The work's rows, as every list of them draws them (a tablet's sidebar, a phone's Home): a task in three lines, as T3
 * Code's sidebar has it (your word, 26 November 2026: "project/tasks/coding t3code style for the agents"): its project's
 * badge and name with how it stands in a word in its state's colour; its title; its agent's orb, still, with its name and
 * what it is doing or what it came to. A row opens the task's own thread. What the rows say is core/Work.kt's; this only
 * draws them. Nothing is asked of the node per row.
 */

/** The minute now, moving on each minute while it is on screen ("4m" ages): what the rows' ages are said against. */
@Composable
fun rememberMinute(): Long {
    val minute = remember { mutableLongStateOf(System.currentTimeMillis() / 60_000) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000 + 50)
            minute.longValue = System.currentTimeMillis() / 60_000
        }
    }
    return minute.longValue
}

/** The work by attention as the app has it now (null: the team isn't known yet). */
@Composable
fun rememberWork(app: AppModel): Work.Attended? {
    val table by app.table.collectAsState()
    val inbox by app.inbox.collectAsState()
    val projects by app.projects.collectAsState()
    val minute = rememberMinute()
    val snapshot = table.snapshot ?: return null
    return remember(table, inbox.actions, projects, minute) {
        Work.attended(snapshot.agents, table.tasks, snapshot.seen, projects, app.asks(), System.currentTimeMillis())
    }
}

/** A row's words, for a screen reader: what it is, where, how it stands and who is on it. */
fun rowLabel(row: Work.Row): String =
    listOfNotNull(row.title, row.project.name, row.word, "${row.agentName}${if (row.detail.isNotEmpty()) ": ${row.detail}" else ""}", row.age?.let { "$it ago" }).joinToString(", ")

/** A project's badge: its letter on a small tile (other work's is an empty, dashed one). */
@Composable
fun ProjectBadge(project: Work.Project, size: Dp = 16.dp) {
    val brand = LocalBrand.current
    val shape = RoundedCornerShape(4.dp)
    Box(
        Modifier
            .defaultMinSize(size, size)
            .clip(shape)
            .then(
                if (project.badge.isEmpty()) {
                    val dash = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                    Modifier.drawBehind {
                        val w = 1.dp.toPx()
                        drawRoundRect(
                            dash,
                            topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2),
                            size = androidx.compose.ui.geometry.Size(this.size.width - w, this.size.height - w),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx()),
                            style = androidx.compose.ui.graphics.drawscope.Stroke(width = w, pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(2.5.dp.toPx(), 2.dp.toPx()))),
                        )
                    }
                } else Modifier.background(brand.ink.copy(alpha = 0.08f)),
            )
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        if (project.badge.isNotEmpty()) Text(project.badge, style = Type.badge, color = brand.ink, modifier = Modifier.padding(horizontal = 3.dp))
    }
}

/** How a row stands in a word, in its state's colour (and verified work with its check): never colour alone. */
@Composable
fun StateWord(row: Work.Row) {
    val brand = LocalBrand.current
    val color = brand.of(row.tone) ?: MaterialTheme.colorScheme.onSurfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        if (row.state == AgentState.VERIFIED) Icon(CheckIcon, null, Modifier.size(14.dp), tint = color)
        Text(row.word, style = Type.word, color = color, maxLines = 1)
    }
}

/**
 * A task as a row of three lines. [face]: its agent's orb's size (14 to 18; still: only the orb in focus moves).
 * [current]: it is the task open now (a wide screen's sidebar marks it). Work in hand that only waits on its agent reads
 * quieter than what is new to you.
 */
@Composable
fun WorkRow(row: Work.Row, onOpen: () -> Unit, face: Dp = 18.dp, current: Boolean = false, inset: Dp = Space.margin) {
    val brand = LocalBrand.current
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    val calm = row.attention == Work.Attention.WORKING
    val big = LocalDensity.current.fontScale > 1.3f
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (current) Modifier.background(brand.raised) else Modifier)
            .clickable(onClick = onOpen)
            .clearAndSetSemantics {
                contentDescription = rowLabel(row)
                role = Role.Button
                if (current) selected = true
            }
            .heightIn(min = Space.touch)
            .padding(horizontal = inset, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ProjectBadge(row.project)
            Text(row.project.name, style = Type.meta, color = quiet, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            StateWord(row)
            row.age?.let { Text(it, style = Type.meta, color = quiet, maxLines = 1) }
        }
        Text(row.title, style = Type.rowTitle, color = if (calm) quiet else MaterialTheme.colorScheme.onSurface, maxLines = if (big) 2 else 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AgentOrb(row.agent, row.avatar, face)
            Text(row.agentName, style = Type.meta, color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (calm) 0.72f else 0.86f), maxLines = 1)
            if (row.detail.isNotEmpty()) Text(row.detail, style = if (row.mono) Type.mono else Type.meta, color = quiet, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
    }
}

/** A hairline between two things in a list (the primary's 1 px borders). */
@Composable
fun Hairline(modifier: Modifier = Modifier, inset: Dp = 0.dp) {
    androidx.compose.material3.HorizontalDivider(modifier.padding(start = inset), thickness = Dp.Hairline, color = LocalBrand.current.line)
}

/** A section's head in a list of the work: its words, in its tone (amber for what needs you), and how many. */
@Composable
fun SectionHead(text: String, count: Int? = null, tone: Color? = null, modifier: Modifier = Modifier) {
    val color = tone ?: MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier.fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s4, bottom = Space.s1).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(text, style = Type.section, color = color)
        count?.let { Text("· $it", style = Type.section.copy(fontFeatureSettings = "tnum"), color = color) }
    }
}

/** A folded section's head (T3's "Done 14 ›"): its words, how many, and a chevron that turns as it opens. */
@Composable
fun FoldHead(text: String, count: Int, open: Boolean, onToggle: () -> Unit, inset: Dp = Space.margin) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .clearAndSetSemantics {
                role = Role.Button
                stateDescription = if (open) "shown" else "folded"
                contentDescription = "$text, $count"
            }
            .heightIn(min = Space.touch)
            .padding(horizontal = inset),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(text, style = Type.section, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text("$count", style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Icon(ChevronIcon, null, Modifier.size(16.dp).rotate(if (open) 90f else 0f), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A filter for each project with work, when there is more than one: All, then each by its badge and name. */
@Composable
fun ProjectFilters(projects: List<Work.Counted>, chosen: String?, choose: (String?) -> Unit) {
    if (projects.size < 2) return
    val brand = LocalBrand.current
    val colors = FilterChipDefaults.filterChipColors(
        containerColor = Color.Transparent,
        labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
        selectedContainerColor = brand.ink,
        selectedLabelColor = brand.onInk,
    )
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Space.margin),
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        FilterChip(selected = chosen == null, onClick = { choose(null) }, label = { Text("All", style = Type.meta) }, colors = colors, border = FilterChipDefaults.filterChipBorder(true, chosen == null, borderColor = brand.line))
        for (p in projects) {
            val on = chosen == p.key
            FilterChip(
                selected = on,
                onClick = { choose(if (on) null else p.key) },
                label = { Text(p.name, style = Type.meta, maxLines = 1) },
                leadingIcon = { ProjectBadge(sh.invincible.bot.core.Work.Project(p.key, p.name, p.badge), 14.dp) },
                colors = colors,
                border = FilterChipDefaults.filterChipBorder(true, on, borderColor = brand.line),
                modifier = Modifier.semantics { contentDescription = "${p.name}, ${p.count} task${if (p.count == 1) "" else "s"}" },
            )
        }
        Spacer(Modifier.width(Space.s2))
    }
}
