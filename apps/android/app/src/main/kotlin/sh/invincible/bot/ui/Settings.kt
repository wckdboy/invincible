@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.Notices
import sh.invincible.bot.app.UnifiedPush
import sh.invincible.bot.app.Updates
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeClient
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Primary

/** Settings (More, as it was): this phone's notifications, its keys and connectors, your node, this phone, the app and
 * the way out: forgetting the node here. Under "…", and the machine chip opens it. */
@Composable
fun SettingsScreen(app: AppModel, openKeys: () -> Unit, openConnectors: () -> Unit, back: () -> Unit) {
    val paired by app.paired.collectAsState()
    var forgetting by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
    var newer by remember { mutableStateOf<Updates.Newer?>(null) }
    LaunchedEffect(Unit) { newer = Updates.newer(context) }
    Column(Modifier.fillMaxSize()) {
    PageBar("Settings", back)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Space.margin), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
        newer?.let { n ->
            Panel {
                Text("A newer Invincible is out", style = MaterialTheme.typography.titleMediumEmphasized)
                Text("Build ${n.build} (${n.size}). It installs over this one: open it once it's downloaded.", style = MaterialTheme.typography.bodyMedium)
                Button(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(n.url))) }) { Text("Download") }
            }
        }
        NotificationsPanel(app)
        Panel {
            Text("Keys", style = MaterialTheme.typography.titleMediumEmphasized)
            Text("Your providers' and services' keys, sealed for your full nodes: add, replace or delete one. Never shown again, never seen by a model.", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = openKeys) { Text("Open Keys") }
        }
        Panel {
            Text("Connectors", style = MaterialTheme.typography.titleMediumEmphasized)
            Text("The services ${Primary.name} reaches for you (mail, calendars, GitHub and more): add one, sign in as yourself or seal its key, and see what it can do.", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = openConnectors) { Text("Open Connectors") }
        }
        GuardianPanel()
        paired?.let { p ->
            Panel {
                Text("Your node", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(p.fleetName ?: p.nodeName ?: Primary.name, style = MaterialTheme.typography.titleMediumEmphasized)
                Text(p.origin, style = MaterialTheme.typography.bodyMedium)
            }
            Panel {
                Text("This phone", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(p.name, style = MaterialTheme.typography.titleMediumEmphasized)
                Text("Its key: ${p.device.take(14)}…", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("Kept in this phone's secure hardware; every request is signed with it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Panel {
            // The app's mark, on nothing (AppMark): no tile on a light page.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                AppMark(40.dp)
                Column {
                    Text("Invincible $version", style = MaterialTheme.typography.titleMediumEmphasized)
                    Text("Open source (Apache-2.0).", style = MaterialTheme.typography.bodyMedium)
                }
            }
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/wckdboy/invincible"))) }) { Text("The source on GitHub") }
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://invincible.sh"))) }) { Text("invincible.sh") }
        }
        Spacer(Modifier.height(Space.s4))
        OutlinedButton(onClick = { forgetting = true }) { Text("Forget this node", color = LocalBrand.current.failed) }
    }
    }
    if (forgetting) {
        AlertDialog(
            onDismissRequest = { forgetting = false },
            title = { Text("Forget this node?") },
            text = { Text("This phone's key goes too. To use ${Primary.name} here again, join with a fresh invite. Your node keeps everything; remove this phone from its devices there.") },
            confirmButton = { TextButton(onClick = { forgetting = false; app.forget() }) { Text("Forget it", color = LocalBrand.current.failed) } },
            dismissButton = { TextButton(onClick = { forgetting = false }) { Text("Cancel") } },
        )
    }
}

/**
 * Notifications on this phone: on and off, instant or collected, a test, and what Android allows. Collected, the node
 * keeps them and this phone asks for them; instant, they come through a UnifiedPush distributor of your choice (Sunup,
 * ntfy, or another), encrypted to this phone's own key. What it sends and when it stays quiet are the node's settings.
 */
/** Your agent's mark on this phone: its I-beam on a tile in ink (as it comes), or in pearl glass. */
@Composable
private fun GuardianPanel() {
    val context = LocalContext.current
    val pearl by GuardianSetting.pearl(context)
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
            PrimaryMark(40.dp)
            Column(Modifier.weight(1f)) {
                Text("Your agent's mark", style = MaterialTheme.typography.titleMediumEmphasized)
                Text("Its I-beam, in ink or in pearl glass: this phone's choice alone.", style = MaterialTheme.typography.bodyMedium)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            FilterChip(selected = !pearl, onClick = { GuardianSetting.set(context, false) }, label = { Text("Ink") })
            FilterChip(selected = pearl, onClick = { GuardianSetting.set(context, true) }, label = { Text("Pearl glass") })
        }
    }
}

@Composable
private fun NotificationsPanel(app: AppModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var on by remember { mutableStateOf(Notices.on(context)) }
    var instant by remember { mutableStateOf(Notices.instant(context)) }
    var trouble by remember { mutableStateOf(Notices.trouble(context)) }
    var allowed by remember { mutableStateOf(Notices.allowed(context)) }
    var said by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // The distributors on this phone, read again while this is on screen (one installed meanwhile is offered at once).
    var distributors by remember { mutableStateOf(UnifiedPush.distributors(context)) }
    // The distributor this phone registered with (it may not have given its address yet): read again with the rest.
    var current by remember { mutableStateOf(UnifiedPush.registration(context)?.distributor) }
    val brand = LocalBrand.current
    // A distributor answers by broadcast: what it said is read again while this is on screen.
    LaunchedEffect(Unit) {
        var tick = 0
        while (true) {
            delay(1_000)
            on = Notices.on(context)
            instant = Notices.instant(context)
            trouble = Notices.trouble(context)
            current = UnifiedPush.registration(context)?.distributor
            if (++tick % 3 == 0) distributors = UnifiedPush.distributors(context)
        }
    }
    fun act(work: suspend (NodeClient) -> Unit) {
        val client = app.client ?: return
        busy = true
        scope.launch {
            try {
                work(client)
                said = null
            } catch (e: NodeError) {
                said = e.message
            } finally {
                busy = false
                on = Notices.on(context)
                instant = Notices.instant(context)
                current = UnifiedPush.registration(context)?.distributor
                allowed = Notices.allowed(context)
            }
        }
    }
    // Collected at once; instant as soon as the distributor gives an endpoint, if there is one.
    // (With several distributors, none is chosen for you: you pick one below.)
    suspend fun start(client: NodeClient) {
        Notices.turnOn(context, client)
        distributors.singleOrNull()?.let { Notices.makeInstant(context, client, it) }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = Notices.allowed(context)
        if (granted) act { start(it) } else said = "Android won't show them until notifications are allowed for Invincible."
    }
    Panel {
        Text("Notifications", style = MaterialTheme.typography.titleMediumEmphasized)
        Text(
            when {
                !on -> "Off. ${Primary.name} can tell you here when something needs you: an approval, a question, a finding, work that ended."
                instant != null -> "On, and instant: they come through $instant (UnifiedPush), encrypted to this phone, so its push server can't read them."
                else -> "On. This phone collects them from your node about every 15 minutes (Android may wait longer while it sleeps)."
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        val asked = current
        if (on && instant == null && asked != null && trouble == null) {
            Text("Asking ${UnifiedPush.label(context, asked)} for this phone's address: they're collected until it gives one.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (on && instant == null) {
            when (distributors.size) {
                0 -> {
                    Text("For them to arrive at once, install a UnifiedPush distributor such as Sunup (it uses Mozilla's push service, nothing to set up) or ntfy, then come back here.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://unifiedpush.org/users/distributors/"))) }) { Text("Find a distributor") }
                }
                1 -> TextButton(enabled = !busy, onClick = { act { Notices.makeInstant(context, it, distributors.single()) } }) { Text("Make them instant, through ${UnifiedPush.label(context, distributors.single())}") }
                else -> {
                    Text("Make them instant, through:", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (d in distributors) TextButton(enabled = !busy, onClick = { act { Notices.makeInstant(context, it, d) } }) { Text(UnifiedPush.label(context, d)) }
                }
            }
        }
        // Instant through one of several: another may be chosen in its place.
        if (on && instant != null && asked != null) {
            for (d in distributors.filter { it != asked }) {
                TextButton(enabled = !busy, onClick = { act { Notices.switchTo(context, it, d) } }) { Text("Switch to ${UnifiedPush.label(context, d)}") }
            }
        }
        trouble?.let { Text("Not instant: $it", style = MaterialTheme.typography.bodySmall, color = brand.needs) }
        if (on && !allowed) {
            Text("Android isn't showing them: notifications are off for Invincible.", style = MaterialTheme.typography.bodyMedium, color = brand.needs)
            TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("Open Android's settings") }
        }
        said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            if (on) {
                Button(enabled = !busy, onClick = {
                    act { client ->
                        client.post("/api/notify/test", Json.obj())
                        // Collected ones are shown now; an instant one arrives on its own.
                        if (instant == null) Notices.collect(context, client)
                    }
                }) { Text("Send a test") }
                TextButton(enabled = !busy, onClick = { act { Notices.turnOff(context, it) } }) { Text("Turn off") }
            } else {
                Button(enabled = !busy, onClick = {
                    if (Build.VERSION.SDK_INT >= 33 && !Notices.allowed(context)) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS) else act { start(it) }
                }) { Text("Turn on") }
            }
        }
        Text("What it sends, and the hours it stays quiet, are your node's settings: Settings in the web app, or invincible notify.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
