import Foundation

/// A message kept in a chat on the node (core's `StoredMessage`), as far as the chat shows it.
struct StoredMessage: Decodable, Sendable, Equatable {
    /// One step of an answer, as the chat streamed it and the node kept it.
    enum Step: Decodable, Sendable, Equatable {
        case model(ref: String)
        case fallback(from: String, error: String)
        case tool(id: String, name: String, title: String, input: String, ok: Bool?, summary: String?)
        case archive([ChatEvent.ArchiveEntry])
        /// A kind this app doesn't know yet: passed over.
        case other

        private enum Keys: String, CodingKey { case kind, ref, from, error, id, name, title, input, ok, summary, entries }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "model": self = .model(ref: try c.decode(String.self, forKey: .ref))
            case "fallback": self = .fallback(from: try c.decode(String.self, forKey: .from), error: try c.decodeIfPresent(String.self, forKey: .error) ?? "")
            case "tool":
                self = .tool(
                    id: try c.decode(String.self, forKey: .id),
                    name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                    title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
                    input: try c.decodeIfPresent(String.self, forKey: .input) ?? "",
                    ok: try c.decodeIfPresent(Bool.self, forKey: .ok),
                    summary: try c.decodeIfPresent(String.self, forKey: .summary)
                )
            case "archive": self = .archive(try c.decodeIfPresent([ChatEvent.ArchiveEntry].self, forKey: .entries) ?? [])
            default: self = .other
            }
        }
    }

    let id: Int
    /// user · assistant
    let role: String
    let content: String
    /// Your files with it (a message of yours), as the node keeps them.
    let attachments: [AttachmentRef]?
    /// A look of its come back (core's `look`): a "user" message that isn't yours, with when it set it and its note.
    let look: Look?
    let model: String?
    let steps: [Step]

    struct Look: Decodable, Sendable, Equatable {
        /// When it set it (ms since 1970).
        let set: Double
        let note: String
    }
    /// done · error · stopped · steered · streaming
    let status: String
    let error: String?
    /// When it was said (ms; an older node says nothing).
    var createdAt: Double? = nil
}

/**
 * A chat on screen, as turns: the messages the node kept, and a turn's stream applied event by event, from its start or,
 * after attaching to a turn already under way, rebuilt from what the node replays. The PWA's `lib/turns.ts` and
 * `lib/chats.ts`, step for step; the tests hold it to their output (scripts/vectors.ts).
 */
struct ChatThread: Equatable, Sendable {
    struct Step: Equatable, Sendable {
        enum State: String, Sendable { case active, done, warn, error }
        var text: String
        var detail: String?
        var state: State
        /// A tool call's id (tool steps only).
        var tool: String?
    }

    struct Turn: Identifiable, Equatable, Sendable {
        enum Role: String, Sendable { case user, assistant }
        /// `steered`: you sent a message while it was answering; the turn went on in the next answer.
        enum Status: String, Sendable { case streaming, done, error, stopped, steered }
        let id: Int
        /// The kept message this is, once the node has said.
        var sid: Int?
        let role: Role
        var content: String
        /// The roster role that answered (its answers).
        var answeredAs: String?
        var model: String?
        var steps: [Step]
        var status: Status
        var error: String?
        /// Your files with it (your messages).
        var attachments: [AttachmentRef]? = nil
        /// A look of its come back: shown as its own note, never as yours.
        var look: StoredMessage.Look? = nil
        /// When it was said (ms): a kept message's, or the moment you sent yours here (nil: not known, or an answer, which
        /// is said under the message it answers).
        var at: Double? = nil
    }

    private(set) var turns: [Turn] = []
    private var nextId = 1
    /// The answer the stream is writing now, by its id.
    private(set) var target: Int?
    /// Where the running turn's own answers begin in `turns` (what a replay rebuilds from); nil: not known here.
    private var base: Int?

    init() {}

    /// A kept chat, as it stands: each of its answers with the steps it took.
    init(kept messages: [StoredMessage], role: String) {
        for message in messages {
            turns.append(Self.turn(of: message, role: role, id: nextId))
            nextId += 1
        }
    }

    var isEmpty: Bool { turns.isEmpty }

    /// Turns kept from what was on screen (a send the node never took), after the kept chat: as they were, with ids of this thread.
    mutating func keep(_ kept: [Turn]) {
        for turn in kept {
            turns.append(Turn(id: take(), sid: turn.sid, role: turn.role, content: turn.content, answeredAs: turn.answeredAs, model: turn.model, steps: turn.steps, status: turn.status, error: turn.error, attachments: turn.attachments, look: turn.look, at: turn.at))
        }
    }

    /// Asked again: the turns from `index` on leave the thread (the question there and everything after it), for the
    /// new exchange to take their place (the PWA's `retry`).
    mutating func cut(at index: Int) {
        guard index >= 0, index < turns.count else { return }
        turns.removeSubrange(index...)
        base = nil
    }

    /// You send a message: it, and the answer to come (what the stream then writes), join the thread.
    mutating func begin(question: String, role: String, attachments: [AttachmentRef] = []) {
        turns.append(Turn(id: take(), role: .user, content: question, steps: [], status: .done, attachments: attachments.isEmpty ? nil : attachments, at: Date.now.timeIntervalSince1970 * 1000))
        base = turns.count
        let answer = blank(answeredAs: role, model: nil)
        step(answer, Step(text: "Asked as \(role)", state: .done))
    }

    /// One event of a turn's stream. Returns whether anything on screen changed.
    @discardableResult mutating func apply(_ event: ChatEvent) -> Bool {
        if case .turn(_, _, let answer, let role, let replay) = event {
            guard replay else {
                // This device started it: the answer is already there, and now it knows which kept message it is.
                if let target, let answer, let at = index(of: target) { turns[at].sid = answer }
                return false
            }
            // Attached to a turn already under way: its answers (and your steers between them) are rebuilt from what the
            // node replays, from the kept message its first answer is (or the first after it, if that one wasn't kept).
            let known = base ?? answer.flatMap { answer in turns.firstIndex { ($0.sid ?? Int.min) >= answer } }
            if let known, known >= 0, known <= turns.count { turns.removeSubrange(known...) }
            base = turns.count
            let id = blank(answeredAs: role, model: nil)
            if let answer, let at = index(of: id) { turns[at].sid = answer }
            step(id, Step(text: "Asked as \(role)", state: .done))
            return true
        }
        guard let target, let at = index(of: target) else { return false }
        switch event {
        case .model(let ref):
            turns[at].model = ref
            step(target, Step(text: "Thinking with \(ref)", state: .active))
        case .fallback(let from, let error):
            if let last = turns[at].steps.indices.last, turns[at].steps[last].state == .active {
                turns[at].steps[last] = Step(text: "\(from) didn't answer", detail: error, state: .warn, tool: turns[at].steps[last].tool)
            } else {
                step(target, Step(text: "\(from) didn't answer", detail: error, state: .warn))
            }
        case .archive(let entries):
            let (text, detail) = Self.archiveStep(entries)
            step(target, Step(text: text, detail: detail, state: .done))
        case .tool(let id, _, let title, let input):
            step(target, Step(text: title, detail: input.isEmpty ? nil : input, state: .active, tool: id))
        case .toolResult(let id, let ok, let summary):
            guard let s = turns[at].steps.firstIndex(where: { $0.tool == id }) else { return true }
            turns[at].steps[s].state = ok ? .done : .warn
            turns[at].steps[s].detail = [turns[at].steps[s].detail, summary].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " → ")
        case .text(let text):
            let last = turns[at].steps.last
            if !(last?.text == "Answering" && last?.state == .active) { step(target, Step(text: "Answering", state: .active)) }
            turns[at].content += text
        case .steer(let text):
            // Your message reached it: the answer so far stands as it is, your message follows, a new answer begins.
            let answer = turns[at]
            if answer.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !answer.steps.contains(where: { $0.tool != nil }) {
                turns.remove(at: at)
            } else {
                turns[at].status = .steered
                step(target, Step(text: "Your message reached it here", state: .done))
            }
            turns.append(Turn(id: take(), role: .user, content: text, steps: [], status: .done, at: Date.now.timeIntervalSince1970 * 1000))
            let next = blank(answeredAs: answer.answeredAs ?? "planner", model: answer.model)
            step(next, Step(text: answer.model.flatMap { $0.isEmpty ? nil : "Thinking with \($0)" } ?? "Thinking", state: .active))
        case .done(let ref):
            turns[at].model = ref
        case .error(let message):
            turns[at].error = message
        case .stopped(let reason):
            turns[at].status = .stopped
            step(target, Step(text: Self.stopped[reason] ?? "Stopped", state: .warn))
        case .turn, .conversation, .undelivered, .aside, .other:
            return false
        }
        return true
    }

    /// The stream has ended: the answer it was writing is settled (done, or failed with why).
    mutating func end() {
        defer { (target, base) = (nil, nil) }
        guard let target, let at = index(of: target), turns[at].status == .streaming else { return }
        if let error = turns[at].error, !error.isEmpty {
            turns[at].status = .error
            step(target, Step(text: "Couldn't answer", detail: error, state: .error))
        } else {
            turns[at].status = .done
            if let last = turns[at].steps.indices.last, turns[at].steps[last].state == .active { turns[at].steps[last].state = .done }
        }
    }

    /// The watching was cut (not the turn): the answer says so.
    mutating func fail(_ message: String) {
        defer { (target, base) = (nil, nil) }
        guard let target, let at = index(of: target) else { return }
        turns[at].status = .error
        turns[at].error = message
        step(target, Step(text: "Couldn't answer", detail: message, state: .error))
    }

    // MARK: - The kept chat's own steps (lib/chats.ts)

    static func turn(of message: StoredMessage, role: String, id: Int) -> Turn {
        let assistant = message.role == "assistant"
        return Turn(
            id: id,
            sid: message.id,
            role: assistant ? .assistant : .user,
            content: message.content,
            answeredAs: role,
            model: message.model,
            steps: assistant ? steps(of: message, role: role) : [],
            status: Turn.Status(rawValue: message.status) ?? .done,
            error: message.error.flatMap { $0.isEmpty ? nil : $0 },
            attachments: message.attachments.flatMap { $0.isEmpty ? nil : $0 },
            look: message.look,
            at: message.createdAt
        )
    }

    /// A kept answer's steps, as the chat shows them while one streams.
    static func steps(of answer: StoredMessage, role: String) -> [Step] {
        var steps = [Step(text: "Asked as \(role)", state: .done)]
        for step in answer.steps {
            switch step {
            case .model(let ref): steps.append(Step(text: "Thinking with \(ref)", state: .done))
            case .fallback(let from, let error): steps.append(Step(text: "\(from) didn't answer", detail: error, state: .warn))
            case .archive(let entries):
                let (text, detail) = archiveStep(entries)
                steps.append(Step(text: text, detail: detail, state: .done))
            case .tool(let id, _, let title, let input, let ok, let summary):
                steps.append(Step(text: title, detail: joined([input, summary]), state: ok == false ? .warn : .done, tool: id))
            case .other: break
            }
        }
        if !answer.content.isEmpty { steps.append(Step(text: "Answering", state: .done)) }
        switch answer.status {
        case "error": steps.append(Step(text: "Couldn't answer", detail: answer.error.flatMap { $0.isEmpty ? nil : $0 }, state: .error))
        case "stopped": steps.append(Step(text: "Stopped", state: .warn))
        // You sent a message while it was answering: this answer stands as far as it got, and the turn went on after it.
        case "steered": steps.append(Step(text: "Your message reached it here", state: .done))
        default: break
        }
        return steps
    }

    /// The archived entries an answer was given, as one step: how many, and each by its id and title.
    static func archiveStep(_ entries: [ChatEvent.ArchiveEntry]) -> (text: String, detail: String?) {
        // Its skills go with an answer as their own step: notes it had at hand, not archived entries it read.
        let skills = !entries.isEmpty && entries.allSatisfy { $0.kind == "skill" }
        let n = entries.count
        let text = skills ? "Had \(n) skill\(n == 1 ? "" : "s") at hand" : "Read \(n) archived \(n == 1 ? "entry" : "entries")"
        guard !entries.isEmpty else { return (text, nil) }
        return (text, entries.map { "[\($0.id)] \($0.title)\($0.trust == "untrusted" ? " (untrusted)" : "")" }.joined(separator: " · "))
    }

    static let stopped = [
        "you": "Stopped by you",
        "limit": "Stopped at the node's limit for one turn",
        "node": "Stopped: the node itself was stopping",
        "unwatched": "Stopped: nobody was watching this temporary chat any more",
    ]

    // MARK: - Bookkeeping

    private static func joined(_ parts: [String?]) -> String? {
        let kept = parts.compactMap { $0 }.filter { !$0.isEmpty }
        return kept.isEmpty ? nil : kept.joined(separator: " → ")
    }

    private func index(of id: Int) -> Int? { turns.firstIndex { $0.id == id } }

    private mutating func take() -> Int {
        defer { nextId += 1 }
        return nextId
    }

    /// A new, empty answer, which the stream then writes.
    private mutating func blank(answeredAs: String, model: String?) -> Int {
        let id = take()
        turns.append(Turn(id: id, role: .assistant, content: "", answeredAs: answeredAs, model: model, steps: [], status: .streaming))
        target = id
        return id
    }

    /// A new step; the one before it, if still under way, is over.
    private mutating func step(_ turn: Int, _ next: Step) {
        guard let at = index(of: turn) else { return }
        if let last = turns[at].steps.indices.last, turns[at].steps[last].state == .active { turns[at].steps[last].state = .done }
        turns[at].steps.append(next)
    }
}

/// A tool's step as a work log shows it (T3 Code's activity log): the command it ran, when it ran one, and what came back.
/// A step's detail is the tool's input as JSON, then " → " and what it answered (the PWA's lib/turns.ts).
enum WorkLog {
    static func parts(_ detail: String?) -> (command: String?, answer: String?) {
        guard let detail, !detail.isEmpty else { return (nil, nil) }
        let split = detail.range(of: "} → ")
        let input = split.map { String(detail[..<$0.lowerBound]) + "}" } ?? detail
        let answer = split.map { String(detail[$0.upperBound...]) }
        let fields = (try? JSONSerialization.jsonObject(with: Data(input.utf8))) as? [String: Any]
        let command = (fields?["command"] as? String).map { $0.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? $0 }
        return (command?.isEmpty == false ? command : nil, answer?.isEmpty == false ? answer : nil)
    }
}
