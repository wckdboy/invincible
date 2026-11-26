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
        if team == nil, let kept {
            let needs = Roster.primaryNeeds(inbox: kept.waiting, asks: kept.asks, agents: kept.team.agents.map(\.id))
            return PrimaryNow(PrimaryWork(answering: chat.answering, step: chat.step, turns: kept.turns, runs: [], needs: needs, unread: kept.unread))
        }
        let agents = team?.agents.map(\.id) ?? []
        return PrimaryNow(PrimaryWork(
            answering: chat.answering,
            step: chat.step,
            turns: turns.map(\.title),
            runs: runs.map(\.goal),
            needs: inboxLoaded ? Roster.primaryNeeds(inbox: inboxCount, asks: asks, agents: agents) : nil,
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

    /// How many things need you, as Home's "Needs you" counts its items: every waiting approval once, each task that only
    /// you can move on (an agent asking for your approval is its approval's), and everything else that waits in the Inbox.
    func needsCount(_ work: Attended?) -> Int {
        let now = Date.now.timeIntervalSince1970 * 1000
        let tasks = work?.needs.filter { $0.word != "Allow?" }.count ?? 0
        return waiting.count + tasks + pairings.count + requests.count + questions.filter { $0.expires > now }.count + screenSessions.count + notices.count + facts.count
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

    func refresh() async {
        let client = self.client
        async let me = attempt { try await client.get("/api/whoami", as: WhoAmI.self) }
        async let team = attempt { try await client.read("/api/team", as: TeamSnapshot.self) }
        async let actions = attempt { try await client.get("/api/actions", as: Listed.self).actions ?? [] }
        async let requests = attempt { try await client.get("/api/secret-requests", as: Listed.self).requests ?? [] }
        async let pairings = attempt { try await client.get("/api/pairings", as: Listed.self).pairings ?? [] }
        async let about = attempt { try await client.get("/api/about-you", as: AboutYou.self) }
        async let notices = attempt { try await client.get("/api/notices", as: Listed.self).notices ?? [] }
        async let screens = attempt { try await client.get("/api/screen/sessions", as: Listed.self).sessions ?? [] }
        async let questioned = attempt { try await client.get("/api/questions", as: Listed.self).questions ?? [] }
        async let turns = attempt { try await client.get("/api/turns", as: Listed.self) }
        async let runs = attempt { try await client.get("/api/runs", as: Listed.self).runs ?? [] }
        async let usage = attempt { try await client.get("/api/usage/meter", as: UsageMeter.self) }

        switch await me {
        case .success(let me):
            (whoami, trouble) = (me, nil)
            Primary.named(me.primaryName)
        case .failure(let error as NodeError): trouble = error
        case .failure: break
        }
        // What the node said of the agents, as it came: kept for the next time the app opens.
        var said: Data?
        switch await team {
        case .success(let team):
            (self.team, teamProblem, kept) = (team.value, nil, nil)
            said = team.bytes
        case .failure(let error as NodeError) where [404, 424, 501].contains(error.status): teamProblem = "This node has no other agents yet."
        case .failure(let error): teamProblem = error.localizedDescription
        }
        let (acted, asked) = await (actions, requests)
        if case .success(let list) = acted { self.actions = list }
        if case .success(let list) = asked { self.requests = list }
        if case .success = acted, case .success = asked { inboxLoaded = true }
        if case .success(let list) = await pairings { self.pairings = list }
        if case .success(let about) = await about { self.facts = about.proposed }
        if case .success(let list) = await notices { self.notices = Notices.open(list) }
        if case .success(let list) = await screens { self.screenSessions = list.filter { $0.state == "waiting" || $0.state == "allowed" } }
        if case .success(let list) = await questioned { self.questions = list }
        if case .success(let listed) = await turns {
            self.turns = listed.turns ?? []
            self.unreadChats = listed.unread ?? []
            // The chat on screen, as the node holds it, when anything kept changed on another device.
            await chat.noticed(chats: listed.chats, turns: self.turns, with: client)
        }
        if case .success(let list) = await runs { self.runs = list }
        if case .success(let meter) = await usage { self.usage = meter }
        if let said, let keeping {
            keeping.keep(team: said, for: node, turns: self.turns.map(\.title), unread: unreadChats.map(\.title), asks: asks, waiting: inboxLoaded ? inboxCount : 0)
        }
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
        await refresh()
    }

    /// Seals a key the primary asked for: the node keeps it in the vault, and it learns that it exists, never what it is.
    func seal(_ request: SecretRequestView, value: String) async throws {
        struct Secret: Encodable { let name: String; let value: String; let provider: String? }
        _ = try await client.post("/api/secrets", Secret(name: request.name, value: value, provider: request.provider), as: JSONValue.self)
        await refresh()
    }

    /// Dismisses a key it asked for that no longer matters (or that you won't give): out of the Inbox until it asks again.
    func dismiss(_ request: SecretRequestView) async throws {
        struct Dismiss: Encodable { let name: String }
        _ = try await client.post("/api/secret-requests/dismiss", Dismiss(name: request.name), as: JSONValue.self)
        await refresh()
    }

    /// Lets a device in (only when its code matches the one it shows), or turns it away.
    func answer(_ pairing: PairingView, approve: Bool) async throws {
        struct Answer: Encodable { let invite: String; let device: String }
        _ = try await client.post(approve ? "/api/pairings/approve" : "/api/pairings/reject", Answer(invite: pairing.invite, device: pairing.device), as: JSONValue.self)
        await refresh()
    }

    /// Keeps a fact it proposed, in your words if you give them: it goes with every answer it gives from then on.
    func keep(_ fact: Fact, text: String? = nil) async throws {
        struct Keep: Encodable { let id: String; let text: String? }
        _ = try await client.post("/api/about-you/keep", Keep(id: fact.id, text: text), as: JSONValue.self)
        await refresh()
    }

    /// Drops a fact it proposed: it was only its note, and it goes with no answer.
    func drop(_ fact: Fact) async throws {
        struct Forget: Encodable { let id: String }
        _ = try await client.post("/api/memories/forget", Forget(id: fact.id), as: JSONValue.self)
        await refresh()
    }

    /// Your answer to its ask to use a Mac itself: its for its minutes from now, or not.
    func decide(screen: ScreenSessionView, allow: Bool) async throws {
        struct Decision: Encodable { let id: String; let allow: Bool }
        _ = try await client.post("/api/screen/decide", Decision(id: screen.id, allow: allow), as: JSONValue.self)
        await refresh()
    }

    /// Your answer to a service's question: what you filled in (sent to that service alone), or no. Its call goes on.
    func answer(question: QuestionView, accept: Bool, content: [String: QuestionAnswer] = [:]) async throws {
        struct Answer: Encodable { let id: String; let accept: Bool; let content: [String: QuestionAnswer]? }
        _ = try await client.post("/api/questions/answer", Answer(id: question.id, accept: accept, content: accept ? content : nil), as: JSONValue.self)
        await refresh()
    }

    /// Ends its session on a Mac now: nothing of it is its after this.
    func end(screen: ScreenSessionView) async throws {
        struct End: Encodable { let id: String }
        _ = try await client.post("/api/screen/end", End(id: screen.id), as: JSONValue.self)
        await refresh()
    }

    /// Dismisses a notice: it stays quiet until it changes.
    func dismiss(_ notice: NoticeView) async throws {
        struct Dismiss: Encodable { let key: String }
        _ = try await client.post("/api/notices/dismiss", Dismiss(key: notice.key), as: JSONValue.self)
        await refresh()
    }

    // MARK: Seating and keeping agents and rooms (yours alone: the node takes these from an owner's device)

    /// An agent saved, new or changed; the agents are asked again after.
    @discardableResult
    func save(agent: AgentInput) async throws -> Agent {
        struct Saved: Decodable { let agent: Agent }
        let saved = try await client.post("/api/team/agents", agent, as: Saved.self).agent
        await refresh()
        return saved
    }

    /// A room saved, new or changed.
    @discardableResult
    func save(room: RoomInput) async throws -> TeamRoom {
        struct Saved: Decodable { let room: TeamRoom }
        let saved = try await client.post("/api/team/rooms", room, as: Saved.self).room
        await refresh()
        return saved
    }

    /// Approve a task proposed to you, or stop, resume a task (`approve` · `stop` · `resume`).
    func control(task: String, _ action: String) async throws {
        struct Control: Encodable { let task: String; let action: String }
        _ = try await client.post("/api/team/control", Control(task: task, action: action), as: JSONValue.self)
        await refresh()
    }

    /// Pause, resume or stop a room's work, or an agent's (one of the two).
    func control(room: String? = nil, agent: String? = nil, _ action: String) async throws {
        struct Control: Encodable { let room: String?; let agent: String?; let action: String }
        _ = try await client.post("/api/team/control", Control(room: room, agent: agent, action: action), as: JSONValue.self)
        await refresh()
    }

    /// An agent taken off the agents for good; its VM goes with it only when `destroyWorkspace` says so.
    func remove(agent: String, destroyWorkspace: Bool) async throws {
        struct Remove: Encodable { let id: String; let destroyWorkspace: Bool? }
        _ = try await client.post("/api/team/remove", Remove(id: agent, destroyWorkspace: destroyWorkspace ? true : nil), as: JSONValue.self)
        await refresh()
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

    /// The agents as the node has it now, alone (after a change of yours, so it shows at once).
    private func lookAtTeam() async {
        if let team = try? await client.get("/api/team", as: TeamSnapshot.self) { self.team = team }
    }
}

private func attempt<T: Sendable>(_ work: @Sendable () async throws -> T) async -> Result<T, any Error> {
    do {
        return .success(try await work())
    } catch {
        return .failure(error)
    }
}
