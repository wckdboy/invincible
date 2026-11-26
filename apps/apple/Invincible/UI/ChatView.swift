import SwiftUI

/// The primary's chat: your messages and its answers as bubbles, its streaming in as it comes, and the message box on the
/// keyboard. A new chat keeps the one before it on the node.
struct ChatView: View {
    let session: Session
    /// The chat shown, when it isn't the session's (on a Mac, one of its chats in a window of its own).
    private let shown: ChatModel?
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

    init(session: Session, chat: ChatModel? = nil) {
        self.session = session
        shown = chat
    }

    private var chat: ChatModel { shown ?? session.chat }
    private var latestAnswer: Int? { chat.thread.turns.last { $0.role == .assistant }?.id }

    var body: some View {
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
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Space.s2) {
                // What is under way in this chat: its agents' tasks given here (Stop on each), its looks that wait.
                UnderwayBar(session: session, chat: chat)
                Composer(chat: chat, client: session.client, composing: $composing)
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
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.s2) {
                    PrimaryOrb(size: 30, tone: session.primaryTone, mood: session.primaryMood)
                    TimelineTitle(title: Primary.name, line: chat.title ?? session.primary.line, needs: chat.title == nil && session.primary.tone == .warn, alignment: .leading)
                }
            }
            #else
            ToolbarItem(placement: .navigation) {
                PrimaryOrb(size: 26, tone: session.primaryTone, mood: session.primaryMood)
            }
            #endif
            ToolbarItemGroup(placement: .barTrailing) {
                // Its own computer, once it has one (made from the web app or a terminal, as an agent's VM is).
                if session.team?.computer != nil && session.can("sandbox") {
                    Menu {
                        Button {
                            if let workspaceColumn { workspaceColumn.wrappedValue.toggle() } else { inFiles = true }
                        } label: {
                            Label("Its files", systemImage: "folder")
                        }
                        Button { watching = true } label: { Label("Its screen", systemImage: "display") }
                        Button { inTerminal = true } label: { Label("Its terminal", systemImage: "apple.terminal") }
                    } label: {
                        Label("Its computer", systemImage: "desktopcomputer")
                    }
                    .accessibilityIdentifier("computer")
                }
                Button {
                    listing = true
                } label: {
                    Label("Chats", systemImage: "clock.arrow.circlepath")
                }
                .accessibilityIdentifier("chats")
                Button {
                    chat.startNew()
                    composing = true
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                .disabled(chat.answering || chat.thread.isEmpty)
            }
            }
        }
        .navigationDestination(isPresented: $watching) {
            if let computer = session.team?.computer { AgentScreenView(session: session, agent: VMSeat(computer: computer)) }
        }
        .cover(isPresented: $inTerminal) {
            if let computer = session.team?.computer { AgentTerminalView(session: session, agent: VMSeat(computer: computer)) }
        }
        .sheet(isPresented: $inFiles) { WorkspaceView(session: session, id: "primary", name: Primary.name) }
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
        .task {
            await chat.openLatest(with: session.client)
            if build == nil && shown == nil { away = await session.away() }
        }
        // Shown, what it answered in it is read (and stops being new everywhere); gone from the screen, nothing more is.
        .onAppear {
            if chat.read == nil { chat.read = { [weak session] id in session?.noteRead(id) } }
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

    /// A new chat: the primary itself, as its orb (PrimaryHome.swift), what you might ask it, and what it asks you.
    private var welcome: some View {
        PrimaryWelcome(session: session) { text in
            chat.draft = text
            composing = true
        }
    }
}

/// While you were away (PLAN #37): what happened since this device last showed you, each line led by its state's
/// colour (the PWA's too), and a press to say it's read.
struct AwayCard: View {
    let away: AwayView
    let read: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(alignment: .firstTextBaseline) {
                Text("While you were away").font(.subheadline.weight(.semibold))
                Spacer()
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
                Button("Got it", action: read).font(.subheadline)
            }
        }
        .padding(Space.s3)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: Metrics.cardRadius))
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

/// The message box: on the keyboard, growing to six lines; Send, or Stop while it answers.
struct Composer: View {
    @Bindable var chat: ChatModel
    let client: NodeClient
    var composing: FocusState<Bool>.Binding
    /// Told once a message has gone (the iPhone's home shows the chat it began).
    var sent: (() -> Void)? = nil
    /// What the empty box says.
    var prompt = "Message \(Primary.name)"

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            OutboxLines(outbox: chat.outbox)
            field
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.vertical, Space.s2)
        .readingWidth()
        .takingFiles(chat.outbox, client: client, composing: composing)
    }

    private var field: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(alignment: .bottom, spacing: Space.s2) {
                AttachButton(outbox: chat.outbox, client: client)
                // Made anew with each message sent: clearing a focused multi-line field can leave what was sent on
                // screen, or let the keyboard put back what it still held (a word it was correcting, a dictation
                // finishing). A new one is empty, and nothing late reaches it.
                TextField(prompt, text: $chat.draft, axis: .vertical)
                    .plainField()
                    .id(chat.sent)
                    .lineLimit(1...6)
                    .focused(composing)
                    .sendsOnReturn(send)
                    .padding(.horizontal, Space.s4)
                    // One line high, the field is 44 points: Apple's least for a thing to tap.
                    .padding(.vertical, 11)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22, style: .continuous))
                    .accessibilityIdentifier("composer")
                if chat.answering {
                    Button {
                        chat.stop(with: client)
                    } label: {
                        Image(systemName: "stop.fill").font(.body.weight(.semibold)).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Stop \(Primary.name) answering")
                } else {
                    let empty = !chat.sendable
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(Prominent.label(dimmed: empty)).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .disabled(empty)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("send")
                }
            }
        }
    }

    /// What's in the box, sent (by its button, or Return): never while it answers, and only words or files that are up.
    private func send() {
        guard !chat.answering, chat.sendable else { return }
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
        .foregroundStyle(step.state == .warn || step.state == .error ? Color.danger : .secondary)
    }
}
