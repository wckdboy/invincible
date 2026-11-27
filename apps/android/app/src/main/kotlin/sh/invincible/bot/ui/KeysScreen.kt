package sh.invincible.bot.ui

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.Keys
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Providers
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/** `GET /api/secrets`: a key sealed in the vault, as far as anyone ever sees it. Never its value. */
private data class Sealed(val name: String, val provider: String?, val hint: String?, val origin: String?, val label: String?, val updatedAt: String) {
    companion object {
        fun of(j: Json) = Sealed(j["name"].string ?: "", j["provider"].string, j["hint"].string, j["origin"].string, j["label"].string, j["updatedAt"].string ?: "")
    }
}

/** "A key of your own": no provider, pinned to the address you give. */
private const val OWN = "__own"

/**
 * The vault, as this phone may see it (the iPhone's Keys page, the PWA's Vault): every key sealed for your full nodes,
 * each pinned to the one address it may ever be sent to, its value never shown again and never seen by a model. Add one
 * (a provider's or a coding plan's is recognised by how it begins, and its provider set up), replace one (it stays
 * pinned where it was), or delete one by typing its name.
 */
@Composable
fun KeysScreen(app: AppModel, back: () -> Unit) {
    var keys by remember { mutableStateOf<List<Sealed>?>(null) }
    var providers by remember { mutableStateOf<Providers?>(null) }
    var unlocked by remember { mutableStateOf(true) }
    var problem by remember { mutableStateOf<String?>(null) }
    /** What the last seal did beyond sealing: a provider set up, a plan explained. */
    var notice by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var replacing by remember { mutableStateOf<Sealed?>(null) }
    var deleting by remember { mutableStateOf<Sealed?>(null) }
    var menu by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val client = app.client ?: return
        // Both read before either is shown.
        val found = runCatching { Providers.of(client.get("/api/providers")) }.getOrNull()
        try {
            val listed = client.get("/api/secrets")
            found?.let { providers = it }
            keys = listed["secrets"].list.map(Sealed::of).sortedBy { it.name }
            unlocked = listed["unlocked"].bool ?: true
            problem = null
        } catch (e: NodeError) {
            found?.let { providers = it }
            problem = "The vault couldn't be read: ${e.message}"
            if (keys == null) keys = emptyList()
        }
    }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        PageBar("Keys", back) {
            IconButton(onClick = { adding = true }) { Icon(PlusIcon, contentDescription = "Add a key") }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = Space.s4), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            Text(
                "Keys are sealed for your full nodes: never shown again, never seen by a model. The node adds a key to a call itself, and only to the address it's pinned to.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Space.margin, vertical = Space.s2),
            )
            if (!unlocked) Problem("This node holds no vault grant yet, so it can't use these keys. Another full node can.")
            notice?.let { Panel { Text(it, style = MaterialTheme.typography.bodyMedium) } }
            problem?.let { Problem(it) }
            val sealed = keys
            if (sealed == null && problem == null) {
                Text("Reading the vault…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(Space.margin))
            } else if (sealed != null && sealed.isEmpty()) {
                Panel {
                    Text("No keys yet", style = MaterialTheme.typography.titleMediumEmphasized)
                    Text("Add a provider's key, a coding plan's or a service's, and it's sealed for every full node. ${Primary.name} asks for one it needs in Needs you.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { adding = true }) { Text("Add a key") }
                }
            } else if (sealed != null) {
                SectionTitle("Sealed")
                for (key in sealed) {
                    Box {
                        KeyRow(key, providers?.presets?.firstOrNull { it.id == key.provider }?.plan) { menu = key.name }
                        DropdownMenu(expanded = menu == key.name, onDismissRequest = { menu = null }) {
                            DropdownMenuItem(text = { Text("Replace its key") }, onClick = { menu = null; replacing = key })
                            DropdownMenuItem(text = { Text("Delete…", color = LocalBrand.current.failed) }, onClick = { menu = null; deleting = key })
                        }
                    }
                }
            }
            providers?.providers?.takeIf { it.isNotEmpty() }?.let { list ->
                SectionTitle("Providers")
                for (p in list) ProviderRow(p, providers?.presets?.firstOrNull { it.id == p.id }?.plan)
            }
        }
    }

    if (adding || replacing != null) {
        AddKey(
            providers = providers,
            replacing = replacing,
            close = { adding = false; replacing = null },
            seal = { name, value, provider, label, address ->
                val client = app.client ?: throw NodeError(0, "This phone isn't paired.")
                client.post("/api/secrets", Json.obj("name" to name, "value" to value, "provider" to provider, "label" to label, "baseUrl" to address))
                // A provider for it, set up where it is pinned (never for a replacement: it stays as it was).
                var said: String? = null
                val view = providers
                if (provider != null && view != null && replacing == null) {
                    val (request, say) = Keys.setup(view, provider, name, mayConfigure = true, baseUrl = address)
                    said = say
                    if (request != null) {
                        try {
                            client.post("/api/providers", request.json())
                        } catch (e: NodeError) {
                            said = "The key is sealed, but setting up $provider failed: ${e.message}"
                        }
                    }
                }
                notice = said
                adding = false
                replacing = null
                // (On this page's own scope: the dialog's goes with it as it closes.)
                scope.launch { load() }
            },
        )
    }

    deleting?.let { key ->
        var typed by remember(key.name) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${key.name}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                    Text("It's removed from the vault on every node, and what uses it stops working until you add a key again. This doesn't revoke it at its provider: do that there if it may have leaked. Type its name to delete it.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { typed = it },
                        singleLine = true,
                        placeholder = { Text(key.name, fontFamily = FontFamily.Monospace) },
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(enabled = typed == key.name, onClick = {
                    deleting = null
                    scope.launch {
                        try {
                            app.client?.post("/api/secrets/delete", Json.obj("name" to key.name))
                            notice = null
                            load()
                        } catch (e: NodeError) {
                            problem = e.message
                        }
                    }
                }) { Text("Delete key", color = LocalBrand.current.failed) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/** A sealed key: its name and last characters, what it's for, and where it may ever go. */
@Composable
private fun KeyRow(key: Sealed, plan: Providers.Plan?, open: () -> Unit) = Column(Modifier.fillMaxWidth()) {
    Column(
        Modifier.fillMaxWidth().clickable(onClickLabel = "Replace or delete", role = Role.Button, onClick = open).padding(horizontal = Space.margin, vertical = Space.s2),
        verticalArrangement = Arrangement.spacedBy(Space.s1),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Text(key.name, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
            key.hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        key.label?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        plan?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        // Keys are pinned: shown so you can see exactly where this one may ever go.
        if (key.origin != null) {
            Text("only to ${key.origin.replace(Regex("^https?://"), "")}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Text("pinned nowhere: never used", style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.failed)
        }
        sealedAt(key.updatedAt)?.let { Text("Sealed $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    HorizontalDivider(Modifier.padding(start = Space.margin))
}

/** A provider your fleet uses: whether its key is sealed, and where. */
@Composable
private fun ProviderRow(p: Providers.Provider, plan: Providers.Plan?) {
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2), horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            Text(p.id, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
            plan?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            // Pointed elsewhere since its key was added: the key stays where it was, and this says so.
            p.keyElsewhere?.let { Text("Its key was added for $it. Add it again with ${p.baseUrl} as its other address.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(
            if (p.hasKey) "Key sealed" else if (p.keyElsewhere != null) "Key for another address" else "No key yet",
            style = MaterialTheme.typography.bodySmall,
            color = if (p.hasKey) MaterialTheme.colorScheme.onSurfaceVariant else LocalBrand.current.failed,
        )
    }
}

/** When a key was sealed, from its HLC (milliseconds first), as a while ago. */
private fun sealedAt(hlc: String): String? {
    val ms = hlc.substringBefore('.').toLongOrNull()?.takeIf { it > 0 } ?: return null
    return DateUtils.getRelativeTimeSpanString(ms, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
}

/**
 * Sealing a key: the key first, in a hidden field cleared before anything is sent; then what it's for (a provider's or
 * a coding plan's is recognised by how it begins, and a subscription's sign-in is never taken for one), its name and a
 * label. Replacing one keeps its name, what it's for and where it's pinned.
 */
@Composable
private fun AddKey(
    providers: Providers?,
    replacing: Sealed?,
    close: () -> Unit,
    seal: suspend (name: String, value: String, provider: String?, label: String?, address: String?) -> Unit,
) {
    var value by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var provider by remember { mutableStateOf("") }
    /** A provider you chose yourself is never changed by what the key looks like. */
    var chosen by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf("") }
    var another by remember { mutableStateOf(false) }
    var label by remember { mutableStateOf("") }
    var sealing by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val presets = providers?.presets ?: emptyList()
    val preset = presets.firstOrNull { it.id == provider }
    // Your own providers that aren't one of the node's presets.
    val yours = providers?.providers?.filter { mine -> presets.none { it.id == mine.id } } ?: emptyList()
    // A preset with no address of its own (a Cloudflare AI Gateway): its key goes only to the address you give with it.
    val needsAddress = preset != null && preset.baseUrl.isNullOrEmpty()
    val mayGiveAnother = provider.isNotEmpty() && provider != OWN && !needsAddress
    val addressShown = provider == OWN || needsAddress || (another && mayGiveAnother)
    val signIn = providers?.let { Keys.signIn(value.trim(), it) }

    /** What the key looks like chooses its provider, and its name, until you choose them. */
    fun recognise(typed: String) {
        val view = providers ?: return
        if (replacing != null || chosen) return
        val key = typed.trim()
        if (Keys.signIn(key, view) != null) {
            if (presets.any { it.id == name }) name = ""
            provider = ""
            return
        }
        val found = Keys.providerOf(key, view) ?: return
        provider = found
        if (name.isEmpty() || presets.any { it.id == name }) name = found
    }

    fun pick(id: String) {
        provider = id
        chosen = true
        if (id != OWN && (name.isEmpty() || presets.any { it.id == name } || yours.any { it.id == name })) name = id
    }

    val ready = value.isNotBlank() && !sealing && (replacing != null || Keys.nameOk(name)) && (signIn == null || provider == OWN)
    AlertDialog(
        onDismissRequest = { if (!sealing) close() },
        title = { Text(replacing?.let { "Replace ${it.name}" } ?: "Add a key") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it; recognise(it) },
                    label = { Text("Paste the key") },
                    supportingText = { Text("Recognised from how it begins, where it can be. Never shown again.") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                signIn?.let {
                    Text("A ${it.tool} sign-in, not a key", style = MaterialTheme.typography.titleSmall, color = LocalBrand.current.failed)
                    Text("${it.why} To work on your ${it.vendor} subscription, sign ${it.tool} in inside an agent's VM, with ${it.vendor}'s own sign-in.", style = MaterialTheme.typography.bodySmall)
                }
                if (replacing != null) {
                    Text(replacing.name, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
                    replacing.origin?.let { Text("Only to $it", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                    Text("The new key takes its place, pinned where the old one was.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Box {
                        OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) {
                            Text(
                                when (provider) {
                                    "" -> "What it's for…"
                                    OWN -> "A key of your own"
                                    else -> preset?.plan?.name ?: provider
                                },
                            )
                        }
                        DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                            val plans = presets.filter { it.plan != null }
                            if (plans.isNotEmpty()) {
                                Text("Coding plans", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.s4, vertical = Space.s1))
                                for (p in plans) DropdownMenuItem(text = { Text(p.plan?.name ?: p.id) }, onClick = { picking = false; pick(p.id) })
                            }
                            Text("Providers", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.s4, vertical = Space.s1))
                            for (p in presets.filter { it.plan == null }) DropdownMenuItem(text = { Text(p.id, fontFamily = FontFamily.Monospace) }, onClick = { picking = false; pick(p.id) })
                            if (yours.isNotEmpty()) {
                                Text("Yours", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.s4, vertical = Space.s1))
                                for (p in yours) DropdownMenuItem(text = { Text(p.id, fontFamily = FontFamily.Monospace) }, onClick = { picking = false; pick(p.id) })
                            }
                            DropdownMenuItem(text = { Text("A key of your own") }, onClick = { picking = false; pick(OWN) })
                        }
                    }
                    val said = when {
                        another && mayGiveAnother -> "Its own is ${preset?.baseUrl ?: "the one it has"}. Give another only where its page shows one (another region's): the key is only ever sent to the address you give."
                        preset?.plan != null -> "${Keys.planLine(preset)} ${preset.plan.says}"
                        preset?.note != null && preset.baseUrl.isNullOrEmpty() -> preset.note
                        provider == OWN -> "A key of your own is sent only to the address you give, and never used without one."
                        else -> "A provider or a coding plan pins it to its own address."
                    }
                    Text(said, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (addressShown) {
                        OutlinedTextField(
                            value = address,
                            onValueChange = { address = it },
                            label = { Text(if (needsAddress) "Its address, https://…" else if (provider == OWN) "Only sent to, e.g. https://api.example.com" else "Another address, https://…") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else if (mayGiveAnother) {
                        TextButton(onClick = { another = true }) { Text("Another address") }
                    }
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        placeholder = { Text("e.g. anthropic", fontFamily = FontFamily.Monospace) },
                        supportingText = { Text("Letters, digits and . _ : - (a provider's own name ties the key to it).") },
                        isError = name.isNotEmpty() && !Keys.nameOk(name),
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(value = label, onValueChange = { label = it }, label = { Text("Label") }, placeholder = { Text("e.g. personal account") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalBrand.current.failed) }
                Spacer(Modifier.height(Space.s1))
            }
        },
        confirmButton = {
            TextButton(enabled = ready, onClick = {
                val key = value.trim()
                // The field is cleared before anything is sent: the key is never shown back.
                value = ""
                sealing = true
                scope.launch {
                    try {
                        if (replacing != null) {
                            // Pinned where it was: the address it was entered with is given again, so the node pins it there.
                            seal(replacing.name, key, replacing.provider, replacing.label, replacing.origin)
                        } else {
                            seal(name.trim(), key, if (provider == OWN || provider.isEmpty()) null else provider, label.trim().ifEmpty { null }, if (addressShown) address.trim().ifEmpty { null } else null)
                        }
                    } catch (e: NodeError) {
                        problem = "${e.message} Paste it again."
                    } finally {
                        sealing = false
                    }
                }
            }) { Text(if (sealing) "Sealing…" else "Seal") }
        },
        dismissButton = { TextButton(enabled = !sealing, onClick = close) { Text("Cancel") } },
    )
}
