@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.RosterRow
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.AgentMark

/**
 * The agents, the app's home: the primary first (its row opens its chat), then each agent with its state's ring and
 * word and one line of what it's doing, then each room. What only you can answer is marked; what's new to you since you
 * last looked, on any device, has a grey dot, as an unread email does.
 */
@Composable
fun AgentsScreen(app: AppModel, back: () -> Unit, openChat: () -> Unit, openAgent: (String) -> Unit, openRoom: (String) -> Unit) {
    val table by app.table.collectAsState()
    val problem by app.problem.collectAsState()
    val paired by app.paired.collectAsState()
    val usage by app.usage.collectAsState()
    val prices by app.prices.collectAsState()
    var giving by remember { mutableStateOf(false) }
    var usageOpen by remember { mutableStateOf(false) }
    // The last team this phone saw is drawn at once (app/KeptTable.kt). If the node hasn't answered in a moment,
    // a still line says what you're looking at, the node away or not; on a quick answer it never shows, so nothing comes
    // and goes.
    var waited by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(table.asOf) {
        waited = false
        if (table.asOf != null) {
            kotlinx.coroutines.delay(1_500)
            waited = true
            // (Said again each minute, so how long ago stays true while the node is away.)
            while (true) {
                now = System.currentTimeMillis()
                kotlinx.coroutines.delay(60_000)
            }
        }
    }
    val agents = table.rows.filter { it.kind == "agent" }
    val rooms = table.rows.filter { it.kind == "room" }

    // What each agent's ended tasks cost this week, at your prices (Work.spentSince).
    val week = System.currentTimeMillis() - 7 * 86_400_000L
    Column(Modifier.fillMaxSize()) {
    PageBar(paired?.fleetName?.let { "Agents · $it" } ?: "Agents", back) {
        // (Given once the node has answered: never from the agents this phone kept.)
        if (table.snapshot != null) TextButton(onClick = { giving = true }, enabled = table.asOf == null) { Text("Give a task") }
    }
    LazyColumn(Modifier.fillMaxSize()) {
        problem?.let { p -> item { Refused(app, p) } }
        table.asOf?.takeIf { waited }?.let { at ->
            item {
                val ago = if (now - at < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(at, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                Text(sh.invincible.bot.core.keptLine(ago, refused = problem?.notYourNode != null), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.margin))
            }
        }
        // What the model calls came to, against your budget (the iPhone's meter, at the head of its team).
        usage?.let { m -> item { UsageLine(m) { usageOpen = true } } }
        if (table.snapshot == null && problem == null) item {
            Text("Asking your node…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.margin))
        }
        // (Its line says what it's doing: until the node has answered, there's nothing it could truly say.)
        if (table.snapshot != null) item {
            Seat(
                id = "primary",
                profile = null,
                name = Primary.name,
                state = table.primary.state,
                line = table.primary.line,
                needs = table.primary.tone == "warn",
                unread = table.unread.isNotEmpty(),
                onClick = openChat,
            )
        }
        items(agents, key = { "k:${it.id}" }) { row ->
            val person = table.snapshot?.agents?.firstOrNull { it.id == row.id }
            val spent = prices?.let { sh.invincible.bot.core.Work.spentSince(table.tasks, row.id, week, it) }
            Seat(row.id, row.avatar, row.name, row.state, row.line, row.needs, row.unread, role = person?.role, cost = spent?.let { "${sh.invincible.bot.core.Spend.boundWord(!it.complete, it.atMost)}${sh.invincible.bot.core.Usage.money(it.usd)} this week" }) { openAgent(row.id) }
        }
        if (table.snapshot != null && agents.isEmpty()) {
            item {
                Text(
                    "No agents yet. ${Primary.name} can add one for you: ask it in its chat.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(Space.margin),
                )
            }
        }
        if (rooms.isNotEmpty()) {
            item { SectionTitle("Rooms", Modifier.padding(top = Space.s4)) }
            items(rooms, key = { "r:${it.id}" }) { row -> RoomSeat(row) { openRoom(row.id) } }
        }
        item { Spacer(Modifier.height(Space.s10)) }
    }
    }
    if (giving) GiveDialog(app) { giving = false }
    if (usageOpen) usage?.let { UsageDialog(app, it) { usageOpen = false } }
}

/**
 * What the node said, as what it means for you: a phone whose clock is a minute or more off is refused (set it to
 * automatic); a refusal with the clocks agreeing means the node no longer knows this phone (removed there), so the way
 * out is offered, unless its whoami still holds: then it is this build the node no longer takes, and the way out is an
 * update; anything else in the node's own words.
 */
@Composable
internal fun Refused(app: AppModel, p: NodeError) {
    val skew = p.serverTime?.let { System.currentTimeMillis() - it }
    when {
        // The node at this address isn't this phone's (NodePin): nothing more is sent to it.
        p.notYourNode != null -> Column {
            Problem("This isn't the node this phone paired with. ${p.message} Nothing more is sent to it. If you set your node up anew at this address, forget it here, then join with a fresh invite.")
            TextButton(onClick = app::tryAgain, modifier = Modifier.padding(horizontal = Space.margin)) { Text("Try again") }
            ForgetThisDevice(app, Modifier.padding(horizontal = Space.margin))
        }
        // The node knows this phone (its whoami holds) but no longer takes how this build signs the rest (NodeSession.refusal).
        p.outdated -> Column {
            Problem("Your node no longer takes requests from this version of Invincible, though it still knows this phone. Update Invincible, and it answers again.")
            UpdateInvincible(Modifier.padding(horizontal = Space.margin))
        }
        p.status == 401 && skew != null && Math.abs(skew) > 60_000 ->
            Problem("This phone's clock is ${Math.abs(skew) / 60_000} min ${if (skew > 0) "ahead of" else "behind"} your node's, and the node refuses requests that far out. Set the time to automatic in Settings.")
        p.status == 401 -> Column {
            Problem("Your node no longer knows this phone: it was removed there, or the node was set up again. Forget it here, then join with a fresh invite.")
            ForgetThisDevice(app, Modifier.padding(horizontal = Space.margin))
        }
        else -> Problem(p.message ?: "The node isn't answering.")
    }
}

/** Update Invincible: the newer build's download where the feed has one (Updates), else the page every build is published on. */
@Composable
private fun UpdateInvincible(modifier: Modifier = Modifier) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var newer by remember { mutableStateOf<sh.invincible.bot.app.Updates.Newer?>(null) }
    LaunchedEffect(Unit) { newer = sh.invincible.bot.app.Updates.newer(context) }
    TextButton(onClick = { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(newer?.url ?: "https://github.com/wckdboy/invincible/releases"))) }, modifier = modifier) {
        Text("Update Invincible")
    }
}

/**
 * One seat at the table: its mark (still: only the mark in focus moves), its name and role, its state in a word (a tinted
 * chip, never colour alone), one line of what it's doing, and what its work cost this week. What only you can answer is
 * in its word; what's new to you since you last looked, on any device, has a grey dot, as an unread email does.
 */
@Composable
private fun Seat(id: String, profile: Json?, name: String, state: AgentState?, line: String, needs: Boolean, unread: Boolean, role: String? = null, cost: String? = null, onClick: () -> Unit) {
    val brand = LocalBrand.current
    val beside = Roster.besideChip(line, state)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) { this.role = Role.Button }
            .heightIn(min = 64.dp)
            .padding(horizontal = Space.margin, vertical = Space.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        // (Its seat's state in its mark's shape: the top slat in ink while it asks you, the bottom one red and loose once it
        // failed. Still, as every row is.)
        Face(id, profile, 40.dp, state = AgentMark.state(state), description = null)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text(name, style = Type.rowTitle.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                role?.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                StateChip(state)
                if (unread) Box(Modifier.clearAndSetSemantics { contentDescription = "new" }) { Dot(brand.done) }
            }
            if (beside.isNotEmpty()) {
                Text(beside, style = Type.meta.copy(fontSize = Type.body.fontSize), color = if (needs) brand.needs else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            cost?.let { Text(it, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Icon(ChevronIcon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun RoomSeat(row: RosterRow, onClick: () -> Unit) {
    val brand = LocalBrand.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).semantics(mergeDescendants = true) { role = Role.Button }.padding(horizontal = Space.margin, vertical = Space.s2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        // (A room's mark, for the eye only: a screen reader says its name.)
        Box(Modifier.size(40.dp).clip(CircleShape).background(brand.raised).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            Text("#", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text(row.name, style = MaterialTheme.typography.titleMediumEmphasized, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (row.unread) Dot(brand.done)
            }
            Text(row.line, style = MaterialTheme.typography.bodyMedium, color = if (row.needs) brand.needs else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A task given to the agents: the agent best suited to it takes it, in its conversation with you. */
@Composable
internal fun GiveDialog(app: AppModel, done: () -> Unit) {
    var goal by remember { mutableStateOf("") }
    var said by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = done,
        title = { Text("Give a task to the agents") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text("The agent best suited to it takes it. You'll see who in its row.", style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(value = goal, onValueChange = { goal = it }, label = { Text("What's to be done") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                said?.let { Text(it, color = LocalBrand.current.needs) }
            }
        },
        confirmButton = {
            TextButton(enabled = goal.isNotBlank() && !sending, onClick = {
                sending = true
                scope.launch {
                    try {
                        val given = app.client?.post("/api/team/give", Json.obj("goal" to goal.trim()))
                        app.refresh()
                        said = null
                        given?.let { done() }
                    } catch (e: NodeError) {
                        said = e.message
                    } finally {
                        sending = false
                    }
                }
            }) { Text("Give it") }
        },
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}


/**
 * Forget this device…, confirmed first (the iPhone's words, I10's 81361e56): the pairing and this phone's key go, and a
 * fresh invite joins it again. The way out of a refusal on the chat and Work, and Settings' own. Its question is saved
 * with the page, as Settings' was, so turning the phone or a change of theme leaves it asked.
 */
@Composable
internal fun ForgetThisDevice(app: AppModel, modifier: Modifier = Modifier, outlined: Boolean = false) {
    var asking by rememberSaveable { mutableStateOf(false) }
    val label = @Composable { Text("Forget this device…", color = LocalBrand.current.failed) }
    if (outlined) androidx.compose.material3.OutlinedButton(onClick = { asking = true }, modifier = modifier) { label() } else TextButton(onClick = { asking = true }, modifier = modifier) { label() }
    if (asking) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { asking = false },
            title = { Text("Forget this device?") },
            text = { Text("This phone's key goes too. To use ${Primary.name} here again, join with a fresh invite. Your node keeps everything; remove this phone from its devices there.") },
            confirmButton = { TextButton(onClick = { asking = false; app.forget() }) { Text("Forget it", color = LocalBrand.current.failed) } },
            dismissButton = { TextButton(onClick = { asking = false }) { Text("Cancel") } },
        )
    }
}
