@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary

/**
 * Where you are, as an address, and where you came from: the primary's conversation at the root (the owner's word, 27
 * November 2026: the app opens on it, as Grok Bot's and OpenMausBot's do, the roster a drawer beside it), then each page you
 * opened from it. Every page the app has is one of these, so anything that opens one (a tap, a notification, a link) opens
 * it the same way: "chat", "home" (the work), "task:<id>", "agent:<handle>", "room:<id>", "agents", "inbox", "settings",
 * "keys", "connectors", "mac:<node>", "desktop:<handle>", "terminal:<sandbox>". Kept across a rotation.
 */
@Stable
class Nav(private val stack: MutableState<List<String>>) {
    val top: String get() = stack.value.last()
    val depth: Int get() = stack.value.size

    /** The page under the top one (what Back returns to). */
    val under: String? get() = stack.value.getOrNull(stack.value.size - 2)

    /** Opens a page over this one (Back returns here). The same page twice in a row is opened once. */
    fun go(address: String) {
        if (top != address) stack.value = stack.value + address
    }

    /** Opens a page straight from the root (the roster's row, a notification, the "…" sheet's places): Back returns to the
     * primary's conversation. */
    fun open(address: String) {
        stack.value = if (address == ROOT) listOf(ROOT) else listOf(ROOT, address)
    }

    /** Back: the page under this one. False at the root. */
    fun back(): Boolean {
        if (stack.value.size <= 1) return false
        stack.value = stack.value.dropLast(1)
        return true
    }

    /** Replaces the top page (a page that turns into another: a task given again opens the new one). */
    fun replace(address: String) {
        stack.value = stack.value.dropLast(1) + address
    }

    companion object {
        /** Where the app opens, and Back ends: the primary's conversation. */
        const val ROOT = "chat"
        /** The work's address (it was Home): what needs you and every task, from the roster's foot. */
        const val HOME = "home"
        fun task(id: String) = "task:$id"
        fun agent(id: String) = "agent:$id"
        fun room(id: String) = "room:$id"
    }
}

/** A place under "…": its icon, its name, what is there, and its address (or an action). */
private class Place(val icon: ImageVector, val label: String, val about: String, val trail: String? = null, val go: () -> Unit)

/**
 * Everything else, under "…" (your words, 26 November 2026: on a phone no tab bar, "a '…' sheet for everything else"): a
 * task to give and a new conversation with it at its head, then every place, each with a line saying what is there.
 */
@Composable
fun PlacesSheet(app: AppModel, nav: Nav, give: () -> Unit, close: () -> Unit) {
    val inbox by app.inbox.collectAsState()
    val needsYou by app.needsYou.collectAsState()
    val go = { address: String ->
        close()
        nav.open(address)
    }
    val actions = listOf(
        Place(LayersIcon, "Give a task", "The agent best suited to it takes it, or one you name") { close(); give() },
        Place(ComposeIcon, "Ask ${Primary.name}", "A new conversation with ${Primary.name}") { app.chat.fresh(); go("chat") },
    )
    val places = listOf(
        // (Search was Home's bar's: the app opens on the primary's conversation now.)
        Place(SearchIcon, "Search", "Your tasks, chats, agents and places") { go("search") },
        Place(agentsIcon, "Agents", "Your agents, what each is doing, and their rooms") { go("agents") },
        // (Its badge is what needs you, the one count Home says too: what it noticed is news, counted nowhere.)
        Place(TrayIcon, "Needs you", "Everything that waits for you, and what your node noticed", trail = if (needsYou > 0) AppModel.badge(needsYou) else null) { go("inbox") },
        Place(ChatsIcon, "Chats", "Your conversations with ${Primary.name}") { go("chats") },
        Place(KeyIcon, "Keys", "Your providers' and services' keys, sealed") { go("keys") },
        Place(PlugIcon, "Connectors", "Mail, calendars, GitHub and MCP servers") { go("connectors") },
        Place(GearIcon, "Settings", "Notifications, this phone, your node, updates") { go("settings") },
    )
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberFullSheet(), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = Space.s4)) {
            Text("Everything else", style = Type.title, modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2).semantics { heading() })
            for (p in actions) PlaceRow(p)
            Hairline(Modifier.padding(vertical = Space.s2), inset = Space.margin)
            for (p in places) PlaceRow(p)
        }
    }
}

@Composable
private fun PlaceRow(p: Place) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = p.go)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = listOfNotNull(p.label, p.trail?.let { "$it waiting" }, p.about).joinToString(", ")
            }
            .heightIn(min = 56.dp)
            .padding(horizontal = Space.margin, vertical = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s4),
    ) {
        Icon(p.icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurface)
        Column(Modifier.weight(1f)) {
            Text(p.label, style = Type.rowTitle)
            Text(p.about, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        p.trail?.let {
            Box(Modifier.padding(start = Space.s1)) { Text(it, style = Type.word, color = LocalBrand.current.needs) }
        }
        Icon(ChevronIcon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
