package sh.invincible.bot.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Connector
import sh.invincible.bot.core.Connectors
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/**
 * Your connectors (the iPhone's and the PWA's Connectors): the services the primary reaches for you, each with where its
 * key or its sign-in stands, and those in the node's catalog to add, the hosted MCP servers it ships among them. One opens to what it can do, who may use it,
 * its key or its sign-in (Google's, Microsoft's or an MCP server's own page, which comes back to your node), and to
 * remove it.
 */
@Composable
fun ConnectorsScreen(app: AppModel, back: () -> Unit) {
    var connectors by remember { mutableStateOf<List<Connector>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var open by rememberSaveable { mutableStateOf<String?>(null) }

    suspend fun load() {
        val client = app.client ?: return
        try {
            connectors = client.get("/api/connectors")["connectors"].list.map(Connector::of).sortedBy { it.label.lowercase() }
            problem = null
        } catch (e: NodeError) {
            problem = "The connectors couldn't be read: ${e.message}"
        }
    }
    LaunchedEffect(open) { if (open == null) load() }

    open?.let { id ->
        BackHandler { open = null }
        ConnectorPage(app, id) { open = null }
        return
    }
    Column(Modifier.fillMaxSize()) {
        PageBar("Connectors", back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = Space.s4), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            problem?.let { Problem(it) }
            val all = connectors
            if (all == null && problem == null) Text("Reading your connectors…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(Space.margin))
            val installed = all.orEmpty().filter { it.installed }
            val catalog = all.orEmpty().filter { !it.installed }
            if (installed.isNotEmpty()) {
                SectionTitle("Connected")
                for (c in installed) ConnectorRow(c) { open = c.id }
            }
            if (catalog.isNotEmpty()) {
                SectionTitle("Add")
                for (c in catalog) ConnectorRow(c) { open = c.id }
                Text(
                    "Each reaches its service as you allow: reading, making and changing run freely, and anything sent out, pushed or deleted asks you first, but your agent's own work on GitHub, which it approves itself and says so: its pushes in the repositories you gave its agents, built where GitHub says your default branch stands, its words on its own threads, and its merge of that proven work once GitHub says the pull request is clean and its checks pass, where you leave merging on (GitHub's own page says where).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2),
                )
            }
        }
    }
}

@Composable
private fun ConnectorRow(c: Connector, open: () -> Unit) = Column(Modifier.fillMaxWidth()) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).padding(horizontal = Space.margin, vertical = Space.s3),
        horizontalArrangement = Arrangement.spacedBy(Space.s2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            Text(c.label, style = MaterialTheme.typography.titleMediumEmphasized)
            c.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2) }
        }
        if (c.installed) Connectors.state(c.key, c.signIn)?.let { ToneBadge(it) }
    }
    HorizontalDivider(Modifier.padding(start = Space.margin))
}

/** A word in its tone, as the PWA's badges are: still, never an animation. */
@Composable
private fun ToneBadge(state: Connectors.State) {
    val brand = LocalBrand.current
    val color = when (state.tone) {
        "ok" -> brand.done
        "warn" -> brand.needs
        "danger" -> brand.danger
        "accent" -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        state.label,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.12f)).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/** A sign-in started: Google's or an MCP server's page opened, or Microsoft's code to type at its page. */
private sealed interface Started {
    data object Page : Started
    data class Code(val code: String, val url: String) : Started
}

/** One connector: what it can do and who may use it, its key or its sign-in, and adding or removing it. */
@Composable
private fun ConnectorPage(app: AppModel, id: String, back: () -> Unit) {
    val context = LocalContext.current
    val paired by app.paired.collectAsState()
    var connector by remember { mutableStateOf<Connector?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var started by remember { mutableStateOf<Started?>(null) }
    var removing by remember { mutableStateOf(false) }
    var origin by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var client by remember { mutableStateOf("") }
    var clientSecret by remember { mutableStateOf("") }
    /** Where its own merging stands, on GitHub's: each repository you gave an agent that this connector ships to (the team's `merging`). */
    var merging by remember { mutableStateOf<List<Merging>>(emptyList()) }
    val scope = rememberCoroutineScope()
    val c = connector
    val google = c?.signIn == "google"
    val mcp = c?.signIn == "mcp"
    val who = if (mcp) c.label else if (google) "Google" else "Microsoft"

    suspend fun load() {
        try {
            val all = app.client?.get("/api/connectors")?.get("connectors").list.map(Connector::of)
            connector = all?.firstOrNull { it.id == id }
            // GitHub's: where its own merging stands, for the repositories this connector ships to (one more owner's own
            // connector, github-<owner>, ships to that owner's; GitHub's to the rest).
            if (id == "github" || id.startsWith("github-")) {
                val owners = all.orEmpty().filter { it.installed && it.id.startsWith("github-") }.map { it.id.removePrefix("github-") }.toSet()
                merging = app.client?.get("/api/team")?.get("merging").list.mapNotNull { m ->
                    val repository = m["repository"].string ?: return@mapNotNull null
                    val owner = repository.substringBefore("/")
                    val here = if (id == "github") owner !in owners else id == "github-$owner"
                    if (here) Merging(repository, m["on"].bool ?: true) else null
                }
            }
        } catch (e: NodeError) {
            problem = e.message
        }
    }
    /** One request, its failure said, then the connector as the node has it now. */
    fun run(request: suspend () -> Unit, then: () -> Unit = {}) {
        scope.launch {
            working = true
            try {
                request()
                problem = null
                then()
            } catch (e: NodeError) {
                problem = e.message
            } finally {
                working = false
            }
            load()
        }
    }
    LaunchedEffect(id) { load() }
    // While a sign-in is open, the node is asked again until it says you're in.
    LaunchedEffect(started) {
        if (started == null) return@LaunchedEffect
        repeat(200) {
            delay(3_000)
            load()
            if (connector?.key == "ready") {
                // An MCP server's tools are listed just after you sign in: a few seconds' grace for them.
                repeat(6) { if (mcp && connector?.tools.isNullOrEmpty()) { delay(2_000); load() } }
                started = null
                return@LaunchedEffect
            }
        }
    }

    fun startSignIn() {
        val callback = paired?.origin?.let(Connectors::callback)
        run({
            val answer = app.client!!.post("/api/oauth/start", Json.obj("connector" to id, "redirect" to if (google || mcp) callback else null))
            val url = answer["url"].string?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: throw NodeError(0, "The node gave no page to sign in at.")
            val code = answer["code"].string
            if (answer["flow"].string == "device" && code != null) {
                started = Started.Code(code, url)
            } else {
                // Their own page, in the browser: it comes back to your node, which says when you're in.
                started = Started.Page
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        })
    }

    Column(Modifier.fillMaxSize()) {
        PageBar(c?.label ?: "Connector", back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = Space.s4), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
            if (c == null) {
                problem?.let { Problem(it) } ?: Text("Reading it…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(Space.margin))
                return@Column
            }
            Column(Modifier.padding(horizontal = Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                c.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                if (c.installed) Connectors.state(c.key, c.signIn)?.let { state ->
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalAlignment = Alignment.CenterVertically) {
                        ToneBadge(state)
                        c.account?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    if (c.signIn == null) Connectors.keyState[c.key]?.second?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                c.problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.danger) }
            }
            when {
                !c.installed -> Panel {
                    if (c.needsOrigin) {
                        OutlinedTextField(
                            value = origin,
                            onValueChange = { origin = it },
                            label = { Text("Its address, e.g. http://homeassistant.local:8123") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Button(enabled = !working && (!c.needsOrigin || origin.isNotBlank()), onClick = {
                        run({ app.client!!.post("/api/connectors", Json.obj("id" to id, "origin" to origin.trim().ifEmpty { null })) })
                    }) { Text("Add ${c.label}") }
                    val said = c.keyHelp ?: if (c.kind == "mcp" && c.url != null) "Its own server, ${c.url.removePrefix("https://")}, and only that. ${if (c.signIn != null) "You sign in as yourself next: no key and no app of yours." else "It needs no sign-in."}" else null
                    said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                c.signIn != null -> Panel {
                    when {
                        mcp && c.key != "ready" -> {
                            SignInButton("Sign in to $who", working, started, context) { startSignIn() }
                            Text("As yourself, through $who's own page: no key and no app of yours. The node keeps the sign-in, sealed, and lists its tools then; nothing of it comes back to this phone.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        c.key == "missing" || c.key == "wrong-origin" -> {
                            Text("The app you registered with $who", style = MaterialTheme.typography.titleSmall)
                            OutlinedTextField(
                                value = client,
                                onValueChange = { client = it },
                                label = { Text(if (google) "1234-abc.apps.googleusercontent.com" else "00000000-0000-0000-0000-000000000000") },
                                singleLine = true,
                                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (google) {
                                OutlinedTextField(
                                    value = clientSecret,
                                    onValueChange = { clientSecret = it },
                                    label = { Text("Its client secret") },
                                    singleLine = true,
                                    visualTransformation = PasswordVisualTransformation(),
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            Button(enabled = !working && client.isNotBlank() && (!google || clientSecret.isNotBlank()), onClick = {
                                val secret = clientSecret.trim()
                                // Cleared before anything is sent: never shown back.
                                clientSecret = ""
                                run({ app.client!!.post("/api/oauth/app", Json.obj("connector" to id, "client" to client.trim(), "secret" to if (google) secret else null)) })
                            }) { Text("Seal the app") }
                            Text(
                                if (google) "Its redirect URI is ${paired?.origin?.let(Connectors::callback) ?: "your node's address followed by /oauth/callback"}. The secret is sealed in the vault and never shown again."
                                else "An app for any organization's and personal accounts, with public client flows on. Its id is sealed in the vault.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        c.key == "ready" -> {
                            OutlinedButton(enabled = !working, onClick = { run({ app.client!!.post("/api/oauth/signout", Json.obj("connector" to id)) }) }) { Text("Sign out", color = LocalBrand.current.failed) }
                            Text(if (mcp) "Sign in again any time." else "The app you registered stays: sign in again any time.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        else -> {
                            SignInButton("Sign in with $who", working, started, context) { startSignIn() }
                            Text("As yourself, through $who's own page: the node keeps the sign-in, sealed, and nothing of it comes back to this phone.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                c.key in setOf("missing", "optional-missing", "wrong-origin") -> Panel {
                    Text("Its key", style = MaterialTheme.typography.titleSmall)
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        label = { Text("Paste its key") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(enabled = !working && key.isNotBlank() && c.secret != null, onClick = {
                        val value = key.trim()
                        // Cleared before anything is sent: never shown back.
                        key = ""
                        run({ app.client!!.post("/api/secrets", Json.obj("name" to c.secret, "value" to value, "provider" to id)) })
                    }) { Text("Seal it") }
                    Text(c.keyHelp ?: "Sealed for your full nodes, pinned to ${c.label}'s own address, never shown again.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (c.allowed != null || c.private) {
                SectionTitle("Who may use it")
                Column(Modifier.padding(horizontal = Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                    c.allowed?.let { Text(if (it.isEmpty()) "${Primary.name}'s alone" else "${Primary.name}'s, and ${it.joinToString(", ")}'s", style = MaterialTheme.typography.bodyMedium) }
                    if (c.private) Text("What it reads stays in the answer that read it: the ledger keeps no word of it, and no agent reads its calls' words.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (merging.isNotEmpty()) {
                SectionTitle("Merging")
                for (m in merging) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                            Text(m.repository, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                            Text(if (m.on) "Merges itself" else "Off: the merge is yours", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        // Your switch for its own merging there (POST /api/team/merge, yours alone: fleet:admin).
                        Switch(checked = m.on, enabled = !working, onCheckedChange = { on -> run({ app.client!!.post("/api/team/merge", Json.obj("repository" to m.repository, "on" to on)) }) })
                    }
                }
                Text("${Primary.name} merges its agents' proven work itself where you leave it on: only its own pushes of that work, into your default branch, once GitHub says the pull request is clean and its checks pass. Off, the merge is yours.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.margin))
            }
            if (c.tools.isNotEmpty()) {
                SectionTitle("What it can do")
                for (tool in c.tools) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                            Text(tool.name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                            Text(Connectors.classLine(tool), style = MaterialTheme.typography.labelSmall, color = if (tool.asks) LocalBrand.current.needs else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (tool.description.isNotEmpty()) Text(tool.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3)
                    }
                }
            }
            if (c.installed) {
                OutlinedButton(onClick = { removing = true }, modifier = Modifier.padding(horizontal = Space.margin)) { Text("Remove ${c.label}", color = LocalBrand.current.failed) }
            }
            problem?.let { Problem(it) }
        }
    }
    if (removing) {
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text("Remove ${c?.label ?: "it"}?") },
            text = { Text("${Primary.name} can't reach it until you add it again. Its key or sign-in stays in the vault.") },
            confirmButton = { TextButton(onClick = { removing = false; run({ app.client!!.post("/api/connectors/remove", Json.obj("id" to id)) }, then = back) }) { Text("Remove", color = LocalBrand.current.failed) } },
            dismissButton = { TextButton(onClick = { removing = false }) { Text("Cancel") } },
        )
    }
}

/** Sign in, and what to do while it's open: finish at the page, or type the code at Microsoft's. */
@Composable
private fun SignInButton(title: String, working: Boolean, started: Started?, context: android.content.Context, start: () -> Unit) {
    Button(enabled = !working, onClick = start) { Text(title) }
    when (started) {
        Started.Page -> Text("Finish in the page that opened: choose your account and allow it. This page says when you're signed in.", style = MaterialTheme.typography.bodySmall)
        is Started.Code -> Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
            Text("Open ${Uri.parse(started.url).host ?: started.url}, sign in, and type this code:", style = MaterialTheme.typography.bodySmall)
            Text(started.code, style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedButton(onClick = { context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Code", started.code)) }) { Text("Copy") }
                OutlinedButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(started.url))) }) { Text("Open") }
            }
        }
        null -> {}
    }
}

/** A repository you gave an agent, and whether the primary merges its agents' proven work there itself (core's TeamMergeView). */
private data class Merging(val repository: String, val on: Boolean)
