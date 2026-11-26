import SwiftUI

/// A room of several agents: what each of them and you said there and the work given in it, in the order it happened,
/// with the message box below (the PWA's room timeline). Its settings, its pause and giving one of them a task are in
/// the toolbar's menu.
struct RoomView: View {
    let session: Session
    let id: String
    @State private var room: AgentRoom
    @State private var giving = false
    @State private var editing = false
    @State private var stopping: TeamTask?
    /// The verified work being shipped as a pull request (ShipPrompt asks its title).
    @State private var shipping: TeamTask?
    /// The task whose steps are being chosen from, to give it again from one.
    @State private var stepping: TeamTask?
    @State private var problem: String?
    @FocusState private var composing: Bool

    init(session: Session, id: String) {
        self.session = session
        self.id = id
        _room = State(initialValue: AgentRoom(room: id))
    }

    private var info: TeamRoom? { session.room(id) }
    private var row: RoomRow? { session.roomRows.first { $0.id == id } }
    private var name: String { room.view?.name ?? info?.name ?? row?.name ?? "Room" }
    private var paused: Bool { info?.paused ?? room.view?.paused ?? false }
    private var members: [Agent] { (room.view?.members ?? info?.members ?? []).compactMap { session.agent($0) } }

    private var items: [Timeline.Item] {
        guard let view = room.view else { return [] }
        return Timeline.items(messages: view.messages, tasks: Timeline.tasks(room: (view.id, view.direct, view.members), all: view.tasks))
    }

    /// Who is writing a reply now, by name.
    private var writing: [String] {
        (room.view?.deliveries ?? []).filter { $0.status == "queued" || $0.status == "running" }.map { $0.agent == "primary" ? Primary.name : session.agent($0.agent)?.name ?? $0.agent }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.margin) {
                if info == nil, room.view == nil, room.problem == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Space.s10)
                } else if items.isEmpty, room.view != nil {
                    welcome
                }
                ForEach(items) { item in
                    switch item {
                    case .message(let message):
                        TeamBubble(message: message, speaker: Timeline.speaker(message, agents: session.team?.agents ?? []), profile: session.agent(message.speaker)?.avatar, named: true, client: session.client) { text in
                            room.quote(text, by: Timeline.speaker(message, agents: session.team?.agents ?? []))
                            composing = true
                        }
                    case .task(let task):
                        TaskCardView(task: task, proposer: task.proposedBy.map { $0 == "primary" ? Primary.name : session.agent($0)?.name ?? $0 }, fromStep: { stepping = task }) { action in act(action, on: task) }
                    }
                }
                if !writing.isEmpty {
                    WritingLine(words: "\(writing.joined(separator: ", ")) \(writing.count > 1 ? "are" : "is") writing…")
                }
                if let problem = problem ?? room.problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
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
            VStack(spacing: 0) {
                if paused {
                    Label("Paused: nobody here takes new work until you resume the room.", systemImage: "pause.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, Space.s2)
                }
                RoomComposer(room: room, name: name, client: session.client, composing: $composing, seats: members.map { Mentions.Seat(id: $0.id, name: $0.name) } + [Mentions.Seat(id: "primary", name: Primary.name)])
            }
        }
        .navigationTitle(name)
        .inlineTitle()
        .hidingTabBar()
        #if os(macOS)
        // On a Mac, the window's own title and its subtitle.
        .navigationSubtitle(row?.line ?? members.map(\.name).joined(separator: ", "))
        #endif
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .principal) {
                TimelineTitle(title: name, line: row?.line ?? members.map(\.name).joined(separator: ", "), needs: row?.needs == true)
            }
            #endif
            ToolbarItem(placement: .barTrailing) {
                Menu {
                    Button { giving = true } label: { Label("Give a task", systemImage: "hammer") }
                        .disabled(room.view == nil || members.isEmpty)
                    Button { editing = true } label: { Label("Room settings", systemImage: "slider.horizontal.3") }
                        .disabled(info == nil)
                    Button { Task { await setPaused(!paused) } } label: {
                        Label(paused ? "Resume the room" : "Pause the room", systemImage: paused ? "play.circle" : "pause.circle")
                    }
                } label: {
                    Label("Room", systemImage: "ellipsis.circle")
                }
                .disabled(!session.can("fleet:admin"))
            }
        }
        .sheet(isPresented: $giving) {
            GiveTaskSheet(name: name, members: members.map { ($0.id, $0.name) }) { title, goal, gates, assignee, budget in
                try await room.give(title: title, goal: goal, gates: gates, assignee: assignee, budgetUsd: budget, with: session.client)
            }
        }
        .sheet(isPresented: $editing) {
            if let info { RoomEditor(session: session, existing: info) }
        }
        .confirmationDialog("Stop this task?", isPresented: .init(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { task in
            Button("Stop it", role: .destructive) { Task { await room.control(task, "stop", with: session.client) } }
        } message: { task in
            Text("“\(task.title)” stops where it is. What it changed so far stays in its agent's workspace.")
        }
        .modifier(ShipPrompt(task: $shipping, room: room, client: session.client))
        .modifier(StepsPicker(task: $stepping, room: room, client: session.client))
        .task(id: id) {
            while !Task.isCancelled {
                await room.load(room: id, with: session.client)
                try? await Task.sleep(for: .seconds(writing.isEmpty ? 4 : 2))
            }
        }
        // On screen, what ended here is read: no longer new, on any device.
        .task(id: row?.unread) {
            if row?.unread == true { await session.read(room: id) }
        }
    }

    private var welcome: some View {
        TimelineWelcome(title: name, words: "Say what you need: \(Primary.name) sits here, answers, and brings in whichever of \(ListFormatter.localizedString(byJoining: members.map(\.name))) the work needs. Name an agent with @ to ask it yourself.") {
            HStack(spacing: -14) {
                ForEach(members.prefix(5)) { member in
                    WorkerFace(id: member.id, profile: member.avatar, size: 72, expression: session.rows.first { $0.id == member.id }?.expression ?? "idle")
                }
            }
        }
    }

    private func act(_ action: TaskCard.Action, on task: TeamTask) {
        switch action {
        case .approve: Task { await room.control(task, "approve", with: session.client) }
        case .decline: Task { await room.control(task, "stop", with: session.client) }
        case .stop: stopping = task
        case .resume: Task { await room.control(task, "resume", with: session.client) }
        case .again: Task { await room.giveAgain(task, with: session.client) }
        case .ship: shipping = task
        }
    }

    private func setPaused(_ pause: Bool) async {
        do {
            try await session.control(room: id, pause ? "pause" : "resume")
            problem = nil
            await room.load(room: id, with: session.client)
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// One of a room's members, as its face is drawn: its handle, and the colour you chose for its orb, if you did.
struct MemberFace {
    let id: String
    let profile: JSONValue?
}

/// A room on the agents: who is in it (up to three faces, still, centred where an agent's face stands), its name, and
/// one line of where it stands.
struct RoomRowView: View {
    let row: RoomRow
    let faces: [MemberFace]
    var selected = false

    var body: some View {
        RosterLine(name: row.name, line: row.line, needs: row.needs, fresh: row.unread, selected: selected) {
            let shown = Array(faces.prefix(3))
            ZStack {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, face in
                    WorkerFace(id: face.id, profile: face.profile, size: Metrics.rowFace * 0.6)
                        .offset(x: (CGFloat(index) - CGFloat(shown.count - 1) / 2) * Metrics.rowFace * 0.2, y: index % 2 == 0 ? -Space.s1 : Space.s1)
                }
            }
        }
    }
}
