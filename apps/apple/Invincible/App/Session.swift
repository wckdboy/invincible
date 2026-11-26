import Foundation
import Observation

/// A paired device's view of its node: who it is there, the agents, what waits for you, and the primary's chat. It asks
/// the node again on every refresh; each part keeps what it last had when an ask fails. Until the node first answers,
/// the agents are the one this device last saw, where it keeps one (KeptTable).
@MainActor @Observable final class Session {
    let key: DeviceKey
    let node: PairedNode
    let client: NodeClient
    let chat = ChatModel()

    private(set) var whoami: WhoAmI?
    private(set) var team: TeamSnapshot?
    /// Why the agents couldn't be read, when it couldn't.
    private(set) var teamProblem: String?
    private(set) var actions: [ActionView] = []
    private(set) var requests: [SecretRequestView] = []
    private(set) var pairings: [PairingView] = []
    /// The facts about you it proposed, waiting for you (what you kept goes with every answer it gives).
    private(set) var facts: [Fact] = []
    /// What the node noticed for you that you haven't dismissed: a heartbeat's finding, a rule of yours that told you.
    private(set) var notices: [NoticeView] = []
    /// Its asks to use a Mac itself, and its sessions there while they last.
    private(set) var screenSessions: [ScreenSessionView] = []
    /// An approval its notification's Approve asked to see (its id): the Inbox opens its card, the yes behind Face ID.
    var approvalToOpen: String?
    /// A task its notification's Ship it asked to ship (its id): its thread asks Face ID, then for the pull request.
    var shipToOpen: String?
    /// MCP servers' questions to you, mid-call: each holds its call until you answer, say no, or its time runs out.
    private(set) var questions: [QuestionView] = []
    private(set) var turns: [TurnView] = []
    /// Its chats with an answer you haven't read yet, on any device (its ring is green while there are some).
    private(set) var unreadChats: [UnreadChat] = []
    private(set) var runs: [RunView] = []
    /// This period's model calls on the node at your prices, against your budget (nil: not read yet, or a node from
    /// before the meter).
    private(set) var usage: UsageMeter?
    /// The Inbox has been read at least once, so its count means something.
    private(set) var inboxLoaded = false
    /// The node is away, or won't accept this device: said once, above everything.
    private(set) var trouble: NodeError?
    /// The last team this device saw (KeptTable), drawn until the node first answers, and only ever looked at:
    /// whatever you change starts from the node's word (`team`).
    private(set) var kept: KeptTable.Kept?
    /// The node has been a moment answering while the kept team is drawn.
    private var slow = false
    /// Where what the node says of the agents is kept for the next time the app opens; nil: nowhere (a Mac, or a
    /// device forgetting its node).
    @ObservationIgnored private var keeping: KeptTable.Store?

    init(key: DeviceKey, node: PairedNode, kept: KeptTable.Kept? = nil, keeping: KeptTable.Store? = nil) {
        self.key = key
        self.node = node
        self.client = NodeClient(origin: node.origin, signer: key)
        self.kept = kept
        self.keeping = keeping
        // The chat on screen read: its answers in it stop being new here at once, not at the next look.
        chat.read = { [weak self] id in self?.noteRead(id) }
        if kept != nil {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                self?.slow = true
            }
        }
    }

    /// When the kept team is from, once the node has been a moment answering: said beside it, so it is never taken
    /// for what the node says now. On a quick answer it never shows, so nothing comes and goes.
    var keptSince: Date? {
        guard team == nil, slow, let kept else { return nil }
        return Date(timeIntervalSince1970: kept.at / 1000)
    }

    /// This device is forgetting its node: nothing more of the agents is kept.
    func stopKeeping() { keeping = nil }

    /// A chat of its read on this device (in any window): it is no longer counted new here.
    func noteRead(_ id: String) { unreadChats.removeAll { $0.id == id } }

    /// What this device may do (its scopes), as the node says; until it has said, the node is left to refuse.
    func can(_ scope: String) -> Bool { whoami?.scopes.contains(scope) ?? true }

    var waiting: [ActionView] { actions.filter { $0.waiting() } }
    var inboxCount: Int { waiting.count + requests.count + pairings.count + facts.count + notices.count + screenSessions.count + questions.count }
    var asks: [Ask] { waiting.map { Ask(by: $0.by, connector: $0.connector, tool: $0.tool) } }
    var rows: [RosterRow] {
        if let team { return Roster.rows(snapshot: team, asks: asks) }
        return kept.map { Roster.rows(snapshot: $0.team, asks: $0.asks) } ?? []
    }

    /// The agents as it is drawn: the node's word, or until it has answered, the kept one.
    private var drawnTeam: TeamSnapshot? { team ?? kept?.team }

    /// An agent as the agents draw it (its name, its face): the node's word, or the kept team's until the node
    /// has answered. For drawing alone: an agent's page, and anything you change, take `agent`, the node's word.
    func drawn(_ id: String) -> Agent? { drawnTeam?.agents.first { $0.id == id } }

    /// The primary's own line: what it's answering here, the turns the node runs, the runs in hand, what waits on you.
    var primary: PrimaryNow {
        // Until the node has answered, as it was kept: the chats under way, what waited for you.
        // (What needs you is one count everywhere: Home's, as kept until the node has answered.)
        if team == nil, let kept {
            return PrimaryNow(PrimaryWork(answering: chat.answering, step: chat.step, turns: kept.turns, runs: [], needs: kept.waiting, unread: kept.unread))
        }
        return PrimaryNow(PrimaryWork(
            answering: chat.answering,
            step: chat.step,
            turns: turns.map(\.title),
            runs: runs.map(\.goal),
            needs: inboxLoaded ? needsYou : nil,
            unread: unreadChats.map(\.title)
        ))
    }

    /// Where it stands at a glance: the ring round its face, and its word.
    var primaryStanding: Standing { .of(primary, answering: chat.answering) }

    /// Who sits where, top to bottom: the primary, then the agents as the node lists them.
    var seats: [String] { Roster.seats(agents: drawnTeam?.agents.map(\.id) ?? []) }

    /// Your projects (GET /api/projects), for the names the work's projects go by: asked once, where this device may read.
    private(set) var projects: [ProjectView] = []
    private var projectsAsked = false
    /// Your prices as money goes (GET /api/prices, a coding plan's calls costing nothing more): asked once a task's cost
    /// is shown; nil until then, or where they can't be read.
    private(set) var prices: Spend.Prices?
    private var pricesAsked = false

    /// The work by attention (Work.attended): every task a row of three lines in its section, from the agents as it is
    /// drawn, your projects' names and the approvals waiting. Nil until the agents are known.
    var attended: Attended? {
        guard let snapshot = drawnTeam else { return nil }
        return Work.attended(agents: snapshot.agents, tasks: snapshot.tasks, seen: snapshot.seen, projects: projects.map(Work.Named.init), asks: team == nil ? kept?.asks ?? [] : asks, now: Date.now.timeIntervalSince1970 * 1000)
    }

    /// What needs you, decisions only, counted one way for every place that says how many (Home's line and its Needs you,
    /// the Inbox's count, the primary's line among the agents, the sidebar, a Mac's menu bar, the launch cache): every
    /// approval waiting once, each task only you can move on (an agent asking for your approval is that approval's),
    /// devices asking to join, keys it asked for, a service's question while it can be answered, and its asks to use a
    /// Mac. What it noticed (a notice, a fact about you) is news, not a decision: shown in the Inbox, counted nowhere.
    func needsCount(_ work: Attended?) -> Int {
        let now = Date.now.timeIntervalSince1970 * 1000
        let tasks = work?.needs.filter { $0.word != "Allow?" }.count ?? 0
        return waiting.count + tasks + pairings.count + requests.count + questions.filter { $0.expires > now }.count + screenSessions.count
    }

    /// What needs you, as every place counts it (needsCount, of the work as it is drawn).
    var needsYou: Int { needsCount(attended) }

    /// What needs you beyond the work's own rows that need you: approvals no row stands for, and everything else that waits.
    func needsBeyond(_ work: Attended) -> Int {
        let asking = Set(work.needs.filter { $0.word == "Allow?" }.map(\.agent.id))
        let shown = waiting.filter { asking.contains(Roster.agentOfCaller($0.by) ?? "") }.count
        return max(0, needsCount(work) - work.needs.filter { $0.word != "Allow?" }.count - shown)
    }

    /// A task, as the agents are drawn.
    func task(_ id: String) -> TeamTask? { drawnTeam?.tasks.first { $0.id == id } }

    /// Your projects, asked for once.
    func askProjects() async {
        guard !projectsAsked, can("mind:read") else { return }
        projectsAsked = true
        struct Listed: Decodable { let projects: [ProjectView] }
        if let listed = try? await client.get("/api/projects", as: Listed.self) { projects = listed.projects } else { projectsAsked = false }
    }

    /// Your prices, asked for once.
    func askPrices() async {
        guard !pricesAsked else { return }
        pricesAsked = true
        struct Listed: Decodable { let prices: [String: Price]; let plans: [String]? }
        if let listed = try? await client.get("/api/prices", as: Listed.self) { prices = Spend.money(listed.prices, plans: listed.plans ?? []) } else { prices = [:] }
    }

    /// A task opened: when it is the latest of its agent's results still new to you, it is read, on every device (Work's
    /// seenOnOpen; its agent's page marked as POST /api/team/seen keeps marks).
    func opened(task id: String) async {
        guard let snapshot = team, let agent = Work.seenOnOpen(id, tasks: snapshot.tasks, seen: snapshot.seen) else { return }
        await read(agent: agent)
    }

    func agent(_ id: String) -> Agent? { team?.agents.first { $0.id == id } }
    func room(_ id: String) -> TeamRoom? { team?.rooms.first { $0.id == id } }
    var roomRows: [RoomRow] { drawnTeam.map { Roster.roomRows(snapshot: $0) } ?? [] }

    /// A node, by name where this device knows it: its own node's, else the start of its id.
    func nodeName(of id: String) -> String {
        id == whoami?.node ? (whoami?.nodeName ?? node.nodeName ?? id) : String(id.dropFirst(2).prefix(8))
    }

    // MARK: Keeping up: the node's live stream, and what is read again as it says things changed

    /// The node's live stream (Node/LiveLink.swift): open while a window of the app is in front (`live(true)`).
    @ObservationIgnored private(set) lazy var link: LiveLink = {
        let client = self.client
        let link = LiveLink(
            // (Opened again from where the last left off: only what changed since is read.)
            open: { since, alive in client.live(since: since, alive: { Task { @MainActor in alive() } }) },
            // An older node without the stream (404), a device that may not read it (403), one revoked (401, which the
            // reads then say): read on a timer instead, and opened again only when asked.
            refused: { ($0 as? NodeError).map { [401, 403, 404].contains($0.status) } ?? false }
        )
        link.attach(.init(
            up: { [weak self] _, at, changed in
                guard let self else { return }
                // (Set only when they change: what shows them is drawn again only then.)
                if !self.linkUp { self.linkUp = true }
                if self.reconnecting { self.reconnecting = false }
                #if os(iOS)
                PerfProbe.shared.linkBack()
                #endif
                // The node's beat, as its hello said: the chat's watch is held to it too.
                self.chat.beat = self.link.beat
                self.followers.up(at: at, changed: changed)
            },
            changed: { [weak self] topics in self?.followers.changed(topics) },
            down: { [weak self] in
                guard let self else { return }
                if !self.reconnecting { Self.saidLost() }
                if self.linkUp { self.linkUp = false }
                if !self.reconnecting { self.reconnecting = true }
                self.followers.down()
            },
            lost: { [weak self] in
                if self?.reconnecting == false { Self.saidLost() }
                self?.reconnecting = true
                // Every stream of this node went the same way: the chat being watched is found again too.
                self?.chat.linkLost()
            }
        ))
        return link
    }()
    /// The link was just said to be lost (the performance suite reads when: PerfProbe).
    private static func saidLost() {
        #if os(iOS)
        PerfProbe.shared.linkLost()
        #endif
    }

    /// What this app reads, each for its topics (core's live.ts), as the stream says they changed.
    @ObservationIgnored let followers = Followers()
    /// The node tells this device what changes, as it changes.
    private(set) var linkUp = false
    /// The link went (silent, cut, or not back in time) and isn't back yet: said beside how things stand.
    private(set) var reconnecting = false
    /// While the stream is down, each of these is read this often instead (an older node, the node away).
    private static let fallbackMs: Double = 15_000
    @ObservationIgnored private var following = false
    /// The actions and the keys asked for have each been read: the Inbox's count means something once both have.
    @ObservationIgnored private var inboxParts: Set<String> = []

    /// The network under the app, watched while it is in front.
    @ObservationIgnored private let path = PathWatch()

    /// The link is kept open (a window in front; on a Mac, while the app runs).
    private(set) var liveOn = false

    /// Waits until the task it is in is cancelled (a view gone from the screen): what it follows is followed until then.
    static func held() async {
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
    }

    /// The link opened (a window of the app in front) or closed (none is); what the app reads runs as it says from then.
    func live(_ on: Bool) {
        follow()
        liveOn = on
        if on {
            link.start()
            link.retry()
            path.start { [weak self] in self?.networkChanged() }
        } else {
            path.stop()
            link.stop()
            followers.off()
            if linkUp { linkUp = false }
            if reconnecting { reconnecting = false }
        }
    }

    /// The network under the app changed (Wi-Fi to cellular, lost, back): the stream open may be dead without a word, so a
    /// fresh one is opened at once, and the chat being watched is found again.
    func networkChanged() {
        link.renew()
        chat.linkLost()
    }

    /// Everything this app reads, each by the topics that move it (once: they last as long as the session). A read that
    /// got no answer is owed (Followers): read again with its next, and when the stream is up again.
    private func follow() {
        guard !following else { return }
        following = true
        let every = Self.fallbackMs
        _ = followers.follow(["fleet"], every: every, first: .later) { [weak self] _ in let read = await self?.readMe(); try Self.answered(read) }
        // (The largest answer: no oftener than a second, however busy the agents are.)
        _ = followers.follow(["team"], every: every, gap: 1_000, first: .later) { [weak self] _ in let read = await self?.readTeam(); try Self.answered(read) }
        _ = followers.follow(Self.inboxTopics, every: every, first: .later) { [weak self] changed in let read = await self?.readInbox(changed); try Self.answered(read) }
        _ = followers.follow(["turns"], every: every, first: .later) { [weak self] _ in let read = await self?.readTurns(); try Self.answered(read) }
        _ = followers.follow(["runs"], every: every, first: .later) { [weak self] _ in let read = await self?.readRuns(); try Self.answered(read) }
        // The meter moves with model calls, which turns and tasks make: read now and then while they do.
        _ = followers.follow(["turns", "runs", "team"], every: 60_000, gap: 30_000, first: .later) { [weak self] _ in let read = await self?.readUsage(); try Self.answered(read) }
    }

    /// A read that got no answer (nothing answered, the node failed it): its follower owes it (Followers).
    private struct Unanswered: Error {}
    private static func answered(_ read: Bool?) throws {
        if read == false { throw Unanswered() }
    }

    /// Whether a failure is an answer all the same: one the node refused or doesn't have (a 4xx), which asking again
    /// would only have refused again (the web app's live.ts asks again on the same terms).
    private static func settled(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        guard let error = error as? NodeError else { return false }
        return (400..<500).contains(error.status)
    }

    /// What a view shows, read again as these topics change (at once and every `every` ms while the stream is down; nil:
    /// once). Returns how to stop.
    func follow(_ topics: [String], every: Double? = 15_000, gap: Double = 1_000, run: @escaping @MainActor () async -> Void) -> @MainActor () -> Void {
        followers.follow(topics, every: every, gap: gap, first: .owner) { _ in await run() }
    }

    /// After a change of yours: what it changed, read now if the stream isn't up to say so (it says so within a moment
    /// when it is), or whatever it says (`force`: something told of it before the stream could, a notification).
    func reread(_ topics: [String], force: Bool = false) async {
        guard force || !linkUp else { return }
        for topic in topics {
            switch topic {
            case "team": await readTeam()
            case "fleet": await readMe()
            case "turns": await readTurns()
            default: await readInbox([topic])
            }
        }
    }

    /// The Inbox's parts, each read by its own route.
    private static let inboxTopics = ["actions", "secretRequests", "pairings", "aboutYou", "notices", "screenSessions", "questions"]

    /// Everything, now (pulled to refresh, or Try again): each part read as the stream would have it read.
    func refresh() async {
        async let me = readMe()
        async let team = readTeam()
        async let inbox = readInbox(nil)
        async let turns = readTurns()
        async let runs = readRuns()
        async let usage = readUsage()
        _ = await (me, team, inbox, turns, runs, usage)
    }

    /// Whoami, read: whether it was answered (false: owed, Followers).
    @discardableResult private func readMe() async -> Bool {
        switch await attempt({ [client] in try await client.get("/api/whoami", as: WhoAmI.self) }) {
        case .success(let me):
            (whoami, trouble) = (me, nil)
            Primary.named(me.primaryName)
            return true
        case .failure(let error as NodeError):
            trouble = error
            return Self.settled(error)
        case .failure(let error): return Self.settled(error)
        }
    }

    @discardableResult private func readTeam() async -> Bool {
        switch await attempt({ [client] in try await client.read("/api/team", as: TeamSnapshot.self) }) {
        case .success(let team):
            #if os(iOS)
            PerfProbe.shared.mark("team read")
            #endif
            (self.team, teamProblem, kept) = (team.value, nil, nil)
            // What the node said of the agents, as it came: kept for the next time the app opens.
            keep(team.bytes)
            trouble = trouble?.unreachable == true ? nil : trouble
            return true
        case .failure(let error as NodeError) where [404, 424, 501].contains(error.status):
            teamProblem = "This node has no other agents yet."
            return true
        case .failure(let error as NodeError) where error.unreachable:
            trouble = error
            return false
        case .failure(let error):
            teamProblem = error.localizedDescription
            return Self.settled(error)
        }
    }

    /// The Inbox's parts these topics name (nil: every one): whether each was answered.
    @discardableResult private func readInbox(_ changed: [String]?) async -> Bool {
        let client = self.client
        // Each part read at once, side by side (each one's answer waits on the network, not on the others).
        let reading = Set(changed ?? Self.inboxTopics).map { part in Task { await self.readInboxPart(part, client) } }
        var answered = true
        for part in reading {
            let read = await part.value
            if !read { answered = false }
        }
        return answered
    }

    private func readInboxPart(_ part: String, _ client: NodeClient) async -> Bool {
        /// Read, and what it said put where the app shows it: whether it was answered.
        func read<T: Sendable>(_ work: @Sendable () async throws -> T, _ put: (T) -> Void) async -> Bool {
            switch await attempt(work) {
            case .success(let value):
                put(value)
                return true
            case .failure(let error): return Self.settled(error)
            }
        }
        switch part {
        case "actions":
            return await read({ try await client.get("/api/actions", as: Listed.self).actions ?? [] }) { list in
                actions = list
                inboxRead(part)
            }
        case "secretRequests":
            return await read({ try await client.get("/api/secret-requests", as: Listed.self).requests ?? [] }) { list in
                requests = list
                inboxRead(part)
            }
        case "pairings": return await read({ try await client.get("/api/pairings", as: Listed.self).pairings ?? [] }) { pairings = $0 }
        case "aboutYou": return await read({ try await client.get("/api/about-you", as: AboutYou.self) }) { facts = $0.proposed }
        case "notices": return await read({ try await client.get("/api/notices", as: Listed.self).notices ?? [] }) { notices = Notices.open($0) }
        case "screenSessions": return await read({ try await client.get("/api/screen/sessions", as: Listed.self).sessions ?? [] }) { list in screenSessions = list.filter { $0.state == "waiting" || $0.state == "allowed" } }
        case "questions": return await read({ try await client.get("/api/questions", as: Listed.self).questions ?? [] }) { questions = $0 }
        default: return true
        }
    }

    private func inboxRead(_ part: String) {
        inboxParts.insert(part)
        if inboxParts.isSuperset(of: ["actions", "secretRequests"]) { inboxLoaded = true }
        keep(nil)
    }

    @discardableResult private func readTurns() async -> Bool {
        let listed: Listed
        switch await attempt({ [client] in try await client.get("/api/turns", as: Listed.self) }) {
        case .success(let said): listed = said
        case .failure(let error): return Self.settled(error)
        }
        turns = listed.turns ?? []
        unreadChats = listed.unread ?? []
        keep(nil)
        // The chat on screen, as the node holds it, when anything kept changed on another device.
        await chat.noticed(chats: listed.chats, turns: turns, with: client)
        return true
    }

    @discardableResult private func readRuns() async -> Bool {
        switch await attempt({ [client] in try await client.get("/api/runs", as: Listed.self).runs ?? [] }) {
        case .success(let list):
            runs = list
            return true
        case .failure(let error): return Self.settled(error)
        }
    }

    @discardableResult private func readUsage() async -> Bool {
        switch await attempt({ [client] in try await client.get("/api/usage/meter", as: UsageMeter.self) }) {
        case .success(let meter):
            usage = meter
            return true
        case .failure(let error): return Self.settled(error)
        }
    }

    /// The agents as the node just said them, kept for the next launch with what waits and runs as they stand (nil: kept
    /// with the next answer about the agents, which is what a launch draws first).
    private func keep(_ said: Data?) {
        guard let said, let keeping else { return }
        keeping.keep(team: said, for: node, turns: turns.map(\.title), unread: unreadChats.map(\.title), asks: asks, waiting: inboxLoaded ? needsYou : 0)
    }

    /// Your budget for the node's model calls (a line to watch, never a stop): a day's or a month's, or none.
    func setBudget(usd: Double?, per: String) async throws {
        struct Budget: Encodable {
            let usd: Double?
            let per: String
            // (None goes as null, never left out: the node takes null for no budget.)
            func encode(to encoder: any Encoder) throws {
                var keyed = encoder.container(keyedBy: Keys.self)
                try keyed.encode(usd, forKey: .usd)
                try keyed.encode(per, forKey: .per)
            }
            enum Keys: String, CodingKey { case usd, per }
        }
        usage = try await client.post("/api/usage/budget", Budget(usd: usd, per: per), as: UsageMeter.self)
    }

    /// While you were away (PLAN #37): what happened since this device last showed you (from the node, no model asked), or
    /// nil when it couldn't be asked. Nothing happened, and the next time counts from now.
    func away() async -> AwayView? {
        struct Ask: Encodable { let since: Int }
        let now = Date().timeIntervalSince1970 * 1000
        let seen = UserDefaults.standard.double(forKey: Self.awaySeen)
        let since = seen > 0 && seen <= now ? seen : now - 24 * 3600 * 1000
        guard let found = try? await client.post("/api/away", Ask(since: Int(since)), as: AwayView.self) else { return nil }
        if found.lines.isEmpty { markAwaySeen() }
        return found
    }

    /// What happened while you were away is read: the next time counts from now.
    func markAwaySeen() { UserDefaults.standard.set(Date().timeIntervalSince1970 * 1000, forKey: Self.awaySeen) }
    private static let awaySeen = "invincible.awaySeen"

    /// Your answer to an approval: nothing leaves until you approve it. `edits`, with a yes: your own words in its texts
    /// (only those you changed); your version is what's sent, and the one asked is declined, saying which it became.
    func decide(_ action: ActionView, approve: Bool, edits: [String: String]? = nil) async throws {
        struct Decision: Encodable { let id: String; let approve: Bool; let edits: [String: String]? }
        _ = try await client.post("/api/actions/decide", Decision(id: action.id, approve: approve, edits: edits), as: JSONValue.self)
        await reread(["actions"])
    }

    /// Seals a key the primary asked for: the node keeps it in the vault, and it learns that it exists, never what it is.
    func seal(_ request: SecretRequestView, value: String) async throws {
        struct Secret: Encodable { let name: String; let value: String; let provider: String? }
        _ = try await client.post("/api/secrets", Secret(name: request.name, value: value, provider: request.provider), as: JSONValue.self)
        await reread(["secretRequests"])
    }

    /// Dismisses a key it asked for that no longer matters (or that you won't give): out of the Inbox until it asks again.
    func dismiss(_ request: SecretRequestView) async throws {
        struct Dismiss: Encodable { let name: String }
        _ = try await client.post("/api/secret-requests/dismiss", Dismiss(name: request.name), as: JSONValue.self)
        await reread(["secretRequests"])
    }

    /// Lets a device in (only when its code matches the one it shows), or turns it away.
    func answer(_ pairing: PairingView, approve: Bool) async throws {
        struct Answer: Encodable { let invite: String; let device: String }
        _ = try await client.post(approve ? "/api/pairings/approve" : "/api/pairings/reject", Answer(invite: pairing.invite, device: pairing.device), as: JSONValue.self)
        await reread(["pairings", "fleet"])
    }

    /// Keeps a fact it proposed, in your words if you give them: it goes with every answer it gives from then on.
    func keep(_ fact: Fact, text: String? = nil) async throws {
        struct Keep: Encodable { let id: String; let text: String? }
        _ = try await client.post("/api/about-you/keep", Keep(id: fact.id, text: text), as: JSONValue.self)
        await reread(["aboutYou"])
    }

    /// Drops a fact it proposed: it was only its note, and it goes with no answer.
    func drop(_ fact: Fact) async throws {
        struct Forget: Encodable { let id: String }
        _ = try await client.post("/api/memories/forget", Forget(id: fact.id), as: JSONValue.self)
        await reread(["aboutYou"])
    }

    /// Your answer to its ask to use a Mac itself: its for its minutes from now, or not.
    func decide(screen: ScreenSessionView, allow: Bool) async throws {
        struct Decision: Encodable { let id: String; let allow: Bool }
        _ = try await client.post("/api/screen/decide", Decision(id: screen.id, allow: allow), as: JSONValue.self)
        await reread(["screenSessions"])
    }

    /// Your answer to a service's question: what you filled in (sent to that service alone), or no. Its call goes on.
    func answer(question: QuestionView, accept: Bool, content: [String: QuestionAnswer] = [:]) async throws {
        struct Answer: Encodable { let id: String; let accept: Bool; let content: [String: QuestionAnswer]? }
        _ = try await client.post("/api/questions/answer", Answer(id: question.id, accept: accept, content: accept ? content : nil), as: JSONValue.self)
        await reread(["questions"])
    }

    /// Ends its session on a Mac now: nothing of it is its after this.
    func end(screen: ScreenSessionView) async throws {
        struct End: Encodable { let id: String }
        _ = try await client.post("/api/screen/end", End(id: screen.id), as: JSONValue.self)
        await reread(["screenSessions"])
    }

    /// Dismisses a notice: it stays quiet until it changes.
    func dismiss(_ notice: NoticeView) async throws {
        struct Dismiss: Encodable { let key: String }
        _ = try await client.post("/api/notices/dismiss", Dismiss(key: notice.key), as: JSONValue.self)
        await reread(["notices"])
    }

    // MARK: Seating and keeping agents and rooms (yours alone: the node takes these from an owner's device)

    /// An agent saved, new or changed; the agents are asked again after.
    @discardableResult
    func save(agent: AgentInput) async throws -> Agent {
        struct Saved: Decodable { let agent: Agent }
        let saved = try await client.post("/api/team/agents", agent, as: Saved.self).agent
        await reread(["team"])
        return saved
    }

    /// A room saved, new or changed.
    @discardableResult
    func save(room: RoomInput) async throws -> TeamRoom {
        struct Saved: Decodable { let room: TeamRoom }
        let saved = try await client.post("/api/team/rooms", room, as: Saved.self).room
        await reread(["team"])
        return saved
    }

    /// Approve a task proposed to you, or stop, resume a task (`approve` · `stop` · `resume`).
    func control(task: String, _ action: String) async throws {
        struct Control: Encodable { let task: String; let action: String }
        _ = try await client.post("/api/team/control", Control(task: task, action: action), as: JSONValue.self)
        await reread(["team"])
    }

    /// Your words to a running task (POST /api/team/steer, fleet:admin): its run takes them at its next safe point, and its
    /// reviewer judges the work against them. Until then they wait with the task, on their way (SteerWords.waiting).
    func steer(task: String, _ text: String) async throws {
        struct Steer: Encodable { let task: String; let text: String }
        _ = try await client.post("/api/team/steer", Steer(task: task, text: text), as: JSONValue.self)
        await reread(["team"])
    }

    /// Pause, resume or stop a room's work, or an agent's (one of the two).
    func control(room: String? = nil, agent: String? = nil, _ action: String) async throws {
        struct Control: Encodable { let room: String?; let agent: String?; let action: String }
        _ = try await client.post("/api/team/control", Control(room: room, agent: agent, action: action), as: JSONValue.self)
        await reread(["team"])
    }

    /// An agent taken off the agents for good; its VM goes with it only when `destroyWorkspace` says so.
    func remove(agent: String, destroyWorkspace: Bool) async throws {
        struct Remove: Encodable { let id: String; let destroyWorkspace: Bool? }
        _ = try await client.post("/api/team/remove", Remove(id: agent, destroyWorkspace: destroyWorkspace ? true : nil), as: JSONValue.self)
        await reread(["team"])
    }

    /// The model roles your Models page has, each with whether a model answers for it (nil: this device may not read them).
    /// The models an agent may be set to work on: the roster's, and each local one a node of the fleet serves, and where.
    /// Nil: a device that may not read them, or a node too old to say (its agents then keep their role's).
    func agentModels() async -> [Agents.ModelChoice]? {
        struct Choices: Decodable { let models: [Agents.ModelChoice] }
        guard can("mind:read"), let choices = try? await client.get("/api/team/models", as: Choices.self).models else { return nil }
        return choices
    }

    func roles() async -> [String: Agents.RoleInfo]? {
        struct Roster: Decodable { let roster: [String: Agents.RoleInfo] }
        guard can("mind:read"), let roster = try? await client.get("/api/roster", as: Roster.self).roster else { return nil }
        return roster
    }

    /// The lists the node answers with, each under its own name.
    private struct Listed: Decodable {
        var actions: [ActionView]?
        var requests: [SecretRequestView]?
        var pairings: [PairingView]?
        var notices: [NoticeView]?
        var sessions: [ScreenSessionView]?
        var questions: [QuestionView]?
        var turns: [TurnView]?
        /// Which writing of the chats this is (on `GET /api/turns`).
        var chats: String?
        /// Its chats with an answer you haven't read (on `GET /api/turns`; absent from an older node).
        var unread: [UnreadChat]?
        var runs: [RunView]?
    }

    /// An agent's page on screen: what ended there (its replies to you, its tasks) is no longer new, on any device.
    func read(agent id: String) async {
        struct Seen: Encodable { let agent: String }
        guard (try? await client.post("/api/team/seen", Seen(agent: id), as: JSONValue.self)) != nil else { return }
        await lookAtTeam()
    }

    /// A room on screen: what ended there is no longer new, on any device.
    func read(room id: String) async {
        struct Seen: Encodable { let room: String }
        guard (try? await client.post("/api/team/seen", Seen(room: id), as: JSONValue.self)) != nil else { return }
        await lookAtTeam()
    }

    /// The agents as the node has it now, after a change of yours (the stream says so at once when it is up).
    private func lookAtTeam() async {
        await reread(["team"])
    }
}

private func attempt<T: Sendable>(_ work: @Sendable () async throws -> T) async -> Result<T, any Error> {
    do {
        return .success(try await work())
    } catch {
        return .failure(error)
    }
}
