@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.Inbox
import sh.invincible.bot.app.Table
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.Loops
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.double
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.text
import sh.invincible.bot.core.Primary

/**
 * A loop it drafted when you asked for one in a chat (the web's loopDraftCard): what it is, when it runs and where, what
 * it runs and what else wakes it (Loops, the web's words), why, and whether it replaces one of yours; then Add loop or
 * Dismiss. It runs nothing until you add it.
 */
@Composable
internal fun LoopDrafted(d: Json, add: () -> Unit, dismiss: () -> Unit) {
    val name = d["name"].string ?: ""
    val label = d["label"].string
    val schedule = d["schedule"].string ?: ""
    val tz = d["tz"].string ?: "UTC"
    val replaces = d["replaces"].bool == true
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    Panel {
        Text(label ?: name, style = MaterialTheme.typography.titleMediumEmphasized)
        if (label != null) Text(name, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = quiet)
        Text(
            (if (schedule == "never") "Only when woken" else schedule + if (tz != "UTC") " ($tz)" else "") + (d["on"].string?.let { " on $it" } ?: ""),
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
        Text(Loops.describeTask(d["task"]), style = MaterialTheme.typography.bodyMedium)
        Loops.describeWakes(d["wakes"].list, d["cooldownMs"].double).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        d["why"].string?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = quiet) }
        if (replaces) Text("Adding it replaces your loop $name.", style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.failed)
        Text("Drafted by ${if (d["by"].string == "primary") Primary.name else d["by"].string ?: "someone"}", style = MaterialTheme.typography.bodySmall, color = quiet)
        Decision(no = "Dismiss", yes = if (replaces) "Add, replacing yours" else "Add loop", onNo = dismiss, onYes = add)
    }
}

/**
 * A connector it or an agent asked for (the web's connectorRequestCard): who asked and why. One that's its alone,
 * installed, it lets the asker use (Allow); one it doesn't have is added from Connectors; or it's dismissed. Asking
 * installs nothing.
 */
@Composable
internal fun ConnectorAsked(c: Json, allow: () -> Unit, dismiss: () -> Unit, openConnectors: () -> Unit) {
    val name = c["label"].string ?: c["connector"].string ?: "a connector"
    val by = c["by"].string ?: "An agent"
    val access = c["access"].bool == true
    Panel {
        Text(if (access) "$by asks to use $name" else "$by asks for $name", style = MaterialTheme.typography.titleMediumEmphasized)
        c["why"].string?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        Text(
            if (access) "$name is ${Primary.name}'s alone: allowed, $by may read it too, until you stop it." else "Asking installs nothing: it waits for you to add it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (access) {
            Decision(no = "Dismiss", yes = "Allow $by", onNo = dismiss, onYes = allow)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedButton(onClick = dismiss) { Text("Dismiss") }
                TextButton(onClick = openConnectors) { Text("Add it in Connectors") }
            }
        }
    }
}

/** A loop a webhook wakes, just added: its secret, shown this once, to select and keep where the sender keeps its keys. */
@Composable
internal fun HookSecret(name: String, secret: String, done: () -> Unit) {
    AlertDialog(
        onDismissRequest = done,
        title = { Text("The webhook of $name") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                Text("Its secret, shown this once. Keep it where the sender keeps its keys; a new one, from the loop on a computer, retires it.")
                androidx.compose.foundation.text.selection.SelectionContainer { Text(secret, fontFamily = FontFamily.Monospace) }
            }
        },
        confirmButton = { TextButton(onClick = done) { Text("Done") } },
    )
}

/** A device asking to join: its name and the code it shows, to compare before you let it in. */
@Composable
internal fun Pairing(p: Json, answer: (Boolean) -> Unit) {
    Panel {
        Text(p["name"].string ?: "A device", style = MaterialTheme.typography.titleMediumEmphasized)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Text("Its code", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(p["sas"].string ?: "", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.headlineSmallEmphasized)
        }
        Text("Approve only if this is the code that device shows.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (p["conflict"].bool == true) Text("Two devices asked with one invite: approving either is refused.", color = LocalBrand.current.failed)
        Decision(no = "Decline", yes = "Approve", onNo = { answer(false) }, onYes = { answer(true) })
    }
}

/** Who asked, in words: an agent by its name, a loop, or the primary (its own calls, its tools' and its nodes'). */
internal fun askerIn(table: Table): (String) -> String {
    val agents = table.snapshot?.agents ?: emptyList()
    return { by ->
        Roster.agentOfCaller(by)?.let { id -> agents.firstOrNull { it.id == id }?.name ?: id }
            ?: if (by.startsWith("loop:")) "The loop ${by.removePrefix("loop:")}" else if (by == "primary" || by.startsWith("arm:") || by.startsWith("n_")) Primary.name else by
    }
}

/** An approval as you read it before you answer: who asks, what it would do and to what, why, and the request itself. */
@Composable
internal fun Approval(a: Json, who: String, answer: (Boolean) -> Unit) {
    val brand = LocalBrand.current
    var shown by remember { mutableStateOf(false) }
    val kind = a["class"].string
    val left = (a["expires"].long ?: 0) - System.currentTimeMillis()
    Panel {
        Text("$who asks", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("${a["connector"].string}.${a["tool"].string}", style = MaterialTheme.typography.titleMediumEmphasized)
        Text(a["target"].string ?: "", style = MaterialTheme.typography.bodyMedium)
        when (kind) {
            "delete" -> Text("It deletes something.", color = brand.failed, style = MaterialTheme.typography.bodyMedium)
            "outward" -> Text("It sends something out of your fleet.", color = brand.needs, style = MaterialTheme.typography.bodyMedium)
        }
        a["why"].string?.let { Text("Why: $it", style = MaterialTheme.typography.bodyMedium) }
        TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide the request" else "Read the request") }
        if (shown) Text(a["args"]?.let(::pretty) ?: "{}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        Text(if (left > 60_000) "No answer within ${within(left)} is a no." else "It expires now: no answer is a no.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Decision(no = "Decline", yes = "Approve", onNo = { answer(false) }, onYes = { answer(true) })
    }
}

/** A service's question, asked mid-call (MCP elicitation): its fields as a form, checked again on the node. */
@Composable
internal fun Question(q: Json, answer: (Boolean, Map<String, Any?>) -> Unit) {
    val values = remember(q["id"].string) { mutableStateMapOf<String, Any?>() }
    Panel {
        Text("${q["label"].string ?: q["connector"].string} asks", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(q["message"].string ?: "", style = MaterialTheme.typography.titleMedium)
        for (f in q["fields"].list) {
            val name = f["name"].string ?: continue
            val title = f["title"].string ?: name
            when (f["kind"].string) {
                "yes-no" -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, modifier = Modifier.weight(1f))
                    Switch(checked = (values[name] ?: f["default"].bool ?: false) as Boolean, onCheckedChange = { values[name] = it })
                }
                "one" -> Column {
                    Text(title, style = MaterialTheme.typography.labelLarge)
                    for (o in f["options"].list) Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = (values[name] ?: f["default"].string) == o["value"].string, onClick = { values[name] = o["value"].string })
                        Text(o["title"].string ?: o["value"].string ?: "")
                    }
                }
                "many" -> Column {
                    Text(title, style = MaterialTheme.typography.labelLarge)
                    for (o in f["options"].list) {
                        @Suppress("UNCHECKED_CAST") val chosen = (values[name] as? List<String>) ?: f["default"].list.mapNotNull { it.string }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = o["value"].string in chosen, onCheckedChange = { on -> values[name] = if (on) chosen + o["value"].string!! else chosen - o["value"].string!! })
                            Text(o["title"].string ?: o["value"].string ?: "")
                        }
                    }
                }
                else -> OutlinedTextField(
                    value = (values[name] as? String) ?: f["default"].let { it.string ?: it.double?.let { d -> if (d % 1.0 == 0.0) d.toLong().toString() else d.toString() } } ?: "",
                    onValueChange = { values[name] = it },
                    label = { Text(title) },
                    supportingText = f["description"].string?.let { { Text(it) } },
                    keyboardOptions = KeyboardOptions(keyboardType = if (f["kind"].string == "number") KeyboardType.Decimal else KeyboardType.Text),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            OutlinedButton(onClick = { answer(false, emptyMap()) }) { Text("Decline") }
            androidx.compose.material3.FilledTonalButton(colors = pillColors(), onClick = {
                val content = q["fields"].list.associate { f ->
                    val name = f["name"].string!!
                    val v = values[name]
                    name to when (f["kind"].string) {
                        "number" -> (v as? String)?.toDoubleOrNull() ?: f["default"].double
                        "yes-no" -> v ?: f["default"].bool
                        "one" -> v ?: f["default"].string
                        "many" -> v ?: f["default"].list.mapNotNull { it.string }.ifEmpty { null }
                        else -> (v as? String)?.ifBlank { null } ?: f["default"].string
                    }
                }
                answer(true, content)
            }) { Text("Answer") }
        }
    }
}

/** A key asked for: it goes into the vault, sealed, and is never shown again (here or anywhere). */
@Composable
internal fun KeyAsked(k: Json, who: String, seal: (String) -> Unit, dismiss: () -> Unit) {
    var adding by remember { mutableStateOf(false) }
    Panel {
        Text("$who asks for a key", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(k["name"].string ?: "", style = MaterialTheme.typography.titleMediumEmphasized, fontFamily = FontFamily.Monospace)
        Text(k["purpose"].string ?: "", style = MaterialTheme.typography.bodyMedium)
        Decision(no = "Dismiss", yes = "Add the key", onNo = dismiss, onYes = { adding = true })
    }
    if (adding) {
        var value by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Add ${k["name"].string}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                    Text("It's sealed in your node's vault and never shown again.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        value = value,
                        onValueChange = { value = it },
                        label = { Text("The key") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = { TextButton(enabled = value.isNotBlank(), onClick = { seal(value.trim()); value = ""; adding = false }) { Text("Seal it") } },
            dismissButton = { TextButton(onClick = { value = ""; adding = false }) { Text("Cancel") } },
        )
    }
}

/**
 * Its ask to use a Mac itself, or its session on one now: what for, for how long, and your answer (the iPhone's words).
 * Letting it asks once more, saying what it means: that account holds the node's keys.
 */
@Composable
internal fun MacSession(s: Json, answer: (Boolean) -> Unit, end: () -> Unit, watch: () -> Unit) {
    var confirming by remember { mutableStateOf(false) }
    val name = s["nodeName"].string ?: "a Mac"
    val minutes = s["minutes"].long ?: 0
    val allowed = s["state"].string == "allowed"
    Panel {
        Text(if (allowed) "${Primary.name} is using $name itself" else "${Primary.name} asks to use $name itself", style = MaterialTheme.typography.titleMediumEmphasized)
        s["why"].string?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        Text(
            if (allowed) "Until ${clock(s["until"].long)}, or until you end it." else "For $minutes minutes, if you let it. Answer by ${clock(s["answerBy"].long)}.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (allowed) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedButton(onClick = watch) { Text("Watch") }
                TextButton(onClick = end) { Text("End now", color = LocalBrand.current.failed) }
            }
        } else {
            Decision(no = "Not now", yes = "Let it…", onNo = { answer(false) }, onYes = { confirming = true })
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Let ${Primary.name} use $name itself?") },
            text = { Text("For $minutes minutes from now it sees its screen, uses its apps and runs commands as its user, held to your rules. That account holds the node's keys: let it only for work you want done that way.") },
            confirmButton = { TextButton(onClick = { confirming = false; answer(true) }) { Text("Let it, for $minutes minutes") } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
}

/** A fact it noticed about you: kept as it said it or in your words (then it goes with every answer it gives), or dropped. */
@Composable
internal fun Fact(f: Json, keep: (String?) -> Unit, drop: () -> Unit) {
    var rewording by remember { mutableStateOf(false) }
    Panel {
        Text(f["text"].string ?: "", style = MaterialTheme.typography.bodyLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalAlignment = Alignment.CenterVertically) {
            AnswerPill("Keep", { keep(null) })
            OutlinedButton(onClick = { rewording = true }) { Text("In my words") }
            TextButton(onClick = drop) { Text("Drop", color = LocalBrand.current.failed) }
        }
    }
    if (rewording) {
        var words by remember { mutableStateOf(f["text"].string ?: "") }
        AlertDialog(
            onDismissRequest = { rewording = false },
            title = { Text("In your words") },
            text = { OutlinedTextField(value = words, onValueChange = { words = it }, label = { Text("About you") }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(enabled = words.isNotBlank(), onClick = { rewording = false; keep(words.trim()) }) { Text("Keep") } },
            dismissButton = { TextButton(onClick = { rewording = false }) { Text("Cancel") } },
        )
    }
}

/** What the heartbeat, a loop or a rule of yours noticed: its words (a command it names in monospace), from where, when. */
@Composable
internal fun Notice(n: Json, dismiss: () -> Unit) {
    val brand = LocalBrand.current
    val tone = when (n["severity"].string) { "alert" -> brand.failed; "warn" -> brand.needs; else -> MaterialTheme.colorScheme.onSurfaceVariant }
    Panel {
        // (The dot beside the title's first line, however many it takes.)
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            androidx.compose.foundation.layout.Box(Modifier.padding(top = 8.dp)) { Dot(tone) }
            Text(n["title"].string ?: "", style = MaterialTheme.typography.titleMediumEmphasized)
        }
        for (line in (n["body"].string ?: "").split("\n")) {
            if (line.startsWith("$ ")) Text(line, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            else if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodyMedium)
        }
        val ago = (System.currentTimeMillis() - (n["at"].long ?: System.currentTimeMillis())).coerceAtLeast(0)
        Text("${Inbox.from(n["source"].string ?: "")} · ${if (ago < 60_000) "just now" else "${within(ago)} ago"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = dismiss) { Text("Dismiss") }
    }
}

/** A time of day, as this phone says them (its own clock: 24-hour or not). */
@Composable
private fun clock(ms: Long?): String {
    if (ms == null) return "soon"
    return android.text.format.DateFormat.getTimeFormat(androidx.compose.ui.platform.LocalContext.current).format(java.util.Date(ms))
}

/** A while, as it's said: minutes under an hour, hours under two days, else days. */
internal fun within(ms: Long): String {
    val minutes = ms / 60_000
    val hours = (ms + 1_800_000) / 3_600_000
    return when {
        minutes < 60 -> "$minutes min"
        hours < 48 -> "$hours hour${if (hours == 1L) "" else "s"}"
        else -> "${(ms + 43_200_000) / 86_400_000} days"
    }
}

/** A request's arguments as you read them: indented, one field a line. */
private fun pretty(j: Json, indent: String = ""): String = when (j) {
    is Json.Obj -> if (j.fields.isEmpty()) "{}" else j.fields.entries.joinToString(",\n", "{\n", "\n$indent}") { (k, v) -> "$indent  \"$k\": ${pretty(v, "$indent  ")}" }
    is Json.Arr -> if (j.items.isEmpty()) "[]" else j.items.joinToString(",\n", "[\n", "\n$indent]") { "$indent  ${pretty(it, "$indent  ")}" }
    else -> j.text()
}
