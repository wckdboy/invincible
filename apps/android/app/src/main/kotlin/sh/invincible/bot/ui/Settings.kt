@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
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
import sh.invincible.bot.core.ThisPhone

/**
 * Settings, as the web's: sections of plain rows, each section's name small and grey over its rows, which lie on the
 * raised ground with a hairline between each two, inside the page's margin once. How your agent looks here, this
 * phone's notifications, its keys and services, this phone and the node it talks to, the way out (forgetting the node
 * here), and the app. A newer build, when there is one, comes first. Under "Everything else".
 */
@Composable
fun SettingsScreen(app: AppModel, openKeys: () -> Unit, openConnectors: () -> Unit, back: () -> Unit) {
    val paired by app.paired.collectAsState()
    val context = LocalContext.current
    val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
    var newer by remember { mutableStateOf<Updates.Newer?>(null) }
    LaunchedEffect(Unit) { newer = Updates.newer(context) }
    val open = { url: String -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    Column(Modifier.fillMaxSize()) {
        PageBar("Settings", back)
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
            // (As wide as the web's narrow page at most, on a tablet's pane.)
            Column(
                Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s2, bottom = Space.s8),
                verticalArrangement = Arrangement.spacedBy(Space.s6),
            ) {
                newer?.let { n ->
                    Section("Update", listOf<@Composable () -> Unit>({
                        SettingRow(
                            "A newer ${Primary.name} is out",
                            sub = "Build ${n.build} (${n.size}). It installs over this one: open it once it's downloaded.",
                            trail = { AnswerPill("Download", onClick = { open(n.url) }) },
                        )
                    }))
                }
                Section("Appearance", listOf<@Composable () -> Unit>({ MarkRow() }))
                NotificationsSection(app, open)
                Section(
                    "Keys and services",
                    listOf<@Composable () -> Unit>(
                        { SettingRow("Keys", sub = "Your providers' and services' keys, sealed", lead = { RowIcon(KeyIcon) }, onClick = openKeys, chevron = true) },
                        { SettingRow("Connectors", sub = "Mail, calendars, GitHub and MCP servers", lead = { RowIcon(PlugIcon) }, onClick = openConnectors, chevron = true) },
                    ),
                )
                paired?.let { p ->
                    Section(
                        "This phone",
                        listOf<@Composable () -> Unit>(
                            { Fact("Name", p.name) },
                            { Fact("Its key", ThisPhone.shortId(p.device, 16), mono = true) },
                            { Fact("Talks to", ThisPhone.talksTo(p.nodeName, p.origin)) },
                            { Fact("Fleet", ThisPhone.fleet(p.fleetName, p.fleet)) },
                        ),
                        note = "Its key is kept in this phone's secure hardware; every request is signed with it.",
                    )
                }
                Section(
                    "Leave",
                    listOf<@Composable () -> Unit>({
                        SettingRow(
                            "Forget this device",
                            sub = "Deletes this phone's key here. Your node keeps everything: remove this phone from its devices there too.",
                            under = { ForgetThisDevice(app, outlined = true) },
                        )
                    }),
                    danger = true,
                )
                Section(
                    "About",
                    listOf<@Composable () -> Unit>(
                        // The app's mark, on nothing (AppMark): no tile on a light page.
                        { SettingRow("Invincible", sub = "App $version · open source (Apache-2.0)", lead = { AppMark(36.dp) }) },
                        { SettingRow("The source on GitHub", onClick = { open("https://github.com/wckdboy/invincible") }, end = ExternalIcon) },
                        { SettingRow("invincible.sh", onClick = { open("https://invincible.sh") }, end = ExternalIcon) },
                    ),
                )
            }
        }
    }
}

/** A section, as the web's Settings draws one: its name, small and grey, over its rows on the raised ground, a hairline
 * between each two; a note under them; the way out's in a red line. */
@Composable
private fun Section(title: String, rows: List<@Composable () -> Unit>, note: String? = null, danger: Boolean = false) {
    val brand = LocalBrand.current
    val shape = MaterialTheme.shapes.medium
    Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        Text(title, style = Type.section, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(brand.raised)
                .then(if (danger) Modifier.border(1.dp, brand.danger.copy(alpha = 0.45f), shape) else Modifier),
        ) {
            rows.forEachIndexed { i, row ->
                if (i > 0) Hairline()
                row()
            }
        }
        note?.let { Text(it, style = Type.small, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/**
 * A row, as the web's list rows: what it is, a grey line under it, and at its end what it offers (a switch, a button, a
 * chevron where it opens a page, an arrow where it leaves the app), at least 56 dp tall. What it offers may sit under
 * its words instead, where a phone is too narrow for both, as the web's rows wrap. With no title its line is all it says.
 */
@Composable
private fun SettingRow(
    title: String?,
    modifier: Modifier = Modifier,
    sub: String? = null,
    subTone: Color? = null,
    lead: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    chevron: Boolean = false,
    end: ImageVector? = null,
    under: (@Composable () -> Unit)? = null,
    trail: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .heightIn(min = 56.dp)
            .padding(horizontal = Space.s4, vertical = Space.s3),
        // (With a control under its words, the row's icon stays beside its title, as the web's wrapped rows keep it.)
        verticalAlignment = if (under != null) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        lead?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            title?.let { Text(it, style = Type.rowTitle) }
            sub?.let { Text(it, style = Type.meta, color = subTone ?: MaterialTheme.colorScheme.onSurfaceVariant) }
            under?.let { Box(Modifier.padding(top = Space.s2)) { it() } }
        }
        trail?.invoke()
        if (chevron) Icon(ChevronIcon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        end?.let { Icon(it, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A row's icon, as Everything else draws its places'. */
@Composable
private fun RowIcon(icon: ImageVector) = Icon(icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurface)

/** A fact about this phone, as the web's: what, in grey, then the fact. */
@Composable
private fun Fact(label: String, value: String, mono: Boolean = false) {
    Row(
        Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {}
            .heightIn(min = 48.dp)
            .padding(horizontal = Space.s4, vertical = Space.s3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.s3),
    ) {
        Text(label, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(80.dp))
        Text(value, style = if (mono) Type.mono else MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}

/** What a section says of how things stand, in a row of its own: said as it changes. */
@Composable
private fun NoteRow(text: String, tone: Color? = null) {
    Text(
        text,
        style = Type.meta,
        color = tone ?: MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }.padding(horizontal = Space.s4, vertical = Space.s3),
    )
}

/**
 * The web's segmented control: the choices side by side in a quiet track, the chosen one raised on the page's ground.
 * One is always chosen; each is at least 44 dp tall.
 */
@Composable
private fun Segmented(options: List<String>, selected: Int, choose: (Int) -> Unit) {
    val brand = LocalBrand.current
    val track = RoundedCornerShape(12.dp)
    val thumb = RoundedCornerShape(10.dp)
    Row(Modifier.clip(track).border(1.dp, brand.line, track).padding(2.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        options.forEachIndexed { i, option ->
            val on = i == selected
            Box(
                Modifier
                    .clip(thumb)
                    .then(if (on) Modifier.background(brand.paper).border(1.dp, brand.line, thumb) else Modifier)
                    .selectable(selected = on, role = Role.RadioButton, onClick = { choose(i) })
                    .heightIn(min = 44.dp)
                    .padding(horizontal = Space.s4),
                contentAlignment = Alignment.Center,
            ) {
                Text(option, style = Type.word, color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Your agent's mark on this phone: its bare I-beam in ink (as it comes), or in pearl glass. */
@Composable
private fun MarkRow() {
    val context = LocalContext.current
    val pearl by GuardianSetting.pearl(context)
    SettingRow(
        "Your agent's mark",
        sub = "Its I-beam, in ink or in pearl glass: this phone's choice alone.",
        lead = { PrimaryMark(36.dp) },
        under = { Segmented(listOf("Ink", "Pearl glass"), if (pearl) 1 else 0) { GuardianSetting.set(context, it == 1) } },
    )
}

/**
 * Notifications on this phone: on and off, instant or collected, a test, and what Android allows. Collected, the node
 * keeps them and this phone asks for them; instant, they come through a UnifiedPush distributor of your choice (Sunup,
 * ntfy, or another), encrypted to this phone's own key. What it sends and when it stays quiet are the node's settings.
 */
@Composable
private fun NotificationsSection(app: AppModel, open: (String) -> Unit) {
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
    val asked = current
    val rows = buildList<@Composable () -> Unit> {
        // The switch, and how they stand under it, as the web's "Notifications on this device".
        add {
            SettingRow(
                "Notifications on this phone",
                modifier = Modifier.toggleable(value = on, enabled = !busy, role = Role.Switch) { want ->
                    if (!want) act { Notices.turnOff(context, it) }
                    else if (Build.VERSION.SDK_INT >= 33 && !Notices.allowed(context)) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                    else act { start(it) }
                },
                sub = when {
                    !on -> "Off. ${Primary.name} can tell you here when something needs you: an approval, a question, a finding, work that ended."
                    instant != null -> "On, and instant: they come through $instant (UnifiedPush), encrypted to this phone, so its push server can't read them."
                    else -> "On. This phone collects them from your node about every 15 minutes (Android may wait longer while it sleeps)."
                },
                trail = { Switch(checked = on, onCheckedChange = null, enabled = !busy) },
            )
        }
        if (on && instant == null && asked != null && trouble == null) {
            add { NoteRow("Asking ${UnifiedPush.label(context, asked)} for this phone's address: they're collected until it gives one.") }
        }
        if (on && instant == null) {
            when (distributors.size) {
                0 -> add {
                    SettingRow(
                        "Make them instant",
                        sub = "Install a UnifiedPush distributor such as Sunup (it uses Mozilla's push service, nothing to set up) or ntfy, then come back here.",
                        onClick = { open("https://unifiedpush.org/users/distributors/") },
                        end = ExternalIcon,
                    )
                }
                1 -> add {
                    val d = distributors.single()
                    SettingRow(
                        "Make them instant",
                        sub = "Through ${UnifiedPush.label(context, d)}, encrypted to this phone.",
                        trail = { AnswerPill("Turn on", onClick = { act { Notices.makeInstant(context, it, d) } }, enabled = !busy) },
                    )
                }
                else -> add {
                    SettingRow(
                        "Make them instant",
                        sub = "Through one of the distributors on this phone, encrypted to it:",
                        under = {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
                                for (d in distributors) AnswerPill(UnifiedPush.label(context, d), onClick = { act { Notices.makeInstant(context, it, d) } }, enabled = !busy)
                            }
                        },
                    )
                }
            }
        }
        // Instant through one of several: another may be chosen in its place.
        if (on && instant != null && asked != null) {
            for (d in distributors.filter { it != asked }) {
                add { SettingRow("Switch to ${UnifiedPush.label(context, d)}", trail = { AnswerPill("Switch", onClick = { act { Notices.switchTo(context, it, d) } }, enabled = !busy) }) }
            }
        }
        trouble?.let { t -> add { NoteRow("Not instant: $t", brand.needs) } }
        if (on && !allowed) {
            add {
                SettingRow(
                    "Android isn't showing them",
                    sub = "Notifications are off for Invincible in Android's settings.",
                    subTone = brand.needs,
                    onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) },
                    chevron = true,
                )
            }
        }
        said?.let { s -> add { NoteRow(s, brand.failed) } }
        if (on) {
            add {
                SettingRow(
                    null,
                    sub = "A notification to this phone, now, to see that it arrives.",
                    trail = {
                        AnswerPill("Send a test", enabled = !busy, onClick = {
                            act { client ->
                                client.post("/api/notify/test", Json.obj())
                                // Collected ones are shown now; an instant one arrives on its own.
                                if (instant == null) Notices.collect(context, client)
                            }
                        })
                    },
                )
            }
        }
    }
    Section("Notifications", rows, note = "What it sends, and the hours it stays quiet, are your node's settings: Settings in the web app, or invincible notify.")
}
