@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.get
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/*
 * What needs you, each with its answer in place (your words, 26 November 2026, after OpenMausBot's best idea: "Needs
 * you" with every card's buttons inline, never a trip to another page to answer): an approval's Allow once and Deny, a
 * proposal's Approve and Decline, work cut short's Resume, an agent you paused that work waits behind. What takes more than
 * a tap (comparing a device's code, typing a key, a service's question with fields) opens the Inbox's own card for it in a
 * sheet, over the page. The Inbox is still where all of it is, with its history. The web's views/needs.ts.
 */

/** One thing that needs you: what it is (for its key) and how it is drawn. */
private class Need(val key: String, val draw: @Composable () -> Unit)

/** How many things need you, as the items below count them (the primary's at-a-glance line says it). */
fun needsCount(app: AppModel, work: Work.Attended, now: Long = System.currentTimeMillis()): Int {
    val inbox = app.inbox.value
    return inbox.actions.count { (it["expires"].long ?: Long.MAX_VALUE) > now } +
        work.needs.count { it.word != "Allow?" } +
        inbox.pairings.size + inbox.keys.size + inbox.questions.count { (it["expires"].long ?: Long.MAX_VALUE) > now } +
        inbox.screens.size + inbox.notices.size + inbox.facts.size
}

/**
 * Everything that needs you, as items with their answers in place, in a card of its own (amber, only when something
 * waits): each task row that needs you (its agent's asks under it), then what is no task's. [openTask] opens a task's
 * thread, [openInbox] the Inbox, [watch] a Mac it is using.
 */
@Composable
fun NeedsCard(app: AppModel, work: Work.Attended, openTask: (String) -> Unit, openInbox: () -> Unit, watch: (String) -> Unit) {
    val inbox by app.inbox.collectAsState()
    val table by app.table.collectAsState()
    val brand = LocalBrand.current
    val scope = rememberCoroutineScope()
    var said by remember { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf<Pair<String, @Composable () -> Unit>?>(null) }
    fun act(block: suspend () -> Unit) = scope.launch {
        try {
            block()
            said = null
        } catch (e: NodeError) {
            said = e.message
        }
    }
    fun control(body: Json) = act {
        app.client?.post("/api/team/control", body)
        app.refresh()
    }
    val asker = askerIn(table)
    val now = System.currentTimeMillis()
    val waiting = inbox.actions.filter { (it["expires"].long ?: Long.MAX_VALUE) > now }
    val items = ArrayList<Need>()
    val shown = HashSet<String>()
    for (row in work.needs) {
        if (row.word == "Allow?") {
            for (a in waiting.filter { Roster.agentOfCaller(it["by"].string ?: "") == row.agent }) {
                shown += a["id"].string ?: ""
                items += Need("a:${a["id"].string}") {
                    AskItem(a, row, asker(a["by"].string ?: ""), decide = { approve -> act { app.decide(a["id"].string!!, approve) } }, more = {
                        sheet = "${a["connector"].string}.${a["tool"].string}" to @Composable { Approval(a, asker(a["by"].string ?: "")) { approve -> act { app.decide(a["id"].string!!, approve) }; sheet = null } }
                    })
                }
            }
            continue
        }
        val open = Answer("Open", primary = false) { openTask(row.id) }
        items += Need("t:${row.id}") {
            when (row.word) {
                "Approve?" -> Item(Lead.Agent(row), "${row.agentName} proposes", row.title, listOf(Answer("Approve") { control(Json.obj("task" to row.id, "action" to "approve")) }, Answer("Decline", primary = false) { control(Json.obj("task" to row.id, "action" to "stop")) }, open))
                "Interrupted" -> Item(Lead.Agent(row), "${row.agentName} · interrupted", row.title, listOf(Answer("Resume") { control(Json.obj("task" to row.id, "action" to "resume")) }, open))
                "Agent paused" -> Item(Lead.Agent(row), "${row.agentName} is paused", row.title, listOf(Answer("Resume ${row.agentName}") { control(Json.obj("agent" to row.agent, "action" to "resume")) }, open))
                else -> Item(Lead.Agent(row), row.agentName, row.title, listOf(open))
            }
        }
    }
    for (a in waiting.filter { (it["id"].string ?: "") !in shown }) {
        items += Need("a:${a["id"].string}") {
            AskItem(a, null, asker(a["by"].string ?: ""), decide = { approve -> act { app.decide(a["id"].string!!, approve) } }, more = {
                sheet = "${a["connector"].string}.${a["tool"].string}" to @Composable { Approval(a, asker(a["by"].string ?: "")) { approve -> act { app.decide(a["id"].string!!, approve) }; sheet = null } }
            })
        }
    }
    for (p in inbox.pairings) items += Need("p:${p["invite"].string}:${p["device"].string}") {
        Item(Lead.Icon(PlusIcon), "A device asks to join", p["name"].string ?: "A device", listOf(Answer("Compare codes…") {
            sheet = "${p["name"].string ?: "A device"} asks to join" to @Composable { Pairing(p) { approve -> act { app.answerPairing(p["invite"].string!!, p["device"].string!!, approve) }; sheet = null } }
        }))
    }
    for (k in inbox.keys) items += Need("k:${k["name"].string}") {
        Item(Lead.Icon(KeyIcon), "${asker(k["requestedBy"].string ?: "")} asks for a key", k["purpose"].string ?: "", code = k["name"].string, answers = listOf(Answer("Add it…") {
            sheet = "A key for ${k["name"].string}" to @Composable {
                KeyAsked(k, asker(k["requestedBy"].string ?: ""), seal = { value -> act { app.sealKey(k["name"].string!!, value, k["provider"].string) }; sheet = null }, dismiss = { act { app.dismissKey(k["name"].string!!) }; sheet = null })
            }
        }))
    }
    for (q in inbox.questions.filter { (it["expires"].long ?: Long.MAX_VALUE) > now }) items += Need("q:${q["id"].string}") {
        Item(Lead.Icon(PlugIcon), "${q["label"].string ?: q["server"].string ?: "A service"} asks", q["message"].string ?: "", listOf(Answer("Answer…") {
            sheet = "${q["label"].string ?: "A service"} asks" to @Composable { Question(q) { accept, content -> act { app.answerQuestion(q["id"].string!!, accept, content) }; sheet = null } }
        }))
    }
    for (s in inbox.screens) items += Need("s:${s["id"].string}") {
        val allowed = s["state"].string == "allowed"
        val name = s["nodeName"].string ?: "a Mac"
        Item(Lead.Icon(MonitorIcon), if (allowed) "${Primary.name} is using $name" else "${Primary.name} asks to use $name", s["why"].string ?: "", listOf(Answer(if (allowed) "See it…" else "Answer…") {
            sheet = name to @Composable { MacSession(s, answer = { allow -> act { app.decideScreen(s["id"].string!!, allow) }; sheet = null }, end = { act { app.endScreen(s["id"].string!!) }; sheet = null }, watch = { sheet = null; s["node"].string?.let(watch) }) }
        }))
    }
    for (n in inbox.notices) items += Need("n:${n["key"].string}") {
        Item(Lead.Icon(if (n["severity"].string == "info") InfoIcon else AlertIcon), "Noticed", n["title"].string ?: "", listOf(Answer("Dismiss", primary = false) { act { app.dismissNotice(n["key"].string!!) } }, Answer("Read", primary = false, onClick = openInbox)))
    }
    for (f in inbox.facts) items += Need("f:${f["id"].string}") {
        Item(Lead.Icon(ReviewIcon), "It noticed about you", (f["text"].string ?: "").lineSequence().first(), listOf(Answer("Keep or drop…") {
            sheet = "A fact about you" to @Composable { Fact(f, keep = { words -> act { app.keepFact(f["id"].string!!, words) }; sheet = null }, drop = { act { app.dropFact(f["id"].string!!) }; sheet = null }) }
        }))
    }
    if (items.isEmpty()) return
    val shape = MaterialTheme.shapes.large
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.margin, vertical = Space.s2)
            .clip(shape)
            .border(BorderStroke(1.dp, brand.needs.copy(alpha = 0.45f)), shape)
            .background(brand.needs.copy(alpha = 0.05f)),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = Space.s4, end = Space.s4, top = Space.s3, bottom = Space.s1).semantics(mergeDescendants = true) { heading() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s2),
        ) {
            Dot(brand.needs)
            Text("Needs you · ${items.size}", style = Type.section, color = brand.needs)
        }
        said?.let { Text(it, style = Type.meta, color = brand.failed, modifier = Modifier.padding(horizontal = Space.s4)) }
        items.forEachIndexed { i, need ->
            if (i > 0) Hairline(inset = Space.s4)
            key(need.key) { need.draw() }
        }
    }
    sheet?.let { (title, body) ->
        ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberFullSheet(), containerColor = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = Space.s4)) {
                Text(title, style = Type.title, modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2).semantics { heading() }, maxLines = 2, overflow = TextOverflow.Ellipsis)
                body()
            }
        }
    }
}

/** What leads an item: its agent's orb (still), or an icon for what is no task's. */
private sealed interface Lead {
    class Agent(val row: Work.Row) : Lead
    class Icon(val icon: ImageVector) : Lead
}

/** An answer on an item: its words, filled or not, and what it does. One tap each. */
private class Answer(val label: String, val primary: Boolean = true, val onClick: () -> Unit)

@Composable
private fun Who(lead: Lead, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
        when (lead) {
            is Lead.Agent -> AgentOrb(lead.row.agent, lead.row.avatar, 20.dp)
            is Lead.Icon -> Box(Modifier.size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
                Icon(lead.icon, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(text, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Answers(answers: List<Answer>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
        for (a in answers) ActionButton(a.label, a.onClick, primary = a.primary)
    }
}

/** An item: who it is from, what it is ([code]: its first part a name set in mono, as a key's is), and its answers. */
@Composable
private fun Item(lead: Lead, who: String, what: String, answers: List<Answer>, code: String? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.s4, vertical = Space.s3), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        Who(lead, who)
        if (what.isNotEmpty() || code != null) Text(
            androidx.compose.ui.text.buildAnnotatedString {
                code?.let { withStyle(androidx.compose.ui.text.SpanStyle(fontFamily = Type.mono.fontFamily)) { append(it) }; if (what.isNotEmpty()) append(" · ") }
                append(what)
            },
            style = Type.body,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Answers(answers)
    }
}

/**
 * An approval, compact: who asks and what (its task, where an agent asks as it works), what it would call and on what, in
 * mono, what it means (a delete can't be brought back, a post is seen by others) and when no answer becomes no; then
 * Allow once (a delete asks once more), Deny, and More: the whole card, with the request itself.
 */
@Composable
internal fun AskItem(a: Json, row: Work.Row?, who: String, decide: (Boolean) -> Unit, more: () -> Unit) {
    val brand = LocalBrand.current
    val kind = a["class"].string
    var confirming by remember { mutableStateOf(false) }
    val left = (a["expires"].long ?: 0) - System.currentTimeMillis()
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.s4, vertical = Space.s3), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        Who(if (row != null) Lead.Agent(row) else Lead.Icon(ShieldIcon), if (row != null) "${row.agentName} · ${row.title}" else "$who asks")
        Text("${a["connector"].string}.${a["tool"].string}  ${a["target"].string ?: ""}".trim(), style = Type.mono.copy(fontSize = Type.body.fontSize), color = MaterialTheme.colorScheme.onSurface)
        val warn = when (kind) { "delete" -> "It can't be brought back once deleted."; "outward" -> "Others can see it once it's sent."; else -> null }
        Text(
            listOfNotNull(warn, if (left > 60_000) "No answer within ${within(left)} is a no." else "It expires now: no answer is a no.").joinToString(" "),
            style = Type.meta,
            color = if (warn != null) brand.needs else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalAlignment = Alignment.CenterVertically) {
            ActionButton(if (kind == "delete") "Allow delete…" else "Allow once", { if (kind == "delete") confirming = true else decide(true) })
            ActionButton("Deny", { decide(false) }, primary = false)
            TextButton(onClick = more) { Text("More", style = Type.word.copy(fontSize = 14.sp)) }
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Allow this delete?") },
            text = { Text("${a["connector"].string}.${a["tool"].string} on ${a["target"].string ?: "its target"}. It can't be brought back once deleted.") },
            confirmButton = { TextButton(onClick = { confirming = false; decide(true) }) { Text("Allow delete", color = brand.failed) } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
}
