package sh.invincible.bot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.string
import sh.invincible.bot.core.get

/*
 * The drawer (the iPhone's I9 navigation, 26 November 2026: "Home, a bar and a drawer", no tab bar, Home the primary):
 * everything beyond Home, from the left edge (a swipe from it on Home, or a tap on the I-beam; Back closes it), so every
 * place is two taps from Home: a new chat and your latest chats, what needs you and the agents with their counts, all your
 * chats, keys, connectors and Settings. Notifications are asked for here, once, never as a card on Home. A wide screen has
 * its sidebar instead.
 */

/** The drawer's places. [go] opens one from Home (the drawer closed first); [chat] one of the primary's chats (null: a
 * new one). */
@Composable
fun Drawer(app: AppModel, go: (String) -> Unit, chat: (String?) -> Unit, close: () -> Unit) {
    val needsYou by app.needsYou.collectAsState()
    val table by app.table.collectAsState()
    val paired by app.paired.collectAsState()
    val fleet by app.fleet.collectAsState()
    val chats by app.chat.chats.collectAsState()
    val brand = LocalBrand.current
    // (Your latest chats, read as the drawer opens: they move only as you talk.)
    LaunchedEffect(Unit) { runCatching { app.chat.loadChats() } }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(vertical = Space.s4)) {
        // Its head: the I-beam, the primary's name and the machine it runs on (its state in words where something is off).
        Row(Modifier.fillMaxWidth().padding(start = Space.margin, end = Space.s2), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
            AppMark(36.dp)
            Column(Modifier.weight(1f)) {
                Text(Primary.name, style = Type.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val self = paired?.nodeName ?: paired?.fleetName ?: "Your node"
                val off = fleet?.let { if (it.online == 0) "offline" else if (it.online < it.nodes) "${it.online} of ${it.nodes} online" else null }
                Text(listOfNotNull(self, off).joinToString(" · "), style = Type.meta, color = if (off == "offline") brand.danger else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = close, modifier = Modifier.semantics { contentDescription = "Close" }) { Icon(CloseIcon, null) }
        }
        Spacer(Modifier.size(Space.s3))
        DrawerRow(ComposeIcon, "New chat") { chat(null) }
        for (c in chats.take(5)) {
            val id = c["id"].string ?: continue
            DrawerRow(ChatsIcon, c["title"].string?.takeIf { it.isNotBlank() } ?: "A chat", quiet = true) { chat(id) }
        }
        Hairline(Modifier.padding(vertical = Space.s2), inset = Space.margin)
        DrawerRow(TrayIcon, "Needs you", count = needsYou.takeIf { it > 0 }, strong = true) { go("inbox") }
        DrawerRow(agentsIcon, "Agents", count = table.snapshot?.agents?.size?.takeIf { it > 0 }) { go("agents") }
        DrawerRow(ChatsIcon, "All chats") { go("chats") }
        DrawerRow(KeyIcon, "Keys") { go("keys") }
        DrawerRow(PlugIcon, "Connectors") { go("connectors") }
        DrawerRow(GearIcon, "Settings") { go("settings") }
        // Notifications, asked for here once (the card goes once they are on, or you put it away).
        ReachCard(app)
    }
}

/** A place in the drawer: its icon in a column of its own, its name, and how many where it counts (in ink and weight
 * where something needs you). */
@Composable
private fun DrawerRow(icon: ImageVector, label: String, count: Int? = null, strong: Boolean = false, quiet: Boolean = false, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(label, count?.let { if (strong) "$it waiting" else "$it" }).joinToString(", ")
            }
            .heightIn(min = Space.touch)
            .padding(horizontal = Space.margin),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = if (quiet) brand.quiet else MaterialTheme.colorScheme.onSurface)
        Text(label, style = Type.rowTitle, color = if (quiet) brand.quiet else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        count?.let { Text("$it", style = Type.word, color = if (strong) brand.ink else brand.quiet) }
        Spacer(Modifier.width(Space.s1))
    }
}
