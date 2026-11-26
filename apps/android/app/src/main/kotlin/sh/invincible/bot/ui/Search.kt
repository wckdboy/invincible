package sh.invincible.bot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.string
import sh.invincible.bot.core.get

/*
 * Search and ask (the bar's ⌕; the iPhone's Search & ask): one field, and as you type, what it finds among the places,
 * your agents, the work and your chats, each a tap away; first of all, asking the primary what you typed. Before you type,
 * the places, so it is a way round as well.
 */

/** One thing found: what leads it, its words, what it is, and what a tap opens. */
private class Found(val key: String, val icon: ImageVector?, val agent: Pair<String, sh.invincible.bot.core.Json?>?, val title: String, val about: String?, val open: () -> Unit)

@Composable
fun SearchScreen(app: AppModel, nav: Nav, back: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val table by app.table.collectAsState()
    val chats by app.chat.chats.collectAsState()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        focus.requestFocus()
        runCatching { app.chat.loadChats() }
    }
    val q = query.trim()
    val low = q.lowercase()
    fun ask() {
        if (q.isEmpty()) return
        app.chat.fresh()
        app.chat.send(q)
        nav.replace("chat")
    }
    val places = listOf(
        Found("p:inbox", TrayIcon, null, "Needs you", "Everything that waits for you") { nav.replace("inbox") },
        Found("p:agents", agentsIcon, null, "Agents", "Your agents and their rooms") { nav.replace("agents") },
        Found("p:chats", ChatsIcon, null, "All chats", "Your conversations with ${Primary.name}") { nav.replace("chats") },
        Found("p:keys", KeyIcon, null, "Keys", "Your providers' and services' keys") { nav.replace("keys") },
        Found("p:connectors", PlugIcon, null, "Connectors", "Mail, calendars, GitHub and MCP servers") { nav.replace("connectors") },
        Found("p:settings", GearIcon, null, "Settings", "Notifications, this phone, your node") { nav.replace("settings") },
    ).filter { low.isEmpty() || it.title.lowercase().contains(low) }
    val agents = if (low.isEmpty()) emptyList() else (table.snapshot?.agents ?: emptyList())
        .filter { it.name.lowercase().contains(low) || it.role.lowercase().contains(low) }
        .map { a -> Found("a:${a.id}", null, a.id to a.avatar, a.name, a.role) { nav.replace(Nav.agent(a.id)) } }
    val tasks = if (low.isEmpty()) emptyList() else table.tasks
        .filter { it.title.lowercase().contains(low) }
        .sortedByDescending { it.updatedAt }
        .take(20)
        .map { t -> Found("t:${t.id}", LayersIcon, null, t.title, table.snapshot?.agents?.firstOrNull { it.id == t.assignee }?.name ?: t.assignee) { nav.replace(Nav.task(t.id)) } }
    val talked = if (low.isEmpty()) emptyList() else chats
        .filter { (it["title"].string ?: "").lowercase().contains(low) }
        .take(10)
        .mapNotNull { c -> c["id"].string?.let { id -> Found("c:$id", ChatsIcon, null, c["title"].string ?: "A chat", "A chat") { app.chat.open(id); nav.replace("chat") } } }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.s1, vertical = Space.s1), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back, modifier = Modifier.semantics { contentDescription = "Back" }) { Icon(BackIcon, null) }
            TextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search, or ask ${Primary.name}", style = Type.body) },
                textStyle = Type.body,
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { ask() }),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = "Search, or ask ${Primary.name}" },
            )
        }
        Hairline()
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            if (q.isNotEmpty()) item(key = "ask") { FoundRow(Found("ask", ComposeIcon, null, "Ask ${Primary.name}", "“$q”") { ask() }) }
            section("Places", places)
            section("Agents", agents)
            section("Work", tasks)
            section("Chats", talked)
            if (q.isNotEmpty() && places.isEmpty() && agents.isEmpty() && tasks.isEmpty() && talked.isEmpty()) item(key = "none") {
                Text("Nothing here goes by “$q”. Ask ${Primary.name} above.", style = Type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.margin))
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(title: String, found: List<Found>) {
    if (found.isEmpty()) return
    item(key = "h:$title") { SectionHead(title, found.size, modifier = Modifier.semantics { heading() }) }
    items(found, key = { it.key }) { FoundRow(it) }
}

@Composable
private fun FoundRow(f: Found) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = f.open)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(f.title, f.about).joinToString(", ")
            }
            .heightIn(min = 56.dp)
            .padding(horizontal = Space.margin, vertical = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            when {
                f.agent != null -> AgentMarkView(f.agent.first, f.agent.second, 28.dp)
                f.icon != null -> Icon(f.icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurface)
            }
        }
        Column(Modifier.weight(1f)) {
            Text(f.title, style = Type.rowTitle, maxLines = 2, overflow = TextOverflow.Ellipsis)
            f.about?.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.meta, color = brand.quiet, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}
