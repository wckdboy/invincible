@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
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
 * What needs you, decisions only (the iPhone's Decisions, I9): each with its one answer in place, the rest a long press
 * away (or a screen reader's actions), the whole of it a tap (its card or its sheet, over the page, or its task). Home
 * shows the first three and how many more; Needs you (the Inbox) shows every one, and the news beside them. What it
 * noticed (a notice, a fact about you) is news, not a decision: in the Inbox, counted nowhere. An answer is a grey pill,
 * never a filled button: a screen has one filled button at most, and Home has none. The web's views/needs.ts.
 */

/** One decision that waits on you: what leads it, who asks, what ([code]: its first part a name in mono, as a key's
 * is), its one answer in place (null: none you can give here), the rest, and what a tap on it opens. */
private class Decision(val key: String, val lead: Lead, val who: String, val what: String, val code: String? = null, val answer: Answer?, val rest: List<Answer>, val open: () -> Unit)

/**
 * What needs you, decisions only, as the one count counts them (AppModel.needsYou): each approval once (an agent's under
 * its task's name), each task only you can move on, devices, keys, questions and asks to use a machine. Home shows the
 * first [limit] and "N more" ([openAll]: Needs you). [openTask] opens a task's thread, [watch] a machine it is using.
 */
@Composable
fun NeedsYou(app: AppModel, work: Work.Attended, limit: Int = 3, openTask: (String) -> Unit, openAll: () -> Unit, watch: (String) -> Unit) {
    val inbox by app.inbox.collectAsState()
    val table by app.table.collectAsState()
    val count by app.needsYou.collectAsState()
    val brand = LocalBrand.current
    val scope = rememberCoroutineScope()
    var said by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<Set<String>>(emptySet()) }
    var sheet by remember { mutableStateOf<Pair<String, @Composable () -> Unit>?>(null) }
    var confirming by remember { mutableStateOf<Json?>(null) }
    fun act(key: String, block: suspend () -> Unit) {
        busy = busy + key
        scope.launch {
            try {
                block()
                said = null
            } catch (e: NodeError) {
                said = e.message
            } finally {
                busy = busy - key
            }
        }
    }
    fun control(key: String, body: Json) = act(key) {
        app.client?.post("/api/team/control", body)
        app.refresh()
    }
    val asker = askerIn(table)
    val now = System.currentTimeMillis()
    fun card(a: Json) {
        sheet = "${a["connector"].string}.${a["tool"].string}" to @Composable { Approval(a, asker(a["by"].string ?: "")) { approve -> act("a:${a["id"].string}") { app.decide(a["id"].string!!, approve) }; sheet = null } }
    }
    fun approval(a: Json, row: Work.Row?): Decision {
        val kind = a["class"].string
        val key = "a:${a["id"].string}"
        val target = "${a["connector"].string}.${a["tool"].string} ${a["target"].string ?: ""}".trim()
        return Decision(
            key,
            if (row != null) Lead.Agent(row) else Lead.Icon(ShieldIcon),
            if (row != null) "${row.agentName} · ${row.title}" else "${asker(a["by"].string ?: "")} asks",
            listOfNotNull(kind?.replaceFirstChar { it.uppercase() }, target).joinToString(" · "),
            // A delete is answered only in its whole card; anything else asks once before it is sent.
            answer = Answer(if (kind == "delete") "Review…" else "Allow once") { if (kind == "delete") card(a) else confirming = a },
            rest = listOf(Answer("Deny", danger = true) { act(key) { app.decide(a["id"].string!!, false) } }, Answer("More") { card(a) }),
            open = { card(a) },
        )
    }
    val waiting = inbox.actions
    val decisions = ArrayList<Decision>()
    val shown = HashSet<String>()
    for (row in work.needs) {
        if (row.word == "Allow?") {
            for (a in waiting.filter { Roster.agentOfCaller(it["by"].string ?: "") == row.agent }) {
                shown += a["id"].string ?: ""
                decisions += approval(a, row)
            }
            continue
        }
        val key = "t:${row.id}"
        val open = { openTask(row.id) }
        decisions += when (row.word) {
            "Approve?" -> Decision(key, Lead.Agent(row), "${row.agentName} proposes", row.title, answer = Answer("Approve") { control(key, Json.obj("task" to row.id, "action" to "approve")) }, rest = listOf(Answer("Decline", danger = true) { control(key, Json.obj("task" to row.id, "action" to "stop")) }), open = open)
            "Interrupted" -> Decision(key, Lead.Agent(row), "${row.agentName} · interrupted", row.title, answer = Answer("Resume") { control(key, Json.obj("task" to row.id, "action" to "resume")) }, rest = emptyList(), open = open)
            "Agent paused" -> Decision(key, Lead.Agent(row), "${row.agentName} is paused", row.title, answer = Answer("Resume") { control(key, Json.obj("agent" to row.agent, "action" to "resume")) }, rest = emptyList(), open = open)
            else -> Decision(key, Lead.Agent(row), row.agentName, row.title, answer = null, rest = emptyList(), open = open)
        }
    }
    for (a in waiting.filter { (it["id"].string ?: "") !in shown }) decisions += approval(a, null)
    for (p in inbox.pairings) {
        val name = p["name"].string ?: "A device"
        val compare = { sheet = "$name asks to join" to @Composable { Pairing(p) { approve -> act("p:${p["device"].string}") { app.answerPairing(p["invite"].string!!, p["device"].string!!, approve) }; sheet = null } } }
        decisions += Decision("p:${p["invite"].string}:${p["device"].string}", Lead.Icon(PlusIcon), if (p["kind"].string == "node") "A machine asks to join" else "A device asks to join", name, answer = Answer("Compare…", onClick = compare), rest = emptyList(), open = compare)
    }
    for (k in inbox.keys) {
        val add = {
            sheet = "A key for ${k["name"].string}" to @Composable {
                KeyAsked(k, asker(k["requestedBy"].string ?: ""), seal = { value -> act("k:${k["name"].string}") { app.sealKey(k["name"].string!!, value, k["provider"].string) }; sheet = null }, dismiss = { act("k:${k["name"].string}") { app.dismissKey(k["name"].string!!) }; sheet = null })
            }
        }
        decisions += Decision("k:${k["name"].string}", Lead.Icon(KeyIcon), "${asker(k["requestedBy"].string ?: "")} asks for a key", k["purpose"].string ?: "", code = k["name"].string, answer = Answer("Add…", onClick = add), rest = emptyList(), open = add)
    }
    for (q in inbox.questions.filter { (it["expires"].long ?: Long.MAX_VALUE) > now }) {
        val label = q["label"].string ?: q["server"].string ?: "A service"
        val answer = { sheet = "$label asks" to @Composable { Question(q) { accept, content -> act("q:${q["id"].string}") { app.answerQuestion(q["id"].string!!, accept, content) }; sheet = null } } }
        decisions += Decision("q:${q["id"].string}", Lead.Icon(PlugIcon), "$label asks", q["message"].string ?: "", answer = Answer("Answer…", onClick = answer), rest = emptyList(), open = answer)
    }
    for (s in inbox.screens) {
        val allowed = s["state"].string == "allowed"
        val name = s["nodeName"].string ?: "a Mac"
        val see = { sheet = name to @Composable { MacSession(s, answer = { allow -> act("s:${s["id"].string}") { app.decideScreen(s["id"].string!!, allow) }; sheet = null }, end = { act("s:${s["id"].string}") { app.endScreen(s["id"].string!!) }; sheet = null }, watch = { sheet = null; s["node"].string?.let(watch) }) } }
        decisions += Decision("s:${s["id"].string}", Lead.Icon(MonitorIcon), if (allowed) "${Primary.name} is using $name" else "${Primary.name} asks to use $name", s["why"].string ?: "", answer = Answer(if (allowed) "See it…" else "Answer…", onClick = see), rest = emptyList(), open = see)
    }
    if (decisions.isEmpty()) return
    Column(Modifier.fillMaxWidth()) {
        // (The one count, as Home's line says it: the decisions below are the same ones.)
        SectionHead("Needs you", count.takeIf { it > 0 } ?: decisions.size, tone = brand.needs)
        said?.let { Text(it, style = Type.meta, color = brand.danger, modifier = Modifier.padding(horizontal = Space.margin)) }
        decisions.take(limit).forEachIndexed { i, d ->
            if (i > 0) Hairline(inset = Space.margin + 32.dp + Space.s3)
            key(d.key) { DecisionRow(d, d.key in busy) }
        }
        if (decisions.size > limit) {
            Hairline(inset = Space.margin)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = openAll)
                    .semantics(mergeDescendants = true) { role = androidx.compose.ui.semantics.Role.Button }
                    .heightIn(min = Space.touch)
                    .padding(horizontal = Space.margin, vertical = Space.s3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${decisions.size - limit} more", style = Type.rowTitle, modifier = Modifier.weight(1f))
                Icon(ChevronIcon, null, Modifier.size(16.dp), tint = brand.quiet)
            }
        }
        Hairline(inset = Space.margin)
    }
    confirming?.let { a ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("Approve and send?") },
            text = { Text("${a["connector"].string}.${a["tool"].string} on ${a["target"].string ?: "its target"}, once, as soon as you approve. It can't be called back, and if it fails it isn't retried.") },
            confirmButton = { TextButton(onClick = { confirming = null; act("a:${a["id"].string}") { app.decide(a["id"].string!!, true) } }) { Text("Approve and send") } },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
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

/**
 * A decision as a row: what leads it, who asks (quiet) and what (in weight, two lines at most), and its one answer as a
 * grey pill. A tap opens the whole of it; a long press, or a screen reader's actions, the rest (Deny, Decline, More).
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun DecisionRow(d: Decision, busy: Boolean) {
    val brand = LocalBrand.current
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = d.open, onLongClick = if (d.rest.isNotEmpty()) ({ menu = true }) else null)
                .semantics(mergeDescendants = true) {
                    role = androidx.compose.ui.semantics.Role.Button
                    if (d.rest.isNotEmpty()) customActions = d.rest.map { r -> androidx.compose.ui.semantics.CustomAccessibilityAction(r.label) { r.onClick(); true } }
                }
                .heightIn(min = 64.dp)
                .padding(horizontal = Space.margin, vertical = Space.s3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.s3),
        ) {
            Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
                when (val lead = d.lead) {
                    is Lead.Agent -> AgentOrb(lead.row.agent, lead.row.avatar, 28.dp)
                    is Lead.Icon -> Box(Modifier.size(32.dp).clip(CircleShape).background(brand.ink.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
                        Icon(lead.icon, null, Modifier.size(16.dp), tint = brand.quiet)
                    }
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(d.who, style = Type.meta, color = brand.quiet, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    androidx.compose.ui.text.buildAnnotatedString {
                        d.code?.let { withStyle(androidx.compose.ui.text.SpanStyle(fontFamily = Type.mono.fontFamily)) { append(it) }; if (d.what.isNotEmpty()) append(" · ") }
                        append(d.what)
                    },
                    style = Type.rowTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            d.answer?.let { a -> AnswerPill(a.label, a.onClick, enabled = !busy) }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            for (r in d.rest) DropdownMenuItem(text = { Text(r.label, color = if (r.danger) brand.danger else brand.ink) }, onClick = { menu = false; r.onClick() })
        }
    }
}

/** An answer in place: a grey pill in the ink (the iPhone's), never a filled button. */
@Composable
internal fun AnswerPill(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    val brand = LocalBrand.current
    androidx.compose.material3.FilledTonalButton(
        onClick = onClick,
        enabled = enabled,
        colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(containerColor = brand.ink.copy(alpha = 0.08f), contentColor = brand.ink),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        modifier = Modifier.heightIn(min = 40.dp),
    ) { Text(label, style = Type.word.copy(fontSize = 15.sp), maxLines = 1) }
}

/** What leads an item: its agent's orb (still), or an icon for what is no task's. */
private sealed interface Lead {
    class Agent(val row: Work.Row) : Lead
    class Icon(val icon: ImageVector) : Lead
}

/** An answer: its words, whether it says no to something (in red where it is listed), and what it does. */
private class Answer(val label: String, val danger: Boolean = false, val onClick: () -> Unit)

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
