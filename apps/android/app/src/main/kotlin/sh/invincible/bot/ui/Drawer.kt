package sh.invincible.bot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary

/*
 * The drawer, a phone's roster (the owner's word, 27 November 2026: Grok Bot's and OpenMausBot's way: the app opens on the
 * primary's conversation and the drawer is everything beside it): its head the I-beam, the primary's name and the machine
 * it runs on; then the roster (RosterList: what needs you, your agent, the agents, the rooms), notifications asked for
 * once at its end; and at its foot the work, Settings and everything else. From the conversation's top-left or a swipe
 * from its left edge; Back closes it. A wide screen has the same roster as its sidebar.
 */

/** The drawer. [current] is the page open, marked; [go] opens a place from the root (the drawer closed first); [places]
 * opens everything else. */
@Composable
fun Drawer(app: AppModel, current: String, go: (String) -> Unit, places: () -> Unit, close: () -> Unit) {
    val paired by app.paired.collectAsState()
    val fleet by app.fleet.collectAsState()
    val brand = LocalBrand.current
    Column(Modifier.fillMaxSize().navigationBarsPadding().padding(top = Space.s4)) {
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
        // Notifications, asked for here once (the card goes once they are on, or you put it away).
        RosterList(app, current, go, Modifier.weight(1f)) { ReachCard(app) }
        RosterFoot(app, current, go, places, machine = false)
    }
}
