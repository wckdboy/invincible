import SwiftUI

/// The primary's chat: your messages and its answers as bubbles, its streaming in as it comes, and the message box on the
/// keyboard. A new chat keeps the one before it on the node. On an iPhone it is where the app opens, the roster a drawer
/// from its back arrow (which counts what needs you) or from the screen's left edge.
struct ChatView: View {
    let session: Session
    /// The chat shown, when it isn't the session's (on a Mac, one of its chats in a window of its own).
    private let shown: ChatModel?
    /// Opens the roster, where it is a drawer (an iPhone's: the chat is where the app opens); nil where it is a sidebar.
    private let roster: (() -> Void)?
    /// Forgets this device (its key, its pairing), from the refusal of a node that proves to be another (nil: Settings has it).
    private let forget: (() throws -> Void)?
    @FocusState private var composing: Bool
    @State private var listing = false
    /// Its own computer, watched from here: its screen, or its terminal.
    @State private var watching = false
    @State private var inTerminal = false
    @State private var inFiles = false
    @Environment(\.workspaceColumn) private var workspaceColumn
    /// A thread of a project in the Build window, which titles it and has its tools (nil: the primary's chat).
    @Environment(\.buildThread) private var build
    @Environment(\.composerWanted) private var composerWanted
    /// While you were away (PLAN #37), for the primary's own chat: asked once as it opens.
    @State private var away: AwayView?
    /// A side question asked apart (its menu's Ask on the side…, or "/btw …" typed into the box).
    @State private var aside: SideQuestion?

    init(session: Session, chat: ChatModel? = nil, roster: (() -> Void)? = nil, forget: (() throws -> Void)? = nil) {
        self.session = session
        shown = chat
        self.roster = roster
        self.forget = forget
    }

    /// The refusal said on the chat, where the app opens: the node at this device's address proves to be another (NodePin).
    static func refusal(_ trouble: NodeError?) -> NodeError? { trouble?.notYourNode == nil ? nil : trouble }

    private var chat: ChatModel { shown ?? session.chat }
    private var latestAnswer: Int? { chat.thread.turns.last { $0.role == .assistant }?.id }

    var body: some View {
        #if os(iOS)
        let _ = PerfProbe.shared.mark("chat body")
        #endif
        ScrollView {
            // A plain stack: an answer's rows are tall and hold sideways-scrolling code and tables, and a lazy stack
            // pinned to the bottom kept placing them again and never settled (seen in the iOS 26.1 simulator).
            VStack(alignment: .leading, spacing: Metrics.margin) {
                if chat.thread.isEmpty {
                    if chat.loading { ProgressView().frame(maxWidth: .infinity).padding(.top, Space.s10) } else { welcome }
                    // Under the welcome, so its coming moves nothing above it.
                    if let away, !away.lines.isEmpty {
                        AwayCard(away: away) {
                            session.markAwaySeen()
                            self.away = nil
                        }
                    }
                }
                if let problem = chat.problem {
                    Label("This chat couldn't be read: \(problem)", systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.danger)
                }
                ForEach(chat.thread.turns) { turn in
                    MessageRow(
                        turn: turn,
                        client: session.client,
                        reply: { chat.quote($0); composing = true },
                        edit: turn.role == .user && !chat.answering ? { chat.edit($0); composing = true } : nil,
                        askAgain: turn.id == chat.thread.turns.last?.id && chat.canAskAgain ? { chat.askAgain(with: session.client) } : nil
                    )
                        .environment(\.answerLive, turn.status == .streaming)
                        // Choices it offered are yours to tap on its latest finished answer only.
                        .environment(\.choose, turn.id == latestAnswer && turn.status == .done && !chat.answering ? { text in chat.reply(text, with: session.client) } : nil)
                }
            }
            .padding(.horizontal, Metrics.margin)
            .padding(.vertical, Space.s3)
            .readingWidth()
        }
        .keepingLatest()
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .modifier(LinkTrouble(session: session, said: build == nil && shown == nil, drawer: roster != nil, forget: forget))
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Space.s2) {
                #if os(iOS)
                // What needs you, on the chat itself (one screen): its first decision, answered in place.
                if build == nil && shown == nil { NeedsCard(session: session) }
                #endif
                // What is under way in this chat: its agents' tasks given here (Stop on each), its looks that wait.
                UnderwayBar(session: session, chat: chat)
                // What waits above the box while it works: steers on their way, the queue, what became of a message.
                QueuePanel(chat: chat, client: session.client)
                Composer(chat: chat, client: session.client, composing: $composing, askAside: { openAside($0) })
            }
        }
        .screen("chat.screen")
        .navigationTitle(build?.project ?? Primary.name)
        .inlineTitle()
        // A conversation has the screen to itself, as in Messages.
        .hidingTabBar()
        #if os(macOS)
        // On a Mac, the window's own title and its subtitle (a Build thread's: its title, and the branch it works on).
        .navigationSubtitle(build.map { [chat.title ?? "New thread", $0.branch].compactMap { $0 }.joined(separator: " · ") } ?? chat.title ?? session.primary.line)
        #endif
        .toolbar {
            if build == nil {
            #if os(iOS)
            // As Grok's and T3 Code's (the owner's word of 28 November 2026): the drawer, the chat's title, a new chat.
            // Nothing else: its chats and agents are in the drawer, its computer in Settings, a side question "/btw".
            if let roster {
                ToolbarItem(placement: .topBarLeading) {
                    DrawerButton(needs: session.needsYou, open: roster)
                }
            }
            ToolbarItem(placement: .principal) {
                Text(chat.title ?? "New chat")
                    .font(.headline)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("chat.title")
            }
            ToolbarItem(placement: .topBarTrailing) { newChat }
            #else
            ToolbarItem(placement: .navigation) {
                PrimaryOrb(size: 26, tone: session.primaryTone, mood: session.primaryMood)
            }
            ToolbarItemGroup(placement: .barTrailing) {
                newChat
                // The rest in one menu (I10: one thing in full, the rest a tap further): its chats, and its own computer
                // once it has one (made from the web app or a terminal, as an agent's VM is).
                Menu {
                    Button { listing = true } label: { Label("All chats", systemImage: "clock.arrow.circlepath") }
                        .accessibilityIdentifier("chats")
                    // Something about the work in hand, without changing its course (the PWA's Ask on the side…).
                    Button { openAside("") } label: { Label("Ask on the side…", systemImage: "bubble.left") }
                        .accessibilityIdentifier("chat.aside")
                    if session.team?.computer != nil && session.can("sandbox") {
                        Section("Its computer") {
                            Button {
                                if let workspaceColumn { workspaceColumn.wrappedValue.toggle() } else { inFiles = true }
                            } label: {
                                Label("Its files", systemImage: "folder")
                            }
                            Button { watching = true } label: { Label("Its screen", systemImage: "display") }
                            Button { inTerminal = true } label: { Label("Its terminal", systemImage: "apple.terminal") }
                        }
                    }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .accessibilityIdentifier("chat.more")
            }
            #endif
            }
        }
        .navigationDestination(isPresented: $watching) {
            if let computer = session.team?.computer { AgentScreenView(session: session, agent: VMSeat(computer: computer)) }
        }
        .cover(isPresented: $inTerminal) {
            if let computer = session.team?.computer { AgentTerminalView(session: session, agent: VMSeat(computer: computer)) }
        }
        .sheet(isPresented: $inFiles) { WorkspaceView(session: session, id: "primary", name: Primary.name) }
        .sheet(isPresented: .init(get: { aside != nil }, set: { if !$0 { aside = nil } })) {
            if let aside {
                AsideSheet(side: aside, client: session.client) { words in chat.notice = (words, "") }
            }
        }
        .sheet(isPresented: $listing) {
            ChatsView(session: session) { id in
                listing = false
                Task { await chat.open(id, with: session.client) }
            } startNew: {
                listing = false
                chat.startNew()
                composing = true
            }
        }
        // From the left edge, the roster, where it is a drawer (the chat is where an iPhone's app opens: nothing is under
        // it for that edge to go back to).
        .overlay(alignment: .leading) {
            if let roster {
                Color.clear
                    .frame(width: 18)
                    .contentShape(.rect)
                    .gesture(DragGesture(minimumDistance: 8).onEnded { if $0.translation.width > 36 { roster() } })
                    .accessibilityHidden(true)
            }
        }
        .task {
            await chat.openLatest(with: session.client)
            #if os(iOS)
            // Its first frame with what it shows, its latest chat or its welcome: a launch is usable here.
            PerfProbe.shared.usable()
            #endif
            if build == nil && shown == nil { away = await session.away() }
        }
        // Shown, what it answered in it is read (and stops being new everywhere); gone from the screen, nothing more is.
        .onAppear {
            if chat.read == nil { chat.read = Self.noting(session) }
            chat.onScreen = true
            chat.markRead(with: session.client)
        }
        .onDisappear { chat.onScreen = false }
        // A new chat asked for from the menus (⌘N, a Mac's or an iPad's): the message box takes the keys.
        .task(id: composerWanted.wrappedValue) {
            guard composerWanted.wrappedValue else { return }
            composerWanted.wrappedValue = false
            composing = true
        }
    }

    /// What a chat tells as its answers are read: the session's list of chats with something new, the session held weakly
    /// (it holds its own chat, which keeps this). Made apart from the view's closure, which holds the session strongly
    /// itself: made there, Swift warns that the weak hold inside it differs from that one (ImplicitStrongCapture).
    private static func noting(_ session: Session) -> (String) -> Void {
        { [weak session] id in session?.noteRead(id) }
    }

    /// A new chat, its message box taking the keys: none while it answers, nor over one with nothing in it yet.
    private var newChat: some View {
        Button {
            chat.startNew()
            composing = true
        } label: {
            Label("New chat", systemImage: "square.and.pencil")
        }
        .disabled(chat.answering || chat.thread.isEmpty)
        .accessibilityIdentifier("chat.new")
    }

    /// A side question, asked apart: about this kept chat, or the turn under way in a new one; nothing yet, said so.
    private func openAside(_ question: String) {
        guard let about = chat.asideAbout else {
            chat.notice = ComposerWords.nothingYet
            return
        }
        aside = SideQuestion(about: about, working: chat.answering, question: question)
    }

    /// A new chat: the primary itself, as its orb (PrimaryHome.swift), what you might ask it, and what it asks you.
    private var welcome: some View {
        PrimaryWelcome(session: session) { text in
            chat.draft = text
            composing = true
        }
    }
}

/// The link's trouble over the chat. A node that proves to be another is said wherever the chat is the session's own, with
/// Try again and Forget this device (confirmed first). Where the roster is a drawer (an iPhone's), nothing else on the screen
/// says the rest, so it is said here too: reconnecting, or what went wrong.
private struct LinkTrouble: ViewModifier {
    let session: Session
    /// The chat is the session's own (not a Build thread's, nor one in a window of its own).
    let said: Bool
    let drawer: Bool
    let forget: (() throws -> Void)?
    @State private var forgetting = false
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) { line }
            .confirmationDialog("Forget this device?", isPresented: $forgetting, titleVisibility: .visible) {
                Button("Forget this device", role: .destructive) {
                    do { try forget?() } catch { problem = error.localizedDescription }
                }
            } message: {
                Text("Its key is deleted and can't be brought back.")
            }
            .alert("That didn't go through", isPresented: .init(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(problem ?? "")
            }
    }

    @ViewBuilder private var line: some View {
        if said, let refused = ChatView.refusal(session.trouble) {
            NotYourNodeCard(trouble: refused, retry: { Task { await session.refresh() } }, forget: forget.map { _ in { forgetting = true } })
        } else if drawer {
            if Session.showsReconnecting(session.reconnecting, trouble: session.trouble) {
                ReconnectingLine(session: session).padding(.horizontal, Metrics.margin).background(.bar)
            } else if let trouble = session.trouble {
                TroubleRow(trouble: trouble).font(.callout).padding(.horizontal, Metrics.margin).padding(.vertical, Space.s2).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
            }
        }
    }
}

/// The node at this device's address proves to be another (NodePin): said on the chat, where the app opens, with Try again
/// (whoami asked again, nothing else) and Forget this device, to pair it anew (Settings has it too). The lead's word of 27
/// November 2026: Android found the refusal said only on the old Home and Agents once its app opened on the chat.
struct NotYourNodeCard: View {
    let trouble: NodeError
    let retry: () -> Void
    /// Asks to forget this device (nil: not offered here; Settings has it).
    let forget: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            TroubleRow(trouble: trouble).font(.callout)
            HStack(spacing: Space.s2) {
                NeedButton(title: "Try again", prominent: true, action: retry)
                    .accessibilityIdentifier("chat.refused.retry")
                if let forget {
                    NeedButton(title: "Forget this device…", action: forget)
                        .accessibilityIdentifier("chat.refused.forget")
                }
            }
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.refused")
    }
}

/// While you were away (PLAN #37): what happened since this device last showed you, each line led by its state's dot
/// (the ink, grey, or red for what went wrong), between hairlines, and a press to say it's read.
struct AwayCard: View {
    let away: AwayView
    let read: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Divider()
            HStack(alignment: .firstTextBaseline) {
                SectionHead("While you were away")
                Text(Date(timeIntervalSince1970: away.since / 1000), style: .relative).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(away.lines, id: \.self) { line in
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Circle().fill(Self.tint(line.tone)).frame(width: 8, height: 8)
                    Text(line.text).font(.subheadline)
                }
            }
            HStack {
                Spacer()
                Button("Got it", action: read).font(.subheadline.weight(.semibold)).frame(minHeight: Metrics.touch)
            }
            Divider()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("While you were away")
    }

    private static func tint(_ tone: String) -> Color {
        switch tone {
        case "ok": .done
        case "warn": .needs
        case "danger": .failed
        default: .secondary
        }
    }
}

/// One message: yours on the right in the ink, its on the left beside its drawing, with what it did above it.
struct MessageRow: View {
    let turn: ChatThread.Turn
    /// Where a picture you attached is read from, to show it (nil: shown only once it is known here).
    var client: NodeClient? = nil
    /// What holding it offers beyond copying and sharing (MessageMenu): quoting it, editing yours, asking its again.
    var reply: ((String) -> Void)? = nil
    var edit: ((String) -> Void)? = nil
    var askAgain: (() -> Void)? = nil

    var body: some View {
        switch turn.role {
        case .user where turn.look != nil:
            // A look of its come back: its own note, never shown as yours.
            Label(UnderwayWords.looked(turn.look!), systemImage: "clock")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(UnderwayWords.looked(turn.look!))
        case .user:
            VStack(alignment: .trailing, spacing: Space.s2) {
                // What it carried, above its words (a message may be files alone).
                if let refs = turn.attachments, !refs.isEmpty { AttachedView(refs: refs, client: client) }
                if !turn.content.isEmpty {
                    HStack {
                        Spacer(minLength: Metrics.yoursInset)
                        Text(turn.content)
                            .foregroundStyle(Color.onAccent)
                            .padding(Metrics.bubblePadding)
                            .background(Color.ink, in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
                            .messageMenu(turn.content, reply: reply, edit: edit)
                    }
                }
            }
        case .assistant:
            HStack(alignment: .top, spacing: Space.s2) {
                // Its orb beside each answer it gives, still and at rest, but for the one it is writing, which is at work (an
                // orb of its own, so it never pulls its header's out of where it stands): the colour of its state is its
                // line's, above.
                PrimaryOrb(size: Metrics.speakerFace, mood: turn.status == .streaming ? .working : nil, key: "primary:writing")
                VStack(alignment: .leading, spacing: Space.s2) {
                    ForEach(Array(turn.steps.enumerated()).filter { $0.element.tool != nil }, id: \.offset) { _, step in
                        StepLine(step: step)
                    }
                    if !turn.content.isEmpty {
                        MarkdownView(turn.content)
                            .padding(Metrics.bubblePadding)
                            .background(.fill.tertiary, in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
                            .messageMenu(turn.content, reply: reply, askAgain: turn.status == .streaming ? nil : askAgain)
                            .accessibilityIdentifier("primary-answer")
                    }
                    footer
                }
                Spacer(minLength: Space.s6)
            }
        }
    }

    @ViewBuilder private var footer: some View {
        switch turn.status {
        case .streaming:
            HStack(spacing: Space.s2) {
                LiveDot(color: .secondary)
                Text(turn.steps.last?.text ?? "Starting")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .error:
            HStack(spacing: Space.s2) {
                Label("Couldn't answer: \(turn.error ?? "no reason given")", systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Color.danger)
                if let askAgain { Button("Ask Again", action: askAgain).font(.caption.weight(.semibold)).buttonStyle(.borderless) }
            }
        case .stopped:
            Label(turn.steps.last { $0.state == .warn && $0.tool == nil }?.text ?? "Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .steered:
            Label("Your message reached it here", systemImage: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary)
        case .done:
            EmptyView()
        }
    }
}

/// The message box (ComposerBox): on the keyboard, growing to eight lines; Send, or while it answers Queue, Steer and Stop
/// under its words.
struct Composer: View {
    @Bindable var chat: ChatModel
    let client: NodeClient
    var composing: FocusState<Bool>.Binding
    /// Told once a message has gone (the iPhone's home shows the chat it began).
    var sent: (() -> Void)? = nil
    /// What the empty box says.
    var prompt = "Ask your agent…"
    /// A side question typed into the box ("/btw …"): asked apart, never sent as a message (nil: not offered here).
    var askAside: ((String) -> Void)? = nil
    /// What Return does while it works, on this device (Settings → Chat; steer unless you chose otherwise).
    @AppStorage("chat.enter") private var enter = ComposerWords.Enter.steer.rawValue
    @Environment(\.dynamicTypeSize) private var typeSize

    private var choice: ComposerWords.Enter { ComposerWords.Enter(rawValue: enter) ?? .steer }
    /// While it works, a message can go: words, and no files (they go with a message it answers from its start).
    private var ready: Bool { !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.outbox.carried.isEmpty && !chat.outbox.going }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            OutboxLines(outbox: chat.outbox)
            // At the accessibility sizes, Queue and Steer stand over the box, so it keeps its width.
            if chat.answering, typeSize.isAccessibilitySize {
                HStack(spacing: Space.s2) { busyButtons }
            }
            field
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.vertical, Space.s2)
        .readingWidth()
        .takingFiles(chat.outbox, client: client, composing: composing)
    }

    private var field: some View {
        ComposerBox(composing: composing) {
            // Made anew with each message sent: clearing a focused multi-line field can leave what was sent on screen, or
            // let the keyboard put back what it still held (a word it was correcting, a dictation finishing). A new one is
            // empty, and nothing late reaches it. While it works it stays open: what you write steers it or is queued
            // (the PWA's words for it).
            TextField(chat.answering ? ComposerWords.placeholder(canQueue: chat.canQueue) : prompt, text: $chat.draft, axis: .vertical)
                .plainField()
                .id(chat.sent)
                .lineLimit(1...8)
                .focused(composing)
                .sendsOnReturn(modified: { send(modifier: $0) })
                .accessibilityIdentifier("composer")
        } leading: {
            AttachButton(outbox: chat.outbox, client: client)
        } trailing: {
            if chat.answering {
                if !typeSize.isAccessibilitySize { busyButtons }
                ComposerStop(label: "Stop \(Primary.name) answering") { chat.stop(with: client) }
                    .accessibilityIdentifier("composer.stop")
            } else {
                ComposerSend(ready: chat.sendable, label: "Send") { send() }
            }
        }
    }

    /// While it works: Queue (where the chat is kept) and Steer, each its own button (the way on a phone); the one Return
    /// does is in ink once there is something to send, the other quiet.
    @ViewBuilder private var busyButtons: some View {
        if chat.canQueue {
            ComposerChoice(title: "Queue", filled: ready && choice == .queue, ready: ready, hint: "Keep it on the node and send it when it's done") { send(how: .queue) }
                .accessibilityIdentifier("composer.queue")
        }
        ComposerChoice(title: "Steer", filled: ready && (choice == .steer || !chat.canQueue), ready: ready, hint: "Tell it now: it reaches it at its next safe point") { send(how: .steer) }
            .accessibilityIdentifier("composer.steer")
    }

    /// What's in the box, by its button or Return: a side question typed into it is asked apart; while it works the
    /// words steer it or are queued (`how`: a button's own; otherwise Return's, `modifier` for the other); otherwise
    /// they are sent, with files that are up.
    private func send(modifier: Bool = false, how: ComposerWords.Action? = nil) {
        if let askAside, let question = ComposerWords.aside(chat.draft) {
            chat.draft = ""
            askAside(question)
            return
        }
        if chat.answering {
            chat.deliver(how, modifier: modifier, enter: choice, with: client)
            return
        }
        guard chat.sendable else { return }
        let typing = composing.wrappedValue
        chat.send(with: client)
        // Shown elsewhere now (over the iPhone's home): the keyboard goes with this box.
        if let sent {
            composing.wrappedValue = false
            sent()
            return
        }
        // The new box takes the keyboard where the old one had it, so it stays up for the next message.
        if typing { Task { @MainActor in composing.wrappedValue = true } }
    }
}

/// A tool's step in its answer, as a work log: what it used, the command it ran (when it ran one), and the first lines of
/// what came back.
private struct StepLine: View {
    let step: ChatThread.Step

    var body: some View {
        let (command, answer) = WorkLog.parts(step.detail)
        VStack(alignment: .leading, spacing: Space.line) {
            Label {
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Text(step.text)
                    if let command {
                        Text(command).font(.caption.monospaced()).foregroundStyle(.primary).lineLimit(1).truncationMode(.tail).textSelection(.enabled)
                    }
                }
            } icon: {
                Image(systemName: step.state == .active ? "gearshape" : step.state == .done ? "checkmark.circle" : "exclamationmark.circle")
            }
            if command != nil, let answer {
                Text(answer)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .padding(.leading, Space.s4 + Space.s1)
            }
        }
        .font(.caption)
        // Red only for a step that failed; a warning is said in the ink.
        .foregroundStyle(step.state == .error ? AnyShapeStyle(Color.danger) : step.state == .warn ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
    }
}

#if os(iOS)
/// What needs you, at the chat's foot (the owner's word of 28 November 2026: one screen, as Grok's): the first decision,
/// its one answer in place, and how many more wait, a tap from Needs you. Nothing while nothing does.
private struct NeedsCard: View {
    let session: Session
    @State private var desk = DecisionDesk()
    @Environment(\.openPlace) private var openPlace
    @Environment(\.showInbox) private var showInbox

    var body: some View {
        if let work = session.attended {
            let decisions = desk.decisions(session, work, go: { openPlace?($0) })
            if let first = decisions.first {
                VStack(alignment: .leading, spacing: 0) {
                    DecisionRow(decision: first, busy: desk.busy.contains(first.id))
                    if decisions.count > 1 {
                        Divider()
                        Button { showInbox?() } label: {
                            HStack {
                                Text("\(decisions.count - 1) more need you").font(.subheadline.weight(.semibold))
                                Spacer(minLength: Space.s2)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                            .frame(minHeight: Metrics.touch)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat.needs.more")
                    }
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s1)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: ComposerBoxMetrics.radius, style: .continuous))
                // As wide as the message box under it and what is under way: on an iPad the conversation's column, not
                // the window's (the first pictures had it out to the sidebar).
                .padding(.horizontal, Metrics.margin)
                .readingWidth()
                .modifier(DecisionDeskSheets(desk: desk, session: session))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat.needs")
            }
        }
    }
}
#endif
