package sh.invincible.bot.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sh.invincible.bot.core.After
import sh.invincible.bot.core.Ask
import sh.invincible.bot.core.Followers
import sh.invincible.bot.core.LinkHandlers
import sh.invincible.bot.core.Live
import sh.invincible.bot.core.LiveLink
import sh.invincible.bot.core.NetworkWatch
import sh.invincible.bot.core.liveOpen
import sh.invincible.bot.core.DeviceKey
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeClient
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Reach
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.RosterRow
import sh.invincible.bot.core.Price
import sh.invincible.bot.core.ProjectName
import sh.invincible.bot.core.Snapshot
import sh.invincible.bot.core.Spend
import sh.invincible.bot.core.TeamTask
import sh.invincible.bot.core.UsageMeter
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.text
import sh.invincible.bot.core.Primary

/** The node this phone is paired with (kept as the Apple app keeps its PairedNode, outside any backup). */
data class PairedNode(val origin: String, val device: String, val name: String, val fleet: String, val nodeName: String?, val fleetName: String?) {
    fun json(): Json = Json.obj("origin" to origin, "device" to device, "name" to name, "fleet" to fleet, "nodeName" to nodeName, "fleetName" to fleetName)

    companion object {
        fun of(j: Json): PairedNode? {
            return PairedNode(
                j["origin"].string ?: return null, j["device"].string ?: return null, j["name"].string ?: return null,
                j["fleet"].string ?: return null, j["nodeName"].string, j["fleetName"].string,
            )
        }
    }
}

/** What the Inbox holds: what only you can answer, and what your node told you. As the iPhone's Inbox holds it. */
data class Inbox(
    val actions: List<Json> = emptyList(),
    val questions: List<Json> = emptyList(),
    val keys: List<Json> = emptyList(),
    val pairings: List<Json> = emptyList(),
    /** Facts about you it proposed, waiting for you (what you keep goes with every answer it gives). */
    val facts: List<Json> = emptyList(),
    /** What the heartbeat, a loop or a rule of yours told you, still open. */
    val notices: List<Json> = emptyList(),
    /** Its asks to use a Mac itself, and its sessions on one now. */
    val screens: List<Json> = emptyList(),
) {
    val count: Int get() = actions.size + questions.size + keys.size + pairings.size + facts.size + notices.size + screens.size

    companion object {
        /** The notices still open: one you dismissed stays quiet until it changes. */
        fun open(notices: List<Json>): List<Json> = notices.filter { it["dismissed"].bool != true }

        /** Its sessions on a Mac that are yours to answer or end: asked and waiting, or allowed and under way. */
        fun live(screens: List<Json>): List<Json> = screens.filter { it["state"].string == "waiting" || it["state"].string == "allowed" }

        /** Where a notice came from, as you'd say it: `rule:pushes` is "Your rule pushes" (the iPhone's words). */
        fun from(source: String): String {
            val kind = source.substringBefore(':', "")
            val name = source.substringAfter(':', "")
            if (name.isNotEmpty()) mapOf("rule" to "Your rule", "loop" to "The loop")[kind]?.let { return "$it $name" }
            return mapOf("heartbeat" to "The heartbeat", "ci" to "CI", "compute" to "Its compute")[source] ?: source
        }

        /**
         * A device asking to join, as the Inbox's list tells one apart from another: by its invite and its key together,
         * since one device may ask again with a new invite while its first ask still waits.
         */
        fun pairingKey(p: Json): String = "p:${p["invite"].string}:${p["device"].string}"
    }
}

/** The agents as this phone last read it. */
data class Table(
    val snapshot: Snapshot? = null,
    val rows: List<RosterRow> = emptyList(),
    val primary: Roster.Now = Roster.primaryNow(turns = emptyList(), runs = emptyList(), needs = null),
    /** Chats with an answer you haven't read, newest first. */
    val unread: List<Json> = emptyList(),
    /** Which writing of the chats the node said last (`chats` on GET /api/turns): when it moves, an open chat is read again. */
    val chats: String? = null,
    /** The last team this phone kept, as the node said it then (KeptTable): until the node answers. Null: the node's answer. */
    val asOf: Long? = null,
    /** The team's tasks as the work reads them (Work, a task's thread): read from the same answer as [snapshot]. */
    val tasks: List<TeamTask> = emptyList(),
) {
    /**
     * The agents after a look at the node: `team` its answer for the team (null: it couldn't be read), `turns` its
     * answer for the chats, `asks` the approvals waiting and `waiting` everything that waits for you, at `now`. Until the
     * node has answered for the team, a kept team stays as it was kept, never redrawn with what else came back (an
     * empty Inbox while the node is away), so it is never taken for the node's word; otherwise its last team is drawn
     * again with what's new.
     */
    fun after(team: Snapshot?, turns: Json?, asks: List<Ask>, waiting: Int, now: Long, tasks: List<TeamTask>? = null): Table {
        if (team == null && asOf != null) return this
        val snapshot = team ?: this.snapshot
        val work = if (team != null) tasks ?: emptyList() else this.tasks
        val unread = turns?.let { it["unread"].list } ?: this.unread
        val primary = Roster.primaryNow(
            turns = (turns?.let { it["turns"].list } ?: emptyList()).map { it["title"].string },
            runs = emptyList(),
            needs = Roster.primaryNeeds(waiting, asks, snapshot?.agents?.map { it.id } ?: emptyList()),
            unread = unread.map { it["title"].string },
        )
        return Table(snapshot, snapshot?.let { Roster.rows(it, asks, now) } ?: emptyList(), primary, unread, turns?.get("chats")?.text() ?: chats, tasks = work)
    }
}

/** How the fleet stands, for the machine chip: how many of its nodes are online. */
data class FleetLook(val nodes: Int, val online: Int) {
    companion object {
        /** GET /api/fleet: its nodes (not revoked), and which are online (this node is, the others as their peers say). */
        fun of(j: Json): FleetLook {
            val self = j["self"].string
            val nodes = j["devices"].list.filter { it["kind"].string == "node" && (it["revokedAt"] == null || it["revokedAt"] == Json.Null) }
            val peers = j["peers"].list
            val online = nodes.count { d -> d["id"].string == self || peers.any { it["device"].string == d["id"].string && it["online"].bool == true } }
            return FleetLook(nodes.size, online)
        }
    }
}

/**
 * The app's state, one for the process (a rotation or a new window keeps it): the pairing, the device key, and what the
 * node last said. While the app is on screen it keeps the node's live stream open (core's live.ts; LiveLink), which says
 * what changed, and reads again only that, and what you answer at once after; off screen it asks nothing (Android would
 * stop it anyway, and the battery is yours). While the stream is down it asks on a timer, as it did before there was one,
 * and says it can't reach the node.
 */
class AppModel(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = context.getSharedPreferences("invincible", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** This phone's key as the Keystore gave it when the app started: each read is a call to the Keystore's service. */
    private var key: DeviceKey? = null

    private val _paired = MutableStateFlow(load())
    val paired: StateFlow<PairedNode?> = _paired.asStateFlow()

    private val _table = MutableStateFlow(Table())
    val table: StateFlow<Table> = _table.asStateFlow()

    private val _inbox = MutableStateFlow(Inbox())
    val inbox: StateFlow<Inbox> = _inbox.asStateFlow()

    /** This period's model calls at your prices, against your budget (null: not read yet, or a node from before the meter). */
    private val _usage = MutableStateFlow<UsageMeter?>(null)
    val usage: StateFlow<UsageMeter?> = _usage.asStateFlow()

    /** Your projects (GET /api/projects), for the names the work's projects go by: asked once a session (again if it failed). */
    private val _projects = MutableStateFlow<List<ProjectName>>(emptyList())
    val projects: StateFlow<List<ProjectName>> = _projects.asStateFlow()
    private var projectsAsked = false

    /** Your prices as money goes (GET /api/prices, coding plans free), for what a task and an agent cost: asked once a session. */
    private val _prices = MutableStateFlow<Map<String, Price>?>(null)
    val prices: StateFlow<Map<String, Price>?> = _prices.asStateFlow()

    /** How the fleet stands (GET /api/fleet): read when the live stream says it changed (every minute while it is down). */
    private val _fleet = MutableStateFlow<FleetLook?>(null)
    val fleet: StateFlow<FleetLook?> = _fleet.asStateFlow()
    /** The primary's name has been asked for this session (whoami). */
    private var primaryAsked = false

    /** Whether the node is reached (its live stream up): null until it is first known, false while it can't be. */
    private val _online = MutableStateFlow<Boolean?>(null)
    val online: StateFlow<Boolean?> = _online.asStateFlow()

    /** The last thing that went wrong asking the node (null: the last ask was answered). */
    private val _problem = MutableStateFlow<NodeError?>(null)
    val problem: StateFlow<NodeError?> = _problem.asStateFlow()

    /** An invite handed over by an `invincible:` link or a share, to join with. */
    val handed = MutableStateFlow<String?>(null)

    /**
     * Where a tapped notification, or one of its buttons, opens the app (Notices.opening): Nav's address (the very task, the
     * chat, the Inbox, Settings, Home), the kept chat it names, the approval whose card Approve… opens, and whether a
     * task's Ship it… was pressed.
     */
    data class Opening(val address: String, val conversation: String? = null, val approval: String? = null, val ship: Boolean = false)

    val opening = MutableStateFlow<Opening?>(null)

    /** What the app shows now (Nav's address), so a notification about that very thing is told quietly. */
    val showing = MutableStateFlow<String?>(null)

    /** An approval opened from its notification's Approve…: its card first in the Inbox. */
    val approvalAsked = MutableStateFlow<String?>(null)

    /** A task whose notification's Ship it… was pressed: its ship is asked as its page opens. */
    val shipAsked = MutableStateFlow<String?>(null)

    /** The app is on screen (its activity started): what asks the node again and again asks only then. */
    val front = MutableStateFlow(false)

    /** Something shared from another app, for a new chat's message box: its words, and pictures to attach. */
    data class Shared(val words: String?, val pictures: List<android.net.Uri>)

    val shared = MutableStateFlow<Shared?>(null)

    val chat = ChatModel(this)

    var client: NodeClient? = null
        private set

    /** The last team this phone saw (KeptTable): in the app's own storage, never backed up. */
    private val keptFile = java.io.File(appContext.noBackupFilesDir, "agents.json")
    /** What was last written there (without its time), and when: written again when it changes, or ten minutes on. */
    private var keptWords: String? = null
    private var keptAt = 0L
    /** One at a time, in order: a write still under way never brings back what forgetting the node took away. */
    private val keeper = Dispatchers.IO.limitedParallelism(1)

    init {
        connect()
        restore()
    }

    /** The kept team, if it is this node's and this key's: drawn until the node answers. */
    private fun restore() {
        val node = _paired.value ?: return
        val kept = runCatching { KeptTable.read(Json.parse(keptFile.readText()), node) }.getOrNull() ?: return
        val snapshot = runCatching { Snapshot.of(kept.team) }.getOrNull() ?: return
        val needs = Roster.primaryNeeds(kept.waiting, kept.asks, snapshot.agents.map { it.id })
        val primary = Roster.primaryNow(turns = kept.turns, runs = emptyList(), needs = needs, unread = kept.unread.map { it["title"].string })
        _table.value = Table(snapshot, Roster.rows(snapshot, kept.asks, System.currentTimeMillis()), primary, kept.unread, asOf = kept.at, tasks = TeamTask.all(kept.team))
    }

    /** What the node just said of the agents, kept for the next time the app opens (off the main thread). */
    private fun keep(team: Json, turns: Json?, asks: List<Ask>, waiting: Int) {
        val node = _paired.value ?: return
        scope.launch(keeper) {
            val now = System.currentTimeMillis()
            val words = KeptTable.of(node, team, turns, asks, waiting, at = 0).text()
            if (words == keptWords && now - keptAt < 10 * 60_000L) return@launch
            runCatching {
                val next = java.io.File(keptFile.parentFile, "agents.json.next")
                next.writeText(KeptTable.of(node, team, turns, asks, waiting, at = now).text())
                if (!next.renameTo(keptFile)) error("not kept")
                keptWords = words
                keptAt = now
            }
        }
    }

    /** The kept team goes (another node, or none), after any write still under way. */
    private fun unkeep() {
        scope.launch(keeper) {
            runCatching { keptFile.delete() }
            keptWords = null
            keptAt = 0
        }
    }

    /** Paired only while the key that paired is still this phone's (a reinstall forgets the Keystore's key). */
    private fun load(): PairedNode? {
        val stored = prefs.getString("paired-node", null)?.let { runCatching { PairedNode.of(Json.parse(it)) }.getOrNull() } ?: return null
        val key = runCatching { DeviceKey.load() }.getOrNull() ?: return null
        this.key = key
        return stored.takeIf { it.device == key.device }
    }

    private fun connect() {
        val node = _paired.value
        client = if (node != null) (key ?: runCatching { DeviceKey.load() }.getOrNull())?.let { NodeClient(node.origin, it) } else null
    }

    fun paired(node: PairedNode) {
        unkeep()
        prefs.edit().putString("paired-node", node.json().text()).apply()
        _paired.value = node
        connect()
        scope.launch { refresh() }
    }

    /**
     * Your budget for the node's model calls (a line to watch, never a stop): a day's or a month's, or none. None goes as
     * null, never left out: the node takes null for no budget.
     */
    suspend fun setBudget(usd: Double?, per: String) {
        val c = client ?: return
        c.post("/api/usage/budget", Json.Obj(linkedMapOf("usd" to Json.of(usd), "per" to Json.of(per)))).let(UsageMeter::of)?.let { _usage.value = it }
    }

    /** Forget the node here: the key goes too, so this phone's old id is no longer anyone's. */
    fun forget() {
        Notices.stop(appContext)
        UnifiedPush.unregister(appContext)
        prefs.edit().remove("paired-node").apply()
        runCatching { DeviceKey.forget() }
        key = null
        unkeep()
        _paired.value = null
        client = null
        _table.value = Table()
        _inbox.value = Inbox()
        _usage.value = null
        _projects.value = emptyList()
        projectsAsked = false
        _prices.value = null
        _fleet.value = null
        primaryAsked = false
        chat.reset()
    }

    /** The card that says it can't reach this phone when Invincible is closed (null: it can, or you put it away), and why. */
    data class ReachCard(val step: Reach.Step, val lost: String?, val offElsewhere: Boolean)

    private val _reach = MutableStateFlow<ReachCard?>(null)
    val reach: StateFlow<ReachCard?> = _reach

    /** Not now: the card goes until the app next comes to the front. */
    fun putReachAway() {
        _reach.value = null
    }

    /**
     * The app has come to the front: what was answered elsewhere is taken down here; what the node kept for this phone is
     * taken and dropped (the app shows it all); and its notifications are handed over again while they're on or were lost
     * (core's notifyReach): a lost UnifiedPush address falls back to collecting at once, and the distributor is asked for a
     * new one. Otherwise the card says how to turn them on, instead of the phone going quiet without a word.
     */
    suspend fun inFront() {
        val c = client ?: return
        val view = runCatching { c.get("/api/notify") }.getOrNull() ?: return
        val subscribed = view["subscribed"].bool ?: return
        Notices.takeDown(appContext, view["withdrawn"].list.mapNotNull { it.string })
        val lost = view["lost"].takeIf { it is Json.Obj }
        val localOn = Notices.on(appContext)
        val permission = when {
            Notices.allowed(appContext) -> "granted"
            Build.VERSION.SDK_INT >= 33 && appContext.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED -> "undetermined"
            else -> "denied"
        }
        val step = Reach.step(permission, subscribed, lost != null, view["reachable"].int ?: 1, localOn)
        val lostLine = lost?.let { l -> l["at"].long?.let { Reach.lostLine(it, l["service"].string ?: "its") } }
        when (step) {
            Reach.Step.RENEW -> {
                if (lost != null) {
                    // Its push service dropped this phone's address: collected from now on, at once, and its distributor asked
                    // for a new address (the receiver hands that over); said in More → Notifications meanwhile.
                    val distributor = UnifiedPush.registration(appContext)?.distributor
                    runCatching { Notices.turnOn(appContext, c) }
                    Notices.trouble(appContext, "${lostLine ?: "Its push service stopped taking them."} Collected until it gives a new address.")
                    if (distributor != null) runCatching { Notices.makeInstant(appContext, c, distributor) }
                } else if (Notices.instant(appContext) == null) runCatching { Notices.turnOn(appContext, c) }
                _reach.value = null
            }
            Reach.Step.TURN_ON, Reach.Step.SETTINGS -> {
                // Turned off elsewhere (the web app, the terminal) while this phone thought itself on: it stops asking, and says so.
                val offElsewhere = localOn && !subscribed && lost == null
                if (offElsewhere) Notices.stop(appContext)
                _reach.value = ReachCard(step, lostLine, offElsewhere)
            }
            Reach.Step.NONE -> _reach.value = null
        }
        // Told through a distributor whose server refuses them (it can't reach this phone): said in Settings, and they're
        // collected meanwhile (the node keeps what was refused). In front, what was kept is taken and dropped: the app shows it.
        if (Notices.instant(appContext) != null) {
            val mine = view["devices"].list.firstOrNull { it["device"].string == _paired.value?.device }
            Notices.trouble(appContext, mine?.get("lastError")?.string?.let { "$it. Collected meanwhile, as often as Android lets this phone ask." })
        }
        if (Notices.on(appContext)) runCatching { Notices.collect(appContext, c, show = false) }
    }

    // ---- the live stream, and what it says to read ----

    /** The routes the screens show: each with the live topics that say it changed, and how often it is asked while the
     * stream is down (as every route was, every five seconds, before there was a stream). */
    private data class Route(val path: String, val topics: List<String>, val everyMs: Long, val gapMs: Long = Live.GAP_MS)

    private val routes = listOf(
        // (The largest answer: no oftener than a second, however busy the agents are.)
        Route(TEAM, listOf("team"), 5_000, gapMs = 1_000),
        Route("/api/actions", listOf("actions"), 5_000),
        Route("/api/questions", listOf("questions"), 5_000),
        Route("/api/secret-requests", listOf("secretRequests"), 5_000),
        Route("/api/pairings", listOf("pairings"), 5_000),
        Route("/api/turns", listOf("turns"), 5_000),
        Route("/api/about-you", listOf("aboutYou"), 5_000),
        Route("/api/notices", listOf("notices"), 5_000),
        Route("/api/screen/sessions", listOf("screenSessions"), 5_000),
        // (Spend moves as turns, runs and the agents' work do: no topic of its own. Read now and then while they move.)
        Route("/api/usage/meter", listOf("turns", "runs", "team"), 60_000, gapMs = 30_000),
        Route("/api/fleet", listOf("fleet"), 60_000),
    )

    /** What each route last answered: the pieces the Inbox and the table are made of. One that fails keeps what it had. */
    private val answers = HashMap<String, Json>()

    private val main = Handler(Looper.getMainLooper())
    private val afterMain: After = { ms, run ->
        val step = Runnable(run)
        main.postDelayed(step, ms)
        ({ main.removeCallbacks(step) })
    }
    private val clock: () -> Long = { SystemClock.elapsedRealtime() }
    private val followers = Followers(afterMain, clock).also { f ->
        for (route in routes) f.follow(route.topics, route.everyMs, route.gapMs) { _, done ->
            scope.launch {
                try {
                    read(route.path)
                } finally {
                    done()
                }
            }
        }
    }

    /** The stream to the node this phone is paired with (null: none yet). */
    private fun linkFor(c: NodeClient): LiveLink = LiveLink(
        open = liveOpen(scope, Dispatchers.IO, post = { run -> main.post { run() } }) { opened, alive, event ->
            c.stream("/api/live", opened, alive, event)
        },
        // (No stream on an older node, a device that may not read it, a revoked one: tried again only when told.)
        refused = { it is NodeError && it.status in listOf(401, 403, 404) },
        after = afterMain,
        now = clock,
    ).also { link ->
        link.attach(object : LinkHandlers {
            override fun up(topics: List<String>, at: Long) {
                _online.value = true
                // (The node's beat, as its hello said: the chat's watch is held to it too.)
                chat.beat = link.beat
                followers.up(at)
            }

            override fun changed(topics: List<String>) = followers.changed(topics)

            override fun down() {
                _online.value = false
                followers.down()
            }

            override fun lost() {
                _online.value = false
                // (Every stream of this node went the same way: the chat being watched is found again too.)
                chat.linkLost()
            }
        })
    }

    /**
     * While the app is on screen (the activity's STARTED state): the node's live stream open, and what it says changed
     * read again; the network watched, so a link back is used at once. Off screen, nothing.
     */
    suspend fun live() {
        _paired.collectLatest { node ->
            if (node == null) return@collectLatest
            // (Paired a moment ago, its client may be made after its pairing was told: made here then.)
            val c = client ?: run {
                connect()
                client
            } ?: return@collectLatest
            val link = linkFor(c)
            val network = appContext.getSystemService(ConnectivityManager::class.java)
            // The network under the app: a change can leave the stream open dead without a word (Wi-Fi to cellular, lost,
            // back), so a fresh one is opened at once, never left to time out. (Told on the main thread, as the link is.)
            val seen = NetworkWatch<Network>()
            val watch = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) {
                    if (seen.available(n)) moved(link) else link.retry()
                }

                override fun onLost(n: Network) {
                    if (seen.lost(n)) moved(link)
                }
            }
            runCatching { network?.registerDefaultNetworkCallback(watch, main) }
            linkNow = link
            link.start()
            try {
                awaitCancellation()
            } finally {
                link.stop()
                if (linkNow === link) linkNow = null
                followers.off()
                runCatching { network?.unregisterNetworkCallback(watch) }
                _online.value = null
            }
        }
    }

    private fun moved(link: LiveLink) {
        link.renew()
        chat.linkLost()
    }

    /** The stream open now (null: the app off screen, or not paired). */
    private var linkNow: LiveLink? = null

    /** A fresh stream opened now, whatever stands: refused, waiting to try again, or hanging on a dead link (the banner's Retry). */
    fun reconnect() {
        main.post { linkNow?.renew() }
    }

    /** One route read again, and what it changes drawn. */
    private suspend fun read(path: String) {
        val c = client ?: return
        val got = attempt { c.get(path) }
        got.onSuccess { answers[path] = it }
        if (path == TEAM) _problem.value = got.exceptionOrNull() as? NodeError
        rebuild()
        if (path == "/api/turns") chat.follow(_table.value.chats)
        lookAround(c)
    }

    /** Everything the screens show, read at once (after an answer of yours), the asks in parallel. */
    suspend fun refresh() {
        val c = client ?: return
        coroutineScope {
            val got = routes.filter { it.path != "/api/fleet" }.map { route -> route.path to async { attempt { c.get(route.path) } } }.map { (path, asked) -> path to asked.await() }
            for ((path, result) in got) result.onSuccess { answers[path] = it }
            val team = got.first { it.first == TEAM }.second
            _problem.value = if (team.isSuccess) null else got.firstNotNullOfOrNull { it.second.exceptionOrNull() as? NodeError }
        }
        rebuild()
        chat.follow(_table.value.chats)
        lookAround(c)
    }

    /** The Inbox and the table, from what each route last answered. */
    private fun rebuild() {
        val inbox = Inbox(
            actions = answers["/api/actions"]?.let { j -> j["actions"].list.filter { it["state"].string == "waiting" } } ?: _inbox.value.actions,
            questions = answers["/api/questions"]?.let { it["questions"].list } ?: _inbox.value.questions,
            keys = answers["/api/secret-requests"]?.let { it["requests"].list } ?: _inbox.value.keys,
            pairings = answers["/api/pairings"]?.let { it["pairings"].list } ?: _inbox.value.pairings,
            facts = answers["/api/about-you"]?.let { it["proposed"].list } ?: _inbox.value.facts,
            notices = answers["/api/notices"]?.let { Inbox.open(it["notices"].list) } ?: _inbox.value.notices,
            screens = answers["/api/screen/sessions"]?.let { Inbox.live(it["sessions"].list) } ?: _inbox.value.screens,
        )
        if (inbox != _inbox.value) _inbox.value = inbox
        answers["/api/usage/meter"]?.let(UsageMeter::of)?.let { if (it != _usage.value) _usage.value = it }
        answers["/api/fleet"]?.let(FleetLook::of)?.let { if (it != _fleet.value) _fleet.value = it }
        val turnsJson = answers["/api/turns"]
        val asks = inbox.actions.map { Ask(it["by"].string ?: "", it["connector"].string, it["tool"].string) }
        val teamJson = answers[TEAM]
        val table = _table.value.after(teamJson?.let(Snapshot::of), turnsJson, asks, inbox.count, System.currentTimeMillis(), teamJson?.let(TeamTask::all))
        if (table != _table.value) _table.value = table
        // (What the node said of the team just now is kept for the next time the app opens: KeptTable.)
        teamJson?.let { team -> keep(team, turnsJson, asks, inbox.count) }
    }

    /** What the work's names, a task's cost and the machine chip read, asked beside the rest and far less often. */
    private suspend fun lookAround(c: NodeClient) {
        if (!projectsAsked) {
            projectsAsked = true
            attempt { c.get("/api/projects") }.onSuccess { j ->
                _projects.value = j["projects"].list.mapNotNull { p -> p["name"].string?.let { ProjectName(it, p["repo"].string) } }
            }.onFailure { projectsAsked = false }
        }
        if (_prices.value == null) attempt { c.get("/api/prices") }.onSuccess { _prices.value = Spend.pricesOf(it) }
        // What the primary is called, where the node names it (core's Primary): once a session (the fleet's chip follows
        // the stream's `fleet`).
        if (!primaryAsked) {
            primaryAsked = true
            attempt { c.get("/api/whoami") }.onSuccess { Primary.named(it["primaryName"].string) }.onFailure { primaryAsked = false }
        }
    }

    /** That you've looked at an agent's results (opening a task that ended): no longer new to you, on any device. */
    suspend fun seen(agent: String) {
        client?.post("/api/team/seen", Json.obj("agent" to agent))
        refresh()
    }

    /** The approvals still waiting for your answer, as the work reads them (who asked, for which tool). */
    fun asks(now: Long = System.currentTimeMillis()): List<Ask> =
        _inbox.value.actions.filter { (it["expires"].long ?: Long.MAX_VALUE) > now }.map { Ask(it["by"].string ?: "", it["connector"].string, it["tool"].string) }

    private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: NodeError) {
        Result.failure(e)
    }

    /** Your answer to an approval: the first decision stands, and no answer before it expires means no. */
    suspend fun decide(action: String, approve: Boolean, note: String? = null) {
        client?.post("/api/actions/decide", Json.obj("id" to action, "approve" to approve, "note" to note?.ifBlank { null }))
        refresh()
    }

    /** A key sealed in the vault for what asked for it: the value goes to the node once, and is never shown again. */
    suspend fun sealKey(name: String, value: String, provider: String?) {
        client?.post("/api/secrets", Json.obj("name" to name, "value" to value, "provider" to provider))
        refresh()
    }

    suspend fun dismissKey(name: String) {
        client?.post("/api/secret-requests/dismiss", Json.obj("name" to name))
        refresh()
    }

    suspend fun answerQuestion(id: String, accept: Boolean, content: Map<String, Any?> = emptyMap()) {
        client?.post("/api/questions/answer", Json.obj("id" to id, "accept" to accept, "content" to if (accept) Json.of(content.filterValues { it != null }) else null))
        refresh()
    }

    /** Another device asking to join: yours to let in, once its code matches the one it shows. */
    suspend fun answerPairing(invite: String, device: String, approve: Boolean) {
        client?.post(if (approve) "/api/pairings/approve" else "/api/pairings/reject", Json.obj("invite" to invite, "device" to device))
        refresh()
    }

    /** Keeps a fact it proposed, in your words if you give them: it goes with every answer it gives from then on. */
    suspend fun keepFact(id: String, text: String? = null) {
        client?.post("/api/about-you/keep", Json.obj("id" to id, "text" to text?.trim()?.ifBlank { null }))
        refresh()
    }

    /** Drops a fact it proposed: it was only its note, and it goes with no answer. */
    suspend fun dropFact(id: String) {
        client?.post("/api/memories/forget", Json.obj("id" to id))
        refresh()
    }

    /** Your answer to its ask to use a Mac itself: its for its minutes from now, or not. */
    suspend fun decideScreen(id: String, allow: Boolean) {
        client?.post("/api/screen/decide", Json.obj("id" to id, "allow" to allow))
        refresh()
    }

    /** Ends its session on a Mac now: nothing of it is its after this. */
    suspend fun endScreen(id: String) {
        client?.post("/api/screen/end", Json.obj("id" to id))
        refresh()
    }

    /** Dismisses a notice: it stays quiet until it changes. */
    suspend fun dismissNotice(key: String) {
        client?.post("/api/notices/dismiss", Json.obj("key" to key))
        refresh()
    }

    /** What happened since you last looked (no model: the node's own record), and that you've now seen it. */
    suspend fun away(): List<Json> {
        val c = client ?: return emptyList()
        val since = prefs.getLong("away-since", System.currentTimeMillis() - 24 * 3_600_000L)
        val lines = runCatching { c.post("/api/away", Json.obj("since" to since))["lines"].list }.getOrNull() ?: return emptyList()
        return lines
    }

    fun sawAway() = prefs.edit().putLong("away-since", System.currentTimeMillis()).apply()

    /** How many the Inbox holds, as its tab's badge counts them. */
    val inboxCount: Int get() = _inbox.value.count

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    companion object {
        @Volatile private var instance: AppModel? = null

        fun of(context: Context): AppModel = instance ?: synchronized(this) { instance ?: AppModel(context.applicationContext).also { instance = it } }

        /** A number of anything, as a badge says it. */
        fun badge(n: Int): String = if (n > 99) "99+" else n.toString()

        /** The agents' route: what the app reads first, and whose failure is the one said. */
        private const val TEAM = "/api/team"

    }
}
