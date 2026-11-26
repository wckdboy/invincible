import Foundation
import Observation

/**
 * Your conversation with one agent, as the agent's page shows it: its own room on the node (made the first time you
 * open it), what was said there, and the work it was given. You say something and it replies when its turn comes; you
 * give it a task and it works in its own workspace until its gates and an independent review say whether it is done.
 */
@MainActor @Observable final class AgentRoom {
    /// The agent whose own conversation this is; empty for a room of several.
    let agent: String
    /// A room of several, by its id: it is never made here, only read.
    private let fixed: String?
    /// The room as the node last answered.
    private(set) var view: TeamRoomView?
    /// Why the room couldn't be read or a word not sent.
    private(set) var problem: String?
    private(set) var sending = false
    var draft = ""
    /// Files waiting to go with your next message.
    let outbox = Outbox()
    /// There is something to send (words, or a file that is up), no file is still going up, and nothing is on its way.
    var sendable: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !outbox.carried.isEmpty) && !outbox.going && !sending && view != nil }

    init(agent: String) {
        self.agent = agent
        fixed = nil
    }

    /// A room of several agents, as the agents lists it.
    init(room: String) {
        agent = ""
        fixed = room
    }

    /// Its replies on their way: the agent is writing (in its own conversation, the agent's alone: the primary's answer, when
    /// you named it there, isn't the agent's).
    var writing: Bool {
        guard let deliveries = view?.deliveries else { return false }
        return deliveries.contains { delivery in (delivery.status == "queued" || delivery.status == "running") && (agent.isEmpty || delivery.agent == agent) }
    }

    /// A message quoted at the start of your next one, with who said it.
    func quote(_ text: String, by speaker: String) {
        draft = Quote.of(text, by: speaker) + draft
    }

    /// The room on the node: the one the agents knows, or the agent's own, made now if it has none yet.
    func load(room known: String?, with client: NodeClient) async {
        do {
            var id = known ?? view?.id ?? fixed
            if id == nil, !agent.isEmpty {
                struct Direct: Encodable { let id: String }
                struct Made: Decodable { struct Room: Decodable { let id: String }; let room: Room }
                id = try await client.post("/api/team/direct", Direct(id: agent), as: Made.self).room.id
            }
            struct Get: Encodable { let id: String }
            view = try await client.post("/api/team/room", Get(id: id ?? ""), as: TeamRoomView.self)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    /// What's in the box, said in the room with the files that are up; the agent replies when its turn comes.
    func send(with client: NodeClient) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = outbox.carried
        guard let room = view?.id, sendable else { return }
        sending = true
        defer { sending = false }
        struct Post: Encodable { let room: String; let text: String; let attachments: [AttachmentRef]? }
        do {
            _ = try await client.post("/api/team/messages", Post(room: room, text: text, attachments: files.isEmpty ? nil : files), as: JSONValue.self)
            draft = ""
            outbox.sent()
            await load(room: room, with: client)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// A task for this agent (in a room of several, for `assignee`): what it should do, and the commands that prove it done.
    func give(title: String, goal: String, gates: [String], dependsOn: [String] = [], assignee: String? = nil, budgetUsd: Double? = nil, with client: NodeClient) async throws {
        guard let room = view?.id else { throw NodeError(status: 0, message: "The conversation isn't open yet.") }
        struct Task: Encodable { let room: String; let assignee: String; let title: String; let goal: String; let dependsOn: [String]; let gates: [String]; let budgetUsd: Double? }
        _ = try await client.post("/api/team/tasks", Task(room: room, assignee: assignee ?? agent, title: title, goal: goal, dependsOn: dependsOn, gates: gates, budgetUsd: budgetUsd), as: JSONValue.self)
        await load(room: room, with: client)
    }

    /// Stop work in hand, or resume work that ended unverified.
    func control(_ task: TeamTask, _ action: String, with client: NodeClient) async {
        struct Control: Encodable { let task: String; let action: String }
        do {
            _ = try await client.post("/api/team/control", Control(task: task.id, action: action), as: JSONValue.self)
            await load(room: view?.id, with: client)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// The same task, given again as a new one: what was asked, of whom and where, and which it gives again (your
    /// stepping in, counted on the new one), with what came of it last time (TaskCard.againGoal).
    func giveAgain(_ task: TeamTask, from step: Int? = nil, with client: NodeClient) async {
        do {
            // (One in sensitive mode is again, on the same models. `from`: a step of it, its workspace as it stood then.)
            struct From: Encodable { let task: String; let step: Int }
            struct Again: Encodable { let room: String; let assignee: String; let title: String; let goal: String; let dependsOn: [String]; let gates: [String]; let models: [String]?; let from: From?; let again: String }
            _ = try await client.post("/api/team/tasks", Again(room: task.room, assignee: task.assignee, title: task.title.trimmingCharacters(in: .whitespaces), goal: TaskCard.againGoal(task), dependsOn: task.dependsOn, gates: task.gates ?? [], models: task.models?.isEmpty == false ? task.models : nil, from: step.map { From(task: task.id, step: $0) }, again: task.id), as: JSONValue.self)
            await load(room: view?.id, with: client)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Its verified work as a pull request, on your word, under the title you gave it: where it went (nil: it wasn't).
    func ship(_ task: TeamTask, title: String, with client: NodeClient) async -> String? {
        struct Ship: Encodable { let task: String; let title: String }
        struct Shipped: Decodable { let url: String?; let pr: Int? }
        do {
            let shipped = try await client.post("/api/team/ship", Ship(task: task.id, title: title.trimmingCharacters(in: .whitespacesAndNewlines)), as: Shipped.self)
            await load(room: view?.id, with: client)
            return shipped.url
        } catch {
            problem = error.localizedDescription
            return nil
        }
    }

    /// The commands that prove it done, one a line: at most 16, each at most 1,000 characters (lib/give.ts).
    nonisolated static func gates(from text: String) -> Result<[String], NodeError> {
        let gates = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if gates.count > 16 { return .failure(NodeError(status: 0, message: "At most 16 commands: this has \(gates.count).")) }
        if let long = gates.firstIndex(where: { $0.utf16.count > 1000 }) { return .failure(NodeError(status: 0, message: "A command can be at most 1,000 characters: line \(long + 1) is longer.")) }
        return .success(gates)
    }

    /// A task's budget as typed: US dollars above 0 and at most 100 ("0.50", "$2", "1,5"), or nil when nothing is typed
    /// (the PWA's `budgetFrom`).
    nonisolated static func budget(from text: String) -> Result<Double?, NodeError> {
        var typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.hasPrefix("$") { typed = String(typed.dropFirst()).trimmingCharacters(in: .whitespaces) }
        if let comma = typed.firstIndex(of: ",") { typed.replaceSubrange(comma...comma, with: ".") }
        if typed.isEmpty { return .success(nil) }
        let parts = typed.split(separator: ".", omittingEmptySubsequences: false)
        let digits = parts.count <= 2 && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }
        guard digits, let usd = Double(typed) else { return .failure(NodeError(status: 0, message: "A budget is an amount in US dollars, like 0.50.")) }
        guard usd > 0, usd <= 100 else { return .failure(NodeError(status: 0, message: "A budget is more than $0 and at most $100.")) }
        return .success(usd)
    }
}
