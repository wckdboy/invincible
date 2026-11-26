import Foundation
import Observation

/// What `POST /api/chat` takes, as far as this app asks: a role, and either a new kept chat or the one it continues.
struct ChatRequest: Encodable, Sendable {
    struct Message: Encodable, Sendable {
        let role: String
        let content: String
        /// Your files with it, kept on the node first (an absent field when there are none).
        var attachments: [AttachmentRef]?
    }
    let role: String
    /// A model of your choosing for this answer (the Build view's), instead of the role's first.
    var model: String?
    /// A new conversation's project (the Build view's thread): its instructions, and its checkout of it, go with every answer.
    var project: String?
    /// A new conversation, kept in your history from its first message.
    var save: Bool?
    /// The kept conversation this message continues: the node holds what was said, so only the message goes.
    var conversation: String?
    let messages: [Message]
    /// Its latest answer asked again: the node replaces the question before it, and the answer, with this exchange.
    var retry: Bool?
}

/**
 * Your conversation with the primary, as this app shows it. A chat is kept on the node: opening one shows what it holds,
 * and when it is still answering in it, the app attaches to its turn, which the node replays from its start and then
 * streams live. A message starts (or continues) a turn the node owns; its answer streams into its bubble as it comes,
 * with what it's at as its steps (`ChatThread`, the PWA's lib/turns.ts). Leaving a chat ends the watching, never the
 * turn; Stop asks the node to stop it.
 */
@MainActor @Observable final class ChatModel {
    /// The role its answers come from (the PWA's default), until a kept chat says its own.
    private(set) var role = "planner"
    private(set) var thread = ChatThread()
    /// The kept chat on screen (nil: a new one, until the node keeps it).
    private(set) var conversation: String?
    /// A new chat's project, when it is a Build thread: sent with its first message, after which the node keeps it.
    var project: String?
    /// A model of your choosing for what you send (nil: the role's own, first to last).
    var model: String?
    private(set) var title: String?
    /// The turn under way, by its id on the node.
    private(set) var turn: String?
    /// A chat is being read from the node.
    private(set) var loading = false
    /// Why the chat couldn't be read.
    private(set) var problem: String?
    var draft = ""
    /// Files waiting to go with your next message.
    let outbox = Outbox()
    /// How many messages this chat screen has sent: the message box is made anew with each one (see `Composer`).
    private(set) var sent = 0
    private var live: Task<Void, Never>?
    /// The watch whose events the chat on screen takes.
    private var watching: UUID?
    /// The primary's latest chat has been looked for since the app opened (its row opens it).
    private var opened = false
    /// Something it answered in the chat on screen hasn't been read yet, on any device.
    private var unread = false
    /// The chat's view is shown (ChatView says so as it comes and goes): only then is what's in it read.
    var onScreen = false
    /// Told the id of the chat on screen when it is read, so what showed its answers there as new stops at once.
    var read: ((String) -> Void)?

    var answering: Bool { live != nil }
    /// There is something to send (words, or a file that is up), and no file is still going up.
    var sendable: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !outbox.carried.isEmpty) && !outbox.going }

    /// What its answer is at: its last step (nil when it has only just started).
    var step: String? { thread.turns.last { $0.role == .assistant }?.steps.last?.text }

    /// Its row opens its latest chat, once; after that the chat on screen stays until you choose another.
    func openLatest(with client: NodeClient) async {
        guard !opened, conversation == nil, thread.isEmpty, live == nil else { return }
        opened = true
        struct Listed: Decodable { let conversations: [ConversationSummary] }
        guard let latest = try? await Chats.mostRecent(client.get("/api/conversations", as: Listed.self).conversations) else { return }
        await open(latest.id, with: client)
    }

    /// A kept chat, as the node holds it; if it is answering in it, its turn is watched from where it stands.
    func open(_ id: String, with client: NodeClient) async {
        leave()
        opened = true
        loading = true
        defer { loading = false }
        struct Get: Encodable { let id: String }
        struct Got: Decodable { let conversation: ConversationDetail }
        do {
            let detail = try await client.post("/api/conversations/get", Get(id: id), as: Got.self).conversation
            (conversation, title, role, problem, turn) = (detail.id, detail.title, detail.role, nil, nil)
            thread = ChatThread(kept: detail.messages, role: detail.role)
            unread = detail.unread == true
            markRead(with: client)
            // (A turn this device may not watch is refused if asked for: the chat shows as the node keeps it.)
            if let running = detail.turn, running.watchable != false { attach(running.id, with: client) }
        } catch {
            problem = error.localizedDescription
        }
    }

    func send(with client: NodeClient) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = outbox.carried
        guard live == nil, sendable else { return }
        draft = ""
        // Sent with the message: the box is clear of them (one not taken stays, to remove).
        outbox.sent()
        sent += 1
        thread.begin(question: text, role: role, attachments: files)
        let request = ChatRequest(role: role, model: model, project: conversation == nil ? project : nil, save: conversation == nil ? true : nil, conversation: conversation, messages: [.init(role: "user", content: text, attachments: files.isEmpty ? nil : files)])
        watch(client, "/api/chat", request)
    }

    /// Its latest answer may be asked again: it has ended, it isn't answering, and the chat is kept.
    var canAskAgain: Bool { live == nil && conversation != nil && thread.turns.last?.role == .assistant && thread.turns.last?.status != .streaming }

    /// Its latest answer, asked again: the question before it goes again, and the new answer takes the old one's place
    /// (the node replaces both in the kept chat).
    func askAgain(with client: NodeClient) {
        guard canAskAgain, let at = thread.turns.lastIndex(where: { $0.role == .user }) else { return }
        let question = thread.turns[at]
        thread.cut(at: at)
        sent += 1
        thread.begin(question: question.content, role: role, attachments: question.attachments ?? [])
        let request = ChatRequest(role: role, model: model, conversation: conversation, messages: [.init(role: "user", content: question.content, attachments: question.attachments)], retry: true)
        watch(client, "/api/chat", request)
    }

    /// A message of yours, back in the box to change and send again.
    func edit(_ text: String) {
        draft = text
    }

    /// A message quoted at the start of your next one.
    func quote(_ text: String) {
        draft = Quote.of(text) + draft
    }

    /// A choice it offered, tapped: sent as your reply, through the message box's own checks.
    func reply(_ text: String, with client: NodeClient) {
        guard live == nil else { return }
        draft = text
        send(with: client)
    }

    /// Asks the node to stop the turn under way; the stream then says it stopped, and ends.
    func stop(with client: NodeClient) {
        guard let turn else { live?.cancel(); return }
        Task {
            struct Stop: Encodable { let turn: String }
            _ = try? await client.post("/api/turns/stop", Stop(turn: turn), as: JSONValue.self)
        }
    }

    /// A new chat. The one before stays kept on the node.
    func startNew() {
        guard live == nil else { return }
        thread = ChatThread()
        (conversation, title, problem, role) = (nil, nil, nil, "planner")
        opened = true
    }

    /// The chat on screen was deleted: what's left is a new one.
    func forget(_ id: String) {
        guard conversation == id else { return }
        leave()
        startNew()
    }

    /// A turn already under way: the node replays it from its start, then streams the rest.
    private func attach(_ id: String, with client: NodeClient) {
        struct Attach: Encodable { let turn: String }
        turn = id
        watch(client, "/api/turns/attach", Attach(turn: id))
    }

    /// The node's beat (its live stream's hello says it; an older node's is 15 s): a watch silent for three is dead.
    var beat: Double = 15_000
    /// The watch's silence, counted from the last line it carried (the node's beats too).
    private var silence: Task<Void, Never>?
    /// The node the chat on screen is watched from, to find it again there.
    private var watchedFrom: NodeClient?

    private func watch(_ client: NodeClient, _ path: String, _ body: some Encodable) {
        // Each watch is its own: one that was left (another chat opened) says nothing more to the chat on screen.
        let watch = UUID()
        watching = watch
        watchedFrom = client
        let events = client.events(path, body, alive: { [weak self] in Task { @MainActor in self?.heard(watch) } })
        heard(watch)
        live = Task {
            do {
                for try await event in events {
                    guard watching == watch else { return }
                    switch event {
                    case .turn(let id, let kept, _, _, _):
                        turn = id
                        if let kept { conversation = kept }
                    case .conversation(let id, let named):
                        (conversation, title) = (id, named)
                    default: break
                    }
                    thread.apply(event)
                }
                guard watching == watch, !Task.isCancelled else { return }
                thread.end()
            } catch {
                // Leaving the chat ends the watching, never the turn: what it has said so far stays as it stands.
                guard watching == watch, !Task.isCancelled, !(error is CancellationError) else { return }
                // The watching was cut (the app was away, the network dropped), not the turn: coming back finds it again.
                thread.fail(error.localizedDescription)
            }
            guard watching == watch else { return }
            (live, turn, watching) = (nil, nil, nil)
            silence?.cancel()
            silence = nil
        }
    }

    /// Something came on the watch (a beat at least): it is alive for three more of the node's beats.
    private func heard(_ watch: UUID) {
        guard watching == watch else { return }
        silence?.cancel()
        let quiet = 3 * beat
        silence = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(quiet))
            guard !Task.isCancelled, let self, self.watching == watch else { return }
            // Dead without a word (a half-open connection): found again where the node holds it.
            self.linkLost()
        }
    }

    /// The link to the node went (silent, cut, or the network changed under it): the watch is dropped without a word in
    /// the thread, and the chat on screen is found again as the node holds it, its turn attached to again while it runs
    /// (the node owns the turn: nothing of it was lost). A new chat the node hasn't kept yet has nowhere to be found: its
    /// watch ends as a cut one does.
    func linkLost() {
        guard live != nil, let client = watchedFrom else { return }
        guard conversation != nil else { return }
        Task { await resume(with: client) }
    }

    /// Back in the app, after the watching was cut, or a dead watch dropped: the chat on screen as the node holds it now,
    /// whether or not a watch still seemed live (one half-open would otherwise hold it until it timed out).
    func resume(with client: NodeClient) async {
        guard let conversation, !loading else { return }
        leave()
        await open(conversation, with: client)
    }

    /// Which writing of the chats the node said last (`chats` on `GET /api/turns`; nil: none yet).
    private var seenChats: String?

    /// What the node said on its latest look (every few seconds while the app is open): when anything kept has changed
    /// (a chat begun, answered or renamed on another device), or it is answering in the chat on screen for another
    /// device, the chat on screen as the node holds it. Never while this device is sending or watching.
    func noticed(chats: String?, turns: [TurnView], with client: NodeClient) async {
        let changed = chats != nil && seenChats != nil && chats != seenChats
        if let chats { seenChats = chats }
        guard let conversation, live == nil, !loading else { return }
        guard changed || turns.contains(where: { $0.conversation == conversation }) else { return }
        struct Get: Encodable { let id: String }
        struct Got: Decodable { let conversation: ConversationDetail }
        guard let detail = try? await client.post("/api/conversations/get", Get(id: conversation), as: Got.self).conversation,
              self.conversation == conversation, live == nil, !loading else { return }
        title = detail.title
        unread = detail.unread == true
        markRead(with: client)
        // Shown again only where the node holds what isn't on screen (a send it never took stays, with why); its turn in it,
        // attached to when this device may watch it (one it may not is refused, so it isn't asked for again and again).
        if let again = Chats.shownAgain(shown: thread.turns, kept: detail.messages, role: detail.role) { thread = again }
        if let running = detail.turn, running.watchable != false { attach(running.id, with: client) }
    }

    private func leave() {
        live?.cancel()
        silence?.cancel()
        (live, watching, silence) = (nil, nil, nil)
    }

    /// The chat on screen, read where it is shown: what it answered in it so far is no longer new, on any device. (An
    /// answer that ends while this device watches it is read already: the node knows it was watched.)
    func markRead(with client: NodeClient) {
        guard onScreen, unread, let conversation else { return }
        unread = false
        read?(conversation)
        Task {
            struct Seen: Encodable { let id: String }
            _ = try? await client.post("/api/conversations/seen", Seen(id: conversation), as: JSONValue.self)
        }
    }
}
