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
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.Glass
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
import sh.invincible.bot.core.NodePin
import sh.invincible.bot.core.NodeSession
import sh.invincible.bot.core.NodeProof
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Reach
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.HomeRow
import sh.invincible.bot.core.RosterRow
import sh.invincible.bot.core.Price
import sh.invincible.bot.core.ProjectName
import sh.invincible.bot.core.Snapshot
import sh.invincible.bot.core.Spend
import sh.invincible.bot.core.TeamTask
import sh.invincible.bot.core.UsageMeter
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.double
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import sh.invincible.bot.core.text
import sh.invincible.bot.core.Primary

/**
 * The node this phone is paired with (kept as the Apple app keeps its PairedNode, outside any backup). [nodeId]: the
 * node's id, as that node proved it (NodeProof), which every request names; absent from a pairing made before it, or with
 * a node from before it: proved, and kept, at the next whoami.
 */
data class PairedNode(val origin: String, val device: String, val name: String, val fleet: String, val nodeName: String?, val fleetName: String?, val nodeId: String? = null) {
    fun json(): Json = Json.obj("origin" to origin, "device" to device, "name" to name, "fleet" to fleet, "nodeName" to nodeName, "fleetName" to fleetName, "nodeId" to nodeId)

    companion object {
        fun of(j: Json): PairedNode? {
            return PairedNode(
                j["origin"].string ?: return null, j["device"].string ?: return null, j["name"].string ?: return null,
                j["fleet"].string ?: return null, j["nodeName"].string, j["fleetName"].string, j["nodeId"].string,
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
    /** Loops it drafted when you asked for one in a chat: each runs nothing until you add it. */
    val drafts: List<Json> = emptyList(),
    /** Connectors it or an agent asked for: to add, or (one that's its alone) to let the asker use. */
    val connectors: List<Json> = emptyList(),
) {
    val count: Int get() = actions.size + questions.size + keys.size + pairings.size + facts.size + notices.size + screens.size + drafts.size + connectors.size

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
            return mapOf("heartbeat" to "The heartbeat", "ci" to "CI", "compute" to "Its compute", "routing" to "Routing")[source] ?: source
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
    /** Every agent and room for the list that is home, the latest first (Roster.homeRows): from the same answer. */
    val home: List<HomeRow> = emptyList(),
    /** What waits on you that is no agent's (Roster.primaryNeeds): your agent's row in the list counts it. */
    val primaryNeeds: Int = 0,
    /** The chats your agent is answering in, by their titles (null: a temporary chat), as the node said them last. */
    val turns: List<String?> = emptyList(),
    /** For each agent waiting on you, how much did when its glass last knocked (Glass.nudgeNow), and how many knocks were
     * armed for it this session: one more, and its glass knocks three times again (GlassMark). */
    val nudged: Map<String, Int> = emptyMap(),
    val knocks: Map<String, Int> = emptyMap(),
) {
    /** The knocks after [home]: one more armed for each agent something new waits on (Glass.nudgeNow, from [nudged]). */
    private fun knocking(home: List<HomeRow>): Pair<Map<String, Int>, Map<String, Int>> {
        val nudged = HashMap<String, Int>()
        val knocks = HashMap(this.knocks)
        for (row in home) if (row.row.kind == "agent") {
            val (knock, after) = Glass.nudgeNow(this.nudged[row.row.id], Glass.state(AgentMark.state(row.row.state)), row.count)
            after?.let { nudged[row.row.id] = it }
            if (knock) knocks[row.row.id] = (knocks[row.row.id] ?: 0) + 1
        }
        return nudged to knocks
    }

    /**
     * The agents after a look at the node: `team` its answer for the team (null: it couldn't be read), `turns` its
     * answer for the chats, `asks` the approvals waiting and `inbox` what waits for you that is no task's (the Inbox's
     * count), at `now`. Until the node has answered for the team, a kept team stays as it was kept, never redrawn with
     * what else came back (an empty Inbox while the node is away), so it is never taken for the node's word; otherwise
     * its last team is drawn again with what's new.
     */
    fun after(team: Snapshot?, turns: Json?, asks: List<Ask>, inbox: Int, now: Long, tasks: List<TeamTask>? = null): Table {
        if (team == null && asOf != null) return this
        val snapshot = team ?: this.snapshot
        val work = if (team != null) tasks ?: emptyList() else this.tasks
        val unread = turns?.let { it["unread"].list } ?: this.unread
        // (Your agent says, and its row counts, what of it is no agent's: an agent's ask for approval is its own row's.)
        val owed = Roster.primaryNeeds(inbox, asks, snapshot?.agents?.map { it.id } ?: emptyList())
        val inHand = (turns?.let { it["turns"].list } ?: emptyList()).map { it["title"].string }
        val primary = Roster.primaryNow(
            turns = inHand,
            runs = emptyList(),
            needs = owed,
            unread = unread.map { it["title"].string },
        )
        val home = snapshot?.let { Roster.homeRows(it, asks, now) } ?: emptyList()
        val (nudged, knocks) = knocking(home)
        return Table(
            snapshot, snapshot?.let { Roster.rows(it, asks, now) } ?: emptyList(), primary, unread, turns?.get("chats")?.text() ?: chats,
            tasks = work, home = home, primaryNeeds = owed, turns = inHand, nudged = nudged, knocks = knocks,
        )
    }

    companion object {
        /**
         * The team kept on this phone (KeptTable), as it was kept: drawn the moment the app opens, until the node answers.
         * What waited that is no agent's is counted as it was kept; one kept before that was says nothing of it.
         */
        fun restored(kept: KeptTable.Kept, snapshot: Snapshot, now: Long): Table {
            val owed = kept.inbox?.let { Roster.primaryNeeds(it, kept.asks, snapshot.agents.map { agent -> agent.id }) }
            val primary = Roster.primaryNow(turns = kept.turns, runs = emptyList(), needs = owed, unread = kept.unread.map { it["title"].string })
            val home = Roster.homeRows(snapshot, kept.asks, now)
            val (nudged, knocks) = Table().knocking(home)
            return Table(
                snapshot, Roster.rows(snapshot, kept.asks, now), primary, kept.unread, asOf = kept.at, tasks = TeamTask.all(kept.team),
                home = home, primaryNeeds = owed ?: 0, turns = kept.turns, nudged = nudged, knocks = knocks,
            )
        }
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
    /** Your prices have been asked for this session. */
    private var pricesAsked = false

    /** What needs you, the one count every place says (Work.needsCount): decisions only, each once. */
    private val _needsYou = MutableStateFlow(0)
    val needsYou: StateFlow<Int> = _needsYou.asStateFlow()

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

    /**
     * The connectors' own names, as an ask names its service ("Merge on GitHub"; Asks.labels, the PWA's connectorLabels):
     * read from the node's list once, when an ask first names one, and once more for an ask that names one not in it
     * (added since); kept for the session. The live stream tells nothing of the connectors, so nothing is read at rest.
     * Unknown, an ask says its connector's id with a capital.
     */
    private val _connectorLabels = MutableStateFlow<Map<String, String>>(emptyMap())
    val connectorLabels: StateFlow<Map<String, String>> = _connectorLabels.asStateFlow()
    private val labelsAsked = HashSet<String>()
    @Volatile private var labelsReading = false

    /** Its connector named, for an ask that names [id]: its own name read once, if it isn't known yet (connectorLabels). */
    fun knowConnector(id: String) {
        if (_connectorLabels.value.containsKey(id) || id in labelsAsked || labelsReading || !can("mind:read")) return
        val c = client ?: return
        labelsAsked += id
        labelsReading = true
        launch {
            try {
                _connectorLabels.value = sh.invincible.bot.core.Asks.labels(c.get("/api/connectors")["connectors"].list)
            } catch (_: NodeError) {
            } finally {
                labelsReading = false
            }
        }
    }

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
        PerfProbe.on = (appContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        connect()
        restore()
    }

    /** The kept team, if it is this node's and this key's: drawn until the node answers. */
    private fun restore() {
        val node = _paired.value ?: return
        val kept = runCatching { KeptTable.read(Json.parse(keptFile.readText()), node) }.getOrNull() ?: return
        val snapshot = runCatching { Snapshot.of(kept.team) }.getOrNull() ?: return
        // (What needs you is one count everywhere: as it was kept, until the node has answered.)
        _needsYou.value = kept.waiting
        _table.value = Table.restored(kept, snapshot, System.currentTimeMillis())
    }

    /** What the node just said of the agents, kept for the next time the app opens (off the main thread). */
    private fun keep(team: Json, turns: Json?, asks: List<Ask>, waiting: Int, inbox: Int) {
        val node = _paired.value ?: return
        scope.launch(keeper) {
            val now = System.currentTimeMillis()
            val words = KeptTable.of(node, team, turns, asks, waiting, at = 0, inbox = inbox).text()
            if (words == keptWords && now - keptAt < 10 * 60_000L) return@launch
            runCatching {
                val next = java.io.File(keptFile.parentFile, "agents.json.next")
                next.writeText(KeptTable.of(node, team, turns, asks, waiting, at = now, inbox = inbox).text())
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
        // (Every request it signs names the node it proved to be, where it proved one: the slice 8 note's item 11.)
        // (Nothing but whoami is sent until its proof holds: NodeSession opens the pin's gate.)
        client = if (node != null) (key ?: runCatching { DeviceKey.load() }.getOrNull())?.let { NodeClient(node.origin, it, NodePin(node.nodeId, proofFirst = true)) } else null
        session = client?.let { sessionFor(it, node!!) }
    }

    /** This session's proof of which node it speaks to (NodeSession), with the client it was made for. */
    @Volatile private var session: NodeSession? = null

    private val _scopes = MutableStateFlow<List<String>?>(null)
    /** What this phone may do on its node (its scopes), as whoami says them once its proof holds; null: not said yet. */
    val scopes: StateFlow<List<String>?> = _scopes.asStateFlow()

    /** Whether this phone may [scope], as far as the node has said: until it has said, the node is left to refuse. */
    fun can(scope: String): Boolean = _scopes.value?.contains(scope) ?: true

    /** A session for [c], made for the pairing [made]: what its proof pins is kept with that pairing, and no other. */
    private fun sessionFor(c: NodeClient, made: PairedNode): NodeSession {
        val same = { node: PairedNode? -> node != null && node.origin == made.origin && node.device == made.device }
        return NodeSession(
            c.pin,
            ask = { challenge -> c.provenWhoami(challenge) },
            // (On the main thread, where paired() and forget() write, so its check and its write are one step: N1.)
            keep = { id ->
                scope.launch {
                    _paired.value?.takeIf(same)?.let { node ->
                        val pinned = node.copy(nodeId = id)
                        prefs.edit().putString("paired-node", pinned.json().text()).apply()
                        _paired.value = pinned
                    }
                }
            },
            named = { Primary.named(it) },
            refused = { _problem.value = it },
            // (The node refused this phone's whoami: removed there, or its clock out. Said, though all stays held.)
            trouble = { _problem.value = it },
            // (What this phone may do there, for this pairing only.)
            scoped = { scopes -> if (same(_paired.value)) _scopes.value = scopes },
            // (Its stream, refused or waiting, opened again once Try again's proof holds.)
            reopen = { reconnect() },
            isCurrent = { same(_paired.value) && client === c },
        )
    }

    /** Whoami, proven (NodeSession). False: nothing but whoami may be sent to the node at this address yet. */
    private suspend fun proven(c: NodeClient): Boolean = session?.takeIf { it.pin === c.pin }?.prove() ?: false

    /** The client, once its node has proved itself this session: what a notification's answer or its collector sends goes only then. */
    suspend fun provenClient(): NodeClient? = client?.takeIf { proven(it) }

    /** Try again, at a node refused: its proof asked for past the refusal, which stands until a proof holds (NodeSession). */
    fun tryAgain() {
        scope.launch {
            if (session?.tryAgain() == true) refresh()
        }
    }

    fun paired(node: PairedNode) {
        unkeep()
        _scopes.value = null
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
        _needsYou.value = 0
        _scopes.value = null
        // (What each route last answered is the forgotten node's: none of it is drawn for the next.)
        answers.clear()
        session = null
        pricesAsked = false
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
        val view = session?.read(c, "/api/notify") ?: return
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
        Route("/api/loops/drafts", listOf("loopDrafts"), 5_000),
        Route("/api/connectors/requests", listOf("connectorRequests"), 5_000),
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
                // (A read that got no answer is owed: read again with its next, and when the stream is up again.)
                var ok = false
                try {
                    ok = read(route.path)
                } finally {
                    done(ok)
                }
            }
        }
    }

    /**
     * A screen's own read, run as the live stream says one of its topics moved, as the web's pages follow theirs
     * (ctx.live.follow): no closer together than [gapMs]; while the stream is down, at once and then every [everyMs] (null:
     * once, the screen keeping its own time then); never while the app is off screen. Not at once: the screen reads as it
     * opens. [run] reads and says whether it got an answer. Returns how to stop. (On the main thread, as the stream is.)
     */
    fun follow(topics: List<String>, everyMs: Long?, gapMs: Long, run: (done: (Boolean) -> Unit) -> Unit): () -> Unit =
        followers.follow(topics, everyMs, gapMs, readNow = true) { _, done -> run(done) }

    /** The stream to the node this phone is paired with (null: none yet). */
    private fun linkFor(c: NodeClient): LiveLink = LiveLink(
        // (Opened again from where the last left off: its hello then says what changed since, and only that is read.)
        open = liveOpen(scope, Dispatchers.IO, post = { run -> main.post { run() } }) { since, opened, alive, event ->
            // (Proven first, and again each time it opens: a node that changed at the address since is found. Refused,
            // it stays closed until Try again's proof holds; not proven yet, it is tried again later.)
            val s = session?.takeIf { it.pin === c.pin }
            if (s == null || !s.prove(fresh = true)) throw c.pin.refused ?: NodeError.unproven()
            c.stream(Live.path(since), opened, alive, event)
        },
        // (No stream on an older node, a device that may not read it, a revoked one: tried again only when told.)
        refused = { it is NodeError && (it.status in listOf(401, 403, 404) || it.notYourNode != null) },
        after = afterMain,
        now = clock,
    ).also { link ->
        link.attach(object : LinkHandlers {
            override fun up(topics: List<String>, at: Long, changed: List<String>?) {
                _online.value = true
                // (The node's beat, as its hello said: the chat's watch is held to it too.)
                chat.beat = link.beat
                followers.up(at, changed)
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
        session?.newNetwork()
        link.renew()
        chat.linkLost()
    }

    /** The stream open now (null: the app off screen, or not paired). */
    private var linkNow: LiveLink? = null

    /** A fresh stream opened now, whatever stands: refused, waiting to try again, or hanging on a dead link (the banner's Retry). */
    fun reconnect() {
        main.post { linkNow?.renew() }
    }

    /** One route read again, and what it changes drawn. False: it got no answer. */
    private suspend fun read(path: String): Boolean {
        val c = client ?: return false
        if (!proven(c)) return false
        val got = attempt { c.get(path) }
        got.onSuccess { answers[path] = it }
        // (A 401 is judged: this build outdated, if its whoami still holds, else this phone removed: NodeSession.refusal.)
        if (path == TEAM) _problem.value = (got.exceptionOrNull() as? NodeError)?.let { e -> session?.takeIf { it.pin === c.pin }?.refusal(e) ?: e }
        rebuild()
        if (path == "/api/turns") chat.follow(_table.value.chats)
        // (Once a batch, with the agents' read: never after each route's, which asked a node that wouldn't give its prices
        // again after every read.)
        if (path == TEAM) lookAround(c)
        return got.isSuccess
    }

    /** Everything the screens show, read at once (after an answer of yours), the asks in parallel. */
    suspend fun refresh() {
        val c = client ?: return
        if (!proven(c)) return
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
            drafts = answers["/api/loops/drafts"]?.let { it["drafts"].list } ?: _inbox.value.drafts,
            connectors = answers["/api/connectors/requests"]?.let { it["requests"].list } ?: _inbox.value.connectors,
        )
        if (inbox != _inbox.value) _inbox.value = inbox
        answers["/api/usage/meter"]?.let(UsageMeter::of)?.let { if (it != _usage.value) _usage.value = it }
        answers["/api/fleet"]?.let(FleetLook::of)?.let { if (it != _fleet.value) _fleet.value = it }
        val turnsJson = answers["/api/turns"]
        val asks = inbox.actions.map { Ask(it["by"].string ?: "", it["connector"].string, it["tool"].string) }
        val teamJson = answers[TEAM]
        val now = System.currentTimeMillis()
        val team = teamJson?.let(Snapshot::of)
        val tasks = teamJson?.let(TeamTask::all)
        // What needs you, one count for every place: the work's own rows that only you can move on, and what waits beside.
        val drawn = team ?: _table.value.snapshot
        val work = drawn?.let { Work.attended(it.agents, tasks ?: _table.value.tasks, it.seen, _projects.value, asks, now) }
        val needs = Work.needsCount(inbox.actions.size, work?.needs ?: emptyList(), inbox.pairings.size, inbox.keys.size, inbox.questions.map { it["expires"].long }, inbox.screens.size, inbox.drafts.size, inbox.connectors.size, now)
        if (needs != _needsYou.value) {
            _needsYou.value = needs
            PerfProbe.mark("needs $needs")
        }
        // (What waits that is no task's, the Inbox's count as the PWA's live.ts counts it: of it, what is no agent's is your
        // agent's to say and its row's to count.)
        val inboxCount = Work.needsCount(inbox.actions.size, emptyList(), inbox.pairings.size, inbox.keys.size, inbox.questions.map { it["expires"].long }, inbox.screens.size, inbox.drafts.size, inbox.connectors.size, now)
        val table = _table.value.after(team, turnsJson, asks, inboxCount, now, tasks)
        if (table != _table.value) _table.value = table
        // (What the node said of the team just now is kept for the next time the app opens: KeptTable.)
        teamJson?.let { kept -> keep(kept, turnsJson, asks, needs, inboxCount) }
    }

    /** What the work's names, a task's cost and the machine chip read, asked beside the rest and far less often. */
    private suspend fun lookAround(c: NodeClient) {
        if (!projectsAsked) {
            projectsAsked = true
            attempt { c.get("/api/projects") }.onSuccess { j ->
                _projects.value = j["projects"].list.mapNotNull { p -> p["name"].string?.let { ProjectName(it, p["repo"].string) } }
            }.onFailure { projectsAsked = false }
        }
        // Your prices: once a session (a node that won't give them isn't asked again until the app pairs afresh).
        if (!pricesAsked) {
            pricesAsked = true
            attempt { c.get("/api/prices") }.onSuccess { _prices.value = Spend.pricesOf(it) }
        }
        // (What the primary is called is read with whoami's proof, once a session: proven.)
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
    /** Adds a loop it drafted, as it was drafted (POST /api/loops, naming the draft): it runs from now. A loop a webhook
     * wakes comes back with its secret, said this once (null: none). */
    suspend fun addLoop(draft: Json): String? {
        val wakes = draft["wakes"].list
        val cooldown = draft["cooldownMs"].double?.takeIf { it != 0.0 }
        val added = client?.post(
            "/api/loops",
            Json.obj(
                "name" to draft["name"], "schedule" to draft["schedule"], "tz" to draft["tz"], "task" to draft["task"],
                "wakes" to wakes.takeIf { it.isNotEmpty() }?.let { Json.Arr(it) }, "cooldownMs" to cooldown, "on" to draft["on"].string,
                "label" to draft["label"].string, "draft" to draft["id"],
            ),
        )
        refresh()
        return added?.get("hookSecret")?.string
    }

    /** Dismisses a loop it drafted: nothing is added. */
    suspend fun dismissDraft(id: String) {
        client?.post("/api/loops/drafts/dismiss", Json.obj("id" to id))
        refresh()
    }

    /** Lets the asker use a connector that's its alone, until you stop it (POST /api/connectors/access). */
    suspend fun allowConnector(request: Json) {
        client?.post("/api/connectors/access", Json.obj("id" to request["connector"], "agent" to request["agent"], "allow" to true))
        refresh()
    }

    /** Dismisses a connector asked for: nothing is installed or allowed. */
    suspend fun dismissConnectorRequest(id: String) {
        client?.post("/api/connectors/requests/dismiss", Json.obj("id" to id))
        refresh()
    }

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
