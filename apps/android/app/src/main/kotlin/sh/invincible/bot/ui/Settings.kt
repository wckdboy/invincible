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
import sh.invincible.bot.core.Permissions
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.Providers
import sh.invincible.bot.core.Seats
import sh.invincible.bot.core.SettingsWords
import sh.invincible.bot.core.ThisPhone
import sh.invincible.bot.core.Usage
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string

/**
 * Settings, from the list's gear (the owner's words, 28 November 2026: "a settings menu for adding connectors, keys,
 * providers, permissions etc.", then "super simple chat like interface, modern simple sleek"): one plain list of eight,
 * each a page one tap deep. What the agents work with (Connectors, Keys, Providers, Permissions), then this app
 * (Notifications, Appearance, This device, About), as the iPhone's. No words under its rows; a newer build, when there is
 * one, comes first. Its rows are offered as this phone's scopes allow (AppModel.can), as the iPhone's are. [page]: one
 * of them open ("providers", "permissions", "notifications", "appearance", "device", "about"); [open] opens one.
 */
@Composable
fun SettingsScreen(app: AppModel, page: String?, open: (String) -> Unit, openKeys: () -> Unit, openConnectors: () -> Unit, back: () -> Unit) {
    val context = LocalContext.current
    val visit = { url: String -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    when (page) {
        "providers" -> ProvidersPage(app, back)
        "permissions" -> PermissionsPage(app, back)
        "notifications" -> SettingsPage("Notifications", back) { NotificationsSection(app, visit) }
        "appearance" -> SettingsPage("Appearance", back) { Group(listOf({ ThemeRow() }, { MarkRow() })) }
        "device" -> ThisDevicePage(app, back)
        "about" -> AboutPage(visit, back)
        else -> SettingsList(app, open, openKeys, openConnectors, visit, back)
    }
}

/** The list: two plain groups of rows, each its icon, its name and a chevron; About says the build. */
@Composable
private fun SettingsList(app: AppModel, open: (String) -> Unit, openKeys: () -> Unit, openConnectors: () -> Unit, visit: (String) -> Unit, back: () -> Unit) {
    val context = LocalContext.current
    var newer by remember { mutableStateOf<Updates.Newer?>(null) }
    LaunchedEffect(Unit) { newer = Updates.newer(context) }
    // (Read again as the node says what this phone may do.)
    val scopes by app.scopes.collectAsState()
    val reads = scopes?.contains("mind:read") ?: true
    SettingsPage("Settings", back) {
        newer?.let { n -> Group(listOf({ SettingRow("A newer ${Primary.name} is out", trail = { AnswerPill("Download", onClick = { visit(n.url) }) }) })) }
        Group(
            buildList<@Composable () -> Unit> {
                if (reads) add { LinkRow(PlugIcon, "Connectors", onClick = openConnectors) }
                if (scopes?.contains("vault:read") ?: true) add { LinkRow(KeyIcon, "Keys", onClick = openKeys) }
                if (reads) add { LinkRow(ChipIcon, "Providers") { open("providers") } }
                if (reads) add { LinkRow(ShieldIcon, "Permissions") { open("permissions") } }
            },
        )
        Group(
            buildList<@Composable () -> Unit> {
                if (reads) add { LinkRow(BellIcon, "Notifications") { open("notifications") } }
                add { LinkRow(ContrastIcon, "Appearance") { open("appearance") } }
                add { LinkRow(PhoneIcon, "This device") { open("device") } }
                add { LinkRow(InfoIcon, "About", value = appVersion(context)) { open("about") } }
            },
        )
    }
}

/** A page of Settings: its bar (back, its name), and its groups under it, as wide as the web's narrow page at most. */
@Composable
private fun SettingsPage(title: String, back: () -> Unit, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PageBar(title, back)
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s2, bottom = Space.s8),
                verticalArrangement = Arrangement.spacedBy(Space.s5),
            ) { content() }
        }
    }
}

/** A group of rows on the raised ground, nothing over it and nothing between them: whitespace says where one ends. */
@Composable
private fun Group(rows: List<@Composable () -> Unit>) {
    if (rows.isEmpty()) return
    Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(LocalBrand.current.raised)) {
        rows.forEach { it() }
    }
}

/** A row that opens a page: its icon, its name, what it holds where that is one word ([value]), and a chevron. */
@Composable
private fun LinkRow(icon: ImageVector, title: String, value: String? = null, onClick: () -> Unit) {
    SettingRow(title, lead = { RowIcon(icon) }, onClick = onClick, chevron = true, trail = value?.let { v -> { Text(v, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant) } })
}

/** What a read-only page says of itself, in one line. */
@Composable
private fun ReadOnly() {
    Text(SettingsWords.READ_ONLY, style = Type.meta, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.s1))
}

/** This build's version, as About and the list say it. */
private fun appVersion(context: android.content.Context): String =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""

/** What a page reads from the node as it opens, once: its answer, or why there is none. */
@Composable
private fun <T> readOnOpen(app: AppModel, path: String, read: (Json) -> T): Pair<T?, String?> {
    var got by remember(path) { mutableStateOf<T?>(null) }
    var problem by remember(path) { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        val client = app.client ?: return@LaunchedEffect
        try {
            got = read(client.get(path))
        } catch (e: NodeError) {
            problem = e.message
        }
    }
    return got to problem
}

/**
 * Providers, read-only (the lead's ruling, 28 November 2026): this period's usage, the providers your fleet uses, and
 * your seats (the accounts you hold with a vendor), each in a row of one line (SettingsWords.kt).
 */
@Composable
private fun ProvidersPage(app: AppModel, back: () -> Unit) {
    val meter by app.usage.collectAsState()
    val (providers, said) = readOnOpen(app, "/api/providers") { Providers.of(it).providers }
    val (seats, seatsSaid) = readOnOpen(app, "/api/seats") { it["seats"].list }
    val now = System.currentTimeMillis()
    SettingsPage("Providers", back) {
        ReadOnly()
        meter?.let { m -> Group(listOf({ SettingRow(Usage.period(m), sub = Usage.line(m)) })) }
        providers?.let { list ->
            Group(
                if (list.isEmpty()) listOf({ SettingRow(null, sub = "None yet: a key you add in Keys sets up its provider.") })
                else list.map { p -> { SettingRow(p.label ?: p.id, sub = listOfNotNull(p.kind.takeIf { it.isNotBlank() }, if (p.hasKey) "its key sealed" else null).joinToString(" · ")) } },
            )
        }
        seats?.let { list ->
            if (list.isNotEmpty()) {
                Group(
                    list.map { s ->
                        { SettingRow(s["label"].string ?: s["id"].string ?: "", sub = "${Seats.kindName(s["kind"].string ?: "")} · ${Seats.state(s["state"] ?: Json.obj(), s["plan"].string, now).first}") }
                    },
                )
            }
        }
        (said ?: seatsSaid)?.let { Text(it, style = Type.meta, color = LocalBrand.current.failed) }
    }
}

/**
 * Permissions, read-only (the lead's ruling, 28 November 2026): what always asks you, your rules on the commands the
 * work runs, and the hand-offs one node may make to another's agents without asking you, each in a row (SettingsWords.kt).
 */
@Composable
private fun PermissionsPage(app: AppModel, back: () -> Unit) {
    val (rules, said) = readOnOpen(app, "/api/rules") { it["rules"].list }
    // (The hand-offs only for a phone that may read them: fleet:admin.)
    val grantsAllowed = app.can("fleet:admin")
    val (grants, grantsSaid) = if (grantsAllowed) readOnOpen(app, "/api/fabric/grants") { it["grants"].list } else null to null
    SettingsPage("Permissions", back) {
        ReadOnly()
        Group(listOf({ SettingRow("Always asks you", sub = "Money, legal steps and anything that can't be undone.", lead = { RowIcon(ShieldIcon) }) }))
        rules?.let { list ->
            Group(
                if (list.isEmpty()) listOf({ SettingRow(null, sub = "No rules yet.") })
                else list.map { r -> { SettingRow(Permissions.ruleTitle(r["name"].string ?: ""), sub = r["rule"].takeIf { it is Json.Obj }?.let { Permissions.sentence(it) } ?: "Written by a newer node: not understood here.") } },
            )
        }
        grants?.let { list -> if (list.isNotEmpty()) Group(list.map { g -> { SettingRow(Permissions.handoffTitle(g), sub = Permissions.handoffTerms(g["terms"])) } }) }
        (said ?: grantsSaid)?.let { Text(it, style = Type.meta, color = LocalBrand.current.failed) }
    }
}

/** This device: its name, its key, what it may do, its node and fleet; and forgetting the node here. */
@Composable
private fun ThisDevicePage(app: AppModel, back: () -> Unit) {
    val paired by app.paired.collectAsState()
    val scopes by app.scopes.collectAsState()
    SettingsPage("This device", back) {
        paired?.let { p ->
            Group(
                listOfNotNull<@Composable () -> Unit>(
                    { Fact("Name", p.name) },
                    { Fact("Its key", ThisPhone.shortId(p.device, 16), mono = true) },
                    scopes?.let { s -> { Fact(SettingsWords.SCOPES, s.joinToString(", ").ifEmpty { "nothing" }) } },
                    { Fact("Node", ThisPhone.talksTo(p.nodeName, p.origin)) },
                    { Fact("Fleet", ThisPhone.fleet(p.fleetName, p.fleet)) },
                ),
            )
        }
        Group(listOf({ SettingRow(null, under = { ForgetThisDevice(app, outlined = true) }) }))
    }
}

/** About: the app and its build, its source, its site. */
@Composable
private fun AboutPage(visit: (String) -> Unit, back: () -> Unit) {
    val context = LocalContext.current
    SettingsPage("About", back) {
        Group(
            listOf(
                // The app's mark, on nothing (AppMark): no tile on a light page.
                { SettingRow("Invincible", sub = "App ${appVersion(context)} · open source (Apache-2.0)", lead = { AppMark(36.dp) }) },
                { SettingRow("The source on GitHub", onClick = { visit("https://github.com/wckdboy/invincible") }, end = ExternalIcon) },
                { SettingRow("invincible.sh", onClick = { visit("https://invincible.sh") }, end = ExternalIcon) },
            ),
        )
    }
}

/** How this phone shows the app: as the phone does, or always light, or always dark (AppearanceSetting). */
@Composable
private fun ThemeRow() {
    val context = LocalContext.current
    val theme by AppearanceSetting.theme(context)
    val choices = listOf("system", "light", "dark")
    SettingRow("Theme", under = { Segmented(listOf("System", "Light", "Dark"), choices.indexOf(theme).coerceAtLeast(0)) { AppearanceSetting.set(context, choices[it]) } })
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
    Group(rows)
}
