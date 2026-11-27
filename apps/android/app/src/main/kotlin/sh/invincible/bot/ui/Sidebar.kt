package sh.invincible.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.invincible.bot.app.AppModel

/*
 * A wide screen's sidebar, as T3 Code's (the owner's word, 27 November 2026: "something like t3code on desktop"): the mark,
 * a task to give and the sidebar folded away; then the roster, the same list a phone's drawer is (RosterList: what needs
 * you, your agent, the agents, the rooms), notifications asked for once at its end; and at its foot the work, Settings,
 * everything else and the machine it talks to. It asks the node nothing of its own. The web's sidebar.ts.
 */

@Composable
fun Sidebar(app: AppModel, nav: Nav, give: () -> Unit, places: () -> Unit, collapse: () -> Unit) {
    val table by app.table.collectAsState()
    val brand = LocalBrand.current
    Column(Modifier.width(Space.sidebar).fillMaxHeight().background(brand.paper)) {
        // ---- the head: the mark, a task to give, the sidebar folded away ----
        Row(Modifier.fillMaxWidth().padding(start = Space.s4, end = Space.s1, top = Space.s2, bottom = Space.s2), verticalAlignment = Alignment.CenterVertically) {
            // The app's mark (AppMark: the icon's field on nothing, so no tile sits on a light page), then the wordmark.
            AppMark(20.dp)
            Spacer(Modifier.width(9.dp))
            Text("INVINCIBLE", style = Type.section.copy(letterSpacing = 2.4.sp), modifier = Modifier.weight(1f).semantics { contentDescription = "Invincible" })
            // (A task is given once the node has answered: never from the agents this phone kept.)
            IconButton(onClick = give, enabled = table.asOf == null, modifier = Modifier.semantics { contentDescription = "Give a task" }) { Icon(ComposeIcon, null, Modifier.size(20.dp)) }
            IconButton(onClick = collapse, modifier = Modifier.semantics { contentDescription = "Hide the sidebar" }) { Icon(PanelIcon, null, Modifier.size(20.dp)) }
        }
        // ---- the roster, then its foot ----
        RosterList(app, nav.top, go = { nav.open(it) }, modifier = Modifier.weight(1f)) { ReachCard(app) }
        RosterFoot(app, nav.top, go = { nav.open(it) }, places = places)
    }
}
