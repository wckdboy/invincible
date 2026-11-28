package sh.invincible.bot.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.sp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.get
import sh.invincible.bot.core.long

/*
 * Home (the owner's word, 28 November 2026, after Grok Bot: "like a chat app, with the primary at the top, the other
 * agents, and a settings menu"; I10's page as the lead approved it): a list, as a messaging app's. Its bar: Settings (the
 * gear), "Invincible", and + (a new chat with your agent, or a new agent). Pulled down, a search of agents and chats. Your
 * agent pinned first; then every agent and room by what it last did, the latest first (Roster.homeRows: the PWA's
 * lib/roster.ts homeRows, held to the vectors): its face and how it stands, its name, its latest line, when, and how much
 * waits on you. A row opens its chat. On a tablet the same list is the sidebar, beside the chat open.
 */

/**
 * The list. [open] opens an address (Nav's), [settings] the settings; [current] marks the row of the chat open beside it
 * (a tablet's sidebar; null on a phone, where the list is a page of its own).
 */
@Composable
fun HomeList(app: AppModel, open: (String) -> Unit, settings: () -> Unit, current: String? = null, modifier: Modifier = Modifier) {
    val table by app.table.collectAsState()
    val needsYou by app.needsYou.collectAsState()
    val live by app.chat.live.collectAsState()
    val minute = rememberMinute()
    val now = minute * 60_000
    // (A task's thread marks its agent's row.)
    val marked = current?.removePrefix("task:")?.takeIf { current.startsWith("task:") }?.let { id -> table.tasks.firstOrNull { it.id == id }?.assignee?.let(Nav::agent) } ?: current
    // (The search sits above the first row, out of sight until the list is pulled down, as a messaging app's: the list
    // starts just under it once its rows are there, unless you have moved it.)
    val list = rememberLazyListState()
    LaunchedEffect(current == null && table.home.isNotEmpty()) {
        if (current == null && table.home.isNotEmpty() && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) list.scrollToItem(1)
    }
    Column(modifier.fillMaxSize()) {
        HomeBar(
            settings = settings,
            newChat = {
                app.chat.fresh()
                open("chat")
            },
            // (A new agent is your agent's to make, as you ask it: a new chat, with the ask begun in its message box.)
            newAgent = { app.shared.value = AppModel.Shared("Make me a new agent: ", emptyList()) },
        )
        LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
            item(key = "search") { SearchPill { open("search") } }
            // (Until what needs you is answered in each agent's own chat: the Inbox, while anything waits there.)
            if (needsYou > 0) {
                item(key = "needs") {
                    HomeRowView(
                        name = "Needs you",
                        line = Roster.needsYou(needsYou),
                        time = null,
                        count = needsYou,
                        needs = true,
                        selected = marked == "inbox",
                        face = { Icon(TrayIcon, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurface) },
                    ) { open("inbox") }
                }
            }
            item(key = "primary") {
                // (Its time: now while it works; else its newest answer you haven't read; else none said.)
                val at = if (live || table.primary.state == AgentState.WORKING) now else table.unread.mapNotNull { it["answeredAt"].long }.maxOrNull()
                HomeRowView(
                    name = Primary.name,
                    line = table.primary.line,
                    time = at?.let { Work.shortSpan(now - it) },
                    count = 0,
                    needs = table.primary.tone == "warn",
                    selected = marked == "chat",
                    face = { PrimaryMark(44.dp) },
                ) {
                    // (Your latest kept chat, the first time this session; whatever chat is open after that.)
                    app.chat.openLatest()
                    open("chat")
                }
            }
            items(table.home, key = { it.key }) { row ->
                HomeRowView(
                    name = row.row.name,
                    line = row.row.line,
                    time = Work.shortSpan(now - row.at),
                    count = row.count,
                    needs = row.row.needs,
                    failed = row.row.state == AgentState.FAILED,
                    state = row.row.state,
                    selected = marked == (if (row.row.kind == "agent") Nav.agent(row.row.id) else Nav.room(row.row.id)),
                    face = {
                        if (row.row.kind == "agent") {
                            // (Working moves, by its glow's breath, the render thread's alone; the rest are still.)
                            AgentMarkView(row.row.id, row.row.avatar, 44.dp, state = AgentMark.state(row.row.state), live = row.row.state == AgentState.WORKING)
                        } else {
                            RoomFace()
                        }
                    },
                ) { open(if (row.row.kind == "agent") Nav.agent(row.row.id) else Nav.room(row.row.id)) }
            }
            item(key = "end") { Spacer(Modifier.height(Space.s6)) }
        }
    }
}

/** The list's bar: the settings, the app's name, and + (a new chat, a new agent). */
@Composable
private fun HomeBar(settings: () -> Unit, newChat: () -> Unit, newAgent: () -> Unit) {
    var adding by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = Space.s1), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = settings, modifier = Modifier.semantics { contentDescription = "Settings" }) { Icon(GearIcon, null, Modifier.size(22.dp)) }
        Text(Primary.name, style = Type.title, modifier = Modifier.weight(1f).padding(start = Space.s1).semantics { heading() })
        Box {
            IconButton(onClick = { adding = true }, modifier = Modifier.semantics { contentDescription = "New" }) { Icon(PlusIcon, null, Modifier.size(22.dp)) }
            DropdownMenu(expanded = adding, onDismissRequest = { adding = false }) {
                DropdownMenuItem(text = { Text("New chat") }, leadingIcon = { Icon(ComposeIcon, null) }, onClick = { adding = false; newChat() })
                DropdownMenuItem(text = { Text("New agent") }, leadingIcon = { Icon(agentsIcon, null) }, onClick = { adding = false; newAgent() })
            }
        }
    }
}

/** The search, as a field above the list: a tap opens the search of agents and chats. */
@Composable
private fun SearchPill(open: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.margin, vertical = Space.s2)
            .clip(RoundedCornerShape(12.dp))
            .background(brand.raised)
            .clickable(onClick = open)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = "Search agents and chats"
            }
            .heightIn(min = 44.dp)
            .padding(horizontal = Space.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        Icon(SearchIcon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Search", style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A room's face: what a group is, in a circle of its own. */
@Composable
private fun RoomFace() {
    Box(Modifier.size(44.dp).clip(CircleShape).background(LocalBrand.current.raised), contentAlignment = Alignment.Center) {
        Icon(agentsIcon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * A row, as a messaging app's: its face, its name, its latest line (in ink while it needs you, red once it failed), and at
 * its end when that was, and how much waits on you in an ink capsule. At least 72 dp tall.
 */
@Composable
private fun HomeRowView(
    name: String,
    line: String,
    time: String?,
    count: Int,
    needs: Boolean,
    selected: Boolean,
    face: @Composable () -> Unit,
    failed: Boolean = false,
    state: AgentState? = null,
    onClick: () -> Unit,
) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) brand.raised else Color.Transparent)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(name, state?.words, line.takeIf { it.isNotEmpty() }, count.takeIf { it > 0 }?.let { "$it waiting" }, time).distinct().joinToString(", ")
                if (selected) this.selected = true
            }
            .heightIn(min = 72.dp)
            .padding(horizontal = Space.margin, vertical = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { face() }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = Type.title.copy(fontSize = 17.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (line.isNotEmpty()) {
                val tone = when {
                    failed -> brand.failed
                    needs -> brand.ink
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(line, style = Type.body, color = tone, fontWeight = if (needs) FontWeight.SemiBold else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Column(Modifier.widthIn(min = 28.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            if (time != null) Text(time, style = Type.meta, color = brand.quiet, maxLines = 1)
            if (count > 0) {
                Box(Modifier.clip(CircleShape).background(brand.ink).heightIn(min = 20.dp).widthIn(min = 20.dp).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
                    Text("$count", style = Type.word.copy(fontSize = 12.sp), color = brand.onInk)
                }
            }
        }
    }
}
