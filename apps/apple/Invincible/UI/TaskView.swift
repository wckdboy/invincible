import SwiftUI

/*
 * A task as a thread of its own (the PWA's views/task.ts; your words, 26 November 2026: "project/tasks/coding t3code
 * style for the agents"), as T3 Code has a thread: what it is (its project, its title), the brief and who gave it, its
 * agent's work folded into steps ("Ada worked for 6m 12s ›": read 6 files, edited 3, ran 14 commands; while it works,
 * the steps as they come and one live line), an outward step asking in place, what the agent said, and then, apart from
 * the agent's words and in its own colour, what proves it: the Verified card (each gate's command and how it ended, the
 * reviewer that didn't write it, its changes, its cost, and Ship it). Beside it on a wide screen, and in a sheet on an
 * iPhone, its details: the agent's VM, where its work began, its changes, its gates as they run, the reviewer, its cost
 * against its budget, and what waits on it.
 *
 * Everything is what the node already answers: the team (the task, its agent, what depends on it), the task's trail
 * (POST /api/team/trail: the runner's own lines, never the agent's account; Steps.swift reads them), its conversation
 * (POST /api/team/room), its changes (POST /api/team/changes, where this device may look into a VM) and your prices.
 */

/// What a task's thread reads beyond the team: its trail, page by page as the node keeps it, its room (its conversation,
/// and where you tell its agent something), and its changes.
@MainActor @Observable final class TaskThread {
    let id: String
    private(set) var entries: [TrailEntry] = []
    private var after = 0
    /// The whole trail has been read once (until then the work isn't drawn: it would arrive in pieces).
    private(set) var read = false
    private(set) var problem: String?
    /// The task's own conversation: its words since it was given, and where your message to its agent goes.
    let room: AgentRoom
    private(set) var changes: TeamChangesView?
    private var changesAt = ""

    init(task: TeamTask) {
        id = task.id
        room = AgentRoom(room: task.room)
    }

    private struct Page: Decodable {
        struct Task: Decodable { let id: String; let status: String }
        let task: Task
        let entries: [TrailEntry]
        let more: Bool
    }

    /// What is new on its trail since the last line held, as many pages as the node has.
    func readTrail(with client: NodeClient) async {
        struct Ask: Encodable { let task: String; let after: Int }
        do {
            while true {
                let page = try await client.post("/api/team/trail", Ask(task: id, after: after), as: Page.self)
                let fresh = page.entries.filter { $0.n > after }
                if let last = fresh.last {
                    entries = Array((entries + fresh).suffix(600))
                    after = last.n
                }
                problem = nil
                if !(page.more && !fresh.isEmpty) { break }
            }
        } catch {
            problem = error.localizedDescription
        }
        read = true
    }

    /// What it changed, asked for once and again when the work has moved on (ended, or kept), where this device may look
    /// into a VM and its agent works in a repository.
    func readChanges(_ task: TeamTask, agent: Agent?, session: Session) async {
        let at = "\(task.status)/\(task.changes?.artifact ?? "")"
        guard session.can("sandbox"), agent?.repository != nil, changesAt != at, task.status != "proposed", task.status != "queued" else { return }
        changesAt = at
        struct Ask: Encodable { let id: String; let task: String }
        if let found = try? await session.client.post("/api/team/changes", Ask(id: task.assignee, task: task.id), as: TeamChangesView.self) { changes = found }
    }

    /// What was said in its conversation from when it was given until the next task given there.
    func conversation(of task: TeamTask) -> [TeamMessage] {
        guard let view = room.view else { return [] }
        let given = task.createdAt ?? task.updatedAt
        let next = view.tasks.filter { $0.id != task.id && ($0.createdAt ?? 0) > given }.map { $0.createdAt ?? 0 }.min() ?? .infinity
        return view.messages.filter { $0.createdAt >= given && $0.createdAt < next && $0.speaker != "system" }
    }
}

/// A task's thread: its header, its thread, the live line and "Tell <agent>…"; its details beside it on a wide screen
/// (`inspector`), in a sheet on an iPhone.
struct TaskView: View {
    let session: Session
    let id: String
    /// On a wide screen its details are a column beside it; on an iPhone, a sheet.
    var wide = false
    @State private var thread: TaskThread?
    /// What its answers do, from its bar's menu and from the thread.
    @State private var answers = TaskAnswers()
    @State private var detailsSheet = false
    @AppStorage("task.details") private var detailsShown = true
    @FocusState private var composing: Bool

    var body: some View {
        Group {
            if let task = session.task(id), let thread {
                TaskThreadView(session: session, task: task, thread: thread, answers: answers, composing: $composing)
                    .modifier(DetailsPlace(wide: wide, shown: $detailsShown, sheet: $detailsSheet) {
                        TaskDetails(session: session, task: task, thread: thread)
                    })
                    // (Outside the details column, so its buttons are the thread's bar's, not the column's.)
                    .toolbar { toolbar(task) }
                    .task(id: task.status) { await follow(task, thread) }
            } else if session.task(id) != nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if session.team == nil, session.teamProblem == nil {
                ProgressView("Reading the work…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let problem = session.teamProblem, session.team == nil {
                ContentUnavailableView {
                    Label("The work can't be read just now", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(problem)
                } actions: {
                    Button("Try again") { Task { await session.refresh() } }
                }
            } else {
                ContentUnavailableView("This task isn't here", systemImage: "square.stack.3d.up.slash", description: Text("It may have been given on another node, or its agent was removed. Home has the work, by what needs you."))
            }
        }
        .screen("task.screen")
        .navigationTitle(session.task(id)?.title ?? "Task")
        .inlineTitle()
        .hidingTabBar()
        .onAppear {
            if thread == nil, let task = session.task(id) { thread = TaskThread(task: task) }
        }
        .onChange(of: session.task(id) != nil) {
            if thread == nil, let task = session.task(id) { thread = TaskThread(task: task) }
        }
    }

    /// Its bar: its details, and the rest of its answers in a menu (the one in full is the thread's). Its title is the
    /// page's own, in full: the bar says none of it again.
    @ToolbarContentBuilder private func toolbar(_ task: TeamTask) -> some ToolbarContent {
        #if os(iOS)
        ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
        #endif
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                if wide { withAnimation(.snappy) { detailsShown.toggle() } } else { detailsSheet = true }
            } label: {
                Label(wide && detailsShown ? "Hide the details" : "Show the details", systemImage: "sidebar.trailing")
            }
            .help("The task's details: its VM, changes, gates, reviewer and cost")
            .accessibilityIdentifier("task.details")
            let rest = session.can("fleet:admin") && session.can("chat") ? TaskCard.answers(task).rest : []
            if !rest.isEmpty {
                Menu {
                    ForEach(rest, id: \.self) { action in
                        Button { answers.run(action, task, session: session) } label: { Label(TaskAnswers.title(action), systemImage: TaskAnswers.symbol(action)) }
                            .disabled(answers.busy)
                    }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .accessibilityIdentifier("task.more")
            }
        }
    }

    /// While it is on screen: its trail read (then again as the node says the agents moved, while it works), its
    /// conversation, its changes, your prices, and its result marked read.
    private func follow(_ task: TeamTask, _ thread: TaskThread) async {
        let client = session.client
        async let trail: Void = thread.readTrail(with: client)
        async let room: Void = thread.room.load(room: task.room, with: client)
        async let projects: Void = session.askProjects()
        _ = await (trail, room, projects)
        if task.record != nil { await session.askPrices() }
        await thread.readChanges(task, agent: session.drawn(task.assignee), session: session)
        await session.opened(task: task.id)
        #if os(iOS)
        // Its proof on the Lock Screen: started for one in hand you open, and told how it stands (its end too).
        if task.status == "running" || task.status == "queued" { LiveActivities.shared.start(task, agent: session.drawn(task.assignee), state: activityState(task, thread), session: session) }
        await LiveActivities.shared.update(task.id, activityState(task, thread))
        #endif
        // At work (or about to be): read again as the node says the agents moved (each step it takes moves them), its
        // trail within half a second, its conversation within two; nothing is asked while nothing moves.
        guard task.status == "running" || task.status == "queued" else { return }
        let steps = session.follow(["team"], every: 4_000, gap: 500) {
            await thread.readTrail(with: client)
            #if os(iOS)
            if let now = session.task(task.id) { await LiveActivities.shared.update(task.id, activityState(now, thread)) }
            #endif
        }
        let talk = session.follow(["team"], every: 8_000, gap: 2_000) { await thread.room.load(room: task.room, with: client) }
        await Session.held()
        steps()
        talk()
    }
}

/// How a task stands on its Live Activity, from its trail as read here.
@MainActor private func activityState(_ task: TeamTask, _ thread: TaskThread) -> TaskActivityState {
    TaskActivityState.of(status: task.status, verified: task.verified, error: task.error, gates: task.gates ?? [], record: task.record, entries: thread.entries, at: Date.now.timeIntervalSince1970 * 1000)
}

/// Where a task's details are: a column beside its thread on a wide screen (shown or hidden as you last left it), a sheet
/// on an iPhone.
private struct DetailsPlace<Details: View>: ViewModifier {
    let wide: Bool
    @Binding var shown: Bool
    @Binding var sheet: Bool
    @ViewBuilder let details: () -> Details

    func body(content: Content) -> some View {
        if wide {
            content.inspector(isPresented: $shown) {
                ScrollView { details().padding(.vertical, Space.s3) }
                    .inspectorColumnWidth(min: 300, ideal: 340, max: 420)
            }
        } else {
            content.sheet(isPresented: $sheet) {
                NavigationStack {
                    ScrollView { details().padding(.vertical, Space.s3) }
                        .navigationTitle("The task's details")
                        .inlineTitle()
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { sheet = false } } }
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}

/// What a thread's answers do, shared by its bar's menu and the thread itself: the task being given again or shipped
/// (each asks first), whether the node is being told, and what went wrong.
@MainActor @Observable final class TaskAnswers {
    var againing: TeamTask?
    var shipping: TeamTask?
    var busy = false
    var trouble: String?

    func run(_ action: TaskCard.Action, _ task: TeamTask, session: Session) {
        switch action {
        case .approve: control("approve", task, session)
        case .decline, .stop: control("stop", task, session)
        case .resume: control("resume", task, session)
        case .again: againing = task
        case .ship: shipping = task
        }
    }

    private func control(_ action: String, _ task: TeamTask, _ session: Session) {
        busy = true
        Task.immediate {
            defer { self.busy = false }
            do { try await session.control(task: task.id, action) } catch { self.trouble = error.localizedDescription }
        }
    }

    static func title(_ action: TaskCard.Action) -> String {
        switch action {
        case .approve: "Approve"
        case .decline: "Decline"
        case .stop: "Stop it"
        case .resume: "Resume"
        case .again: "Give again…"
        case .ship: "Ship it…"
        }
    }

    static func symbol(_ action: TaskCard.Action) -> String {
        switch action {
        case .approve: "checkmark"
        case .decline: "xmark"
        case .stop: "stop"
        case .resume: "play"
        case .again: "arrow.clockwise"
        case .ship: "arrow.up.right.square"
        }
    }
}

/// The thread itself, as a page reads (I10: every screen to Home's bar): its title and who has it, how it stands in a
/// dot and a word; the brief; the work, folded; then what proves it, apart from the agent's words, which follow it,
/// labelled as its own; its conversation after. Hairlines between, no cards; one answer in full, the rest in its bar's
/// menu; its live line and message box at its foot.
private struct TaskThreadView: View {
    let session: Session
    let task: TeamTask
    @Bindable var thread: TaskThread
    @Bindable var answers: TaskAnswers
    var composing: FocusState<Bool>.Binding
    @State private var workedOpen = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var canAct: Bool { session.can("fleet:admin") && session.can("chat") }
    private var agent: Agent? { session.drawn(task.assignee) }
    private var name: String { agent?.name ?? session.team?.removed?.first { $0.id == task.assignee }?.name ?? task.assignee }

    var body: some View {
        let entries = thread.entries
        let groups = Steps.groups(entries)
        let running = task.status == "running"
        ScrollView {
            items(groups, running: running)
                .padding(.horizontal, Metrics.margin)
                .padding(.bottom, Space.s6)
                .readingWidth()
        }
        // From the top; while it works, the latest step kept in view as steps come.
        .defaultScrollAnchor(.top)
        .defaultScrollAnchor(running ? .bottom : .top, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .bottom) { foot(entries, running: running) }
        .modifier(ShipPrompt(task: $answers.shipping, room: thread.room, client: session.client))
        .modifier(AgainPrompt(task: $answers.againing, room: thread.room, client: session.client))
        // Ship it, from its notification: Face ID first (the owner's, as an approval's yes is), then its pull request.
        .task(id: session.shipToOpen) {
            guard session.shipToOpen == task.id else { return }
            session.shipToOpen = nil
            guard TaskCard.actions(task).contains(.ship) else { answers.trouble = "There's nothing of it to ship now: it was shipped already, or kept nothing."; return }
            if let why = await DeviceOwner.confirm("Ship “\(task.title)” as a pull request") { answers.trouble = why } else { answers.shipping = task }
        }
        .alert("That didn't go through", isPresented: .init(get: { answers.trouble != nil }, set: { if !$0 { answers.trouble = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(answers.trouble ?? "")
        }
    }

    /// The thread's parts, in the order they happened, a hairline between each.
    private func items(_ groups: [Steps.Group], running: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(running: running)
            Divider()
            brief
            Divider()
            if thread.read {
                work(groups, running: running)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, Space.s4)
            }
            // An outward step asks here, in place: its answer the one in full while it works.
            if running {
                ForEach(session.waiting.filter { Roster.agentOfCaller($0.by) == task.assignee }) { action in
                    Divider()
                    AskCard(session: session, action: action).padding(.horizontal, -Space.s4)
                }
            }
            callout
            if thread.read, task.status == "done" || task.status == "failed" {
                Divider()
                ProofSection(session: session, task: task, thread: thread, agent: agent, name: name, canAct: canAct, answers: answers)
            }
            // The agent's own words, after the proof and labelled as its own: never its bare claim of a verdict.
            if let said = TaskCard.saidBesideProof(TaskCard.end(task)?.said) {
                Divider()
                VStack(alignment: .leading, spacing: Space.s2) {
                    SectionHead("\(name) said")
                    MarkdownView(said).font(Typeset.body)
                }
                .padding(.vertical, Space.s4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("task.said")
            }
            let messages = thread.conversation(of: task)
            if !messages.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: Space.s3) {
                    ForEach(messages) { message in
                        ThreadMessage(message: message, speaker: Timeline.speaker(message, agents: session.team?.agents ?? []))
                    }
                }
                .padding(.vertical, Space.s4)
            }
        }
    }

    /// Its title in full (the bar says none of it), and who has it and how it stands: a dot and its word while it is in
    /// hand, when it ended once it has (its verdict is its proof's, below).
    private func header(running: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text(task.title)
                .font(Typeset.title)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("task.title")
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.s1)) : AnyLayout(HStackLayout(spacing: Space.s2))
            layout {
                HStack(spacing: 6) {
                    // Its agent's orb: moving while it works (the orb in focus), still otherwise.
                    AgentFace(id: task.assignee, profile: agent?.avatar, size: 20, mood: running ? .working : nil, key: "task:\(task.assignee)")
                    Text(name).fontWeight(.semibold).foregroundStyle(.primary)
                }
                standing(running: running)
                if let project = project { Text(project).lineLimit(typeSize.isAccessibilitySize ? nil : 1) }
            }
            .font(Typeset.detail)
            .foregroundStyle(.secondary)
        }
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s4)
        .accessibilityElement(children: .combine)
    }

    /// Its project's name, where it has one (never "Other work").
    private var project: String? {
        let project = session.attended?.byAttention.first { $0.id == task.id }?.project
        return project.flatMap { $0.key == Work.other.key ? nil : $0.name }
    }

    @ViewBuilder private func standing(running: Bool) -> some View {
        switch task.status {
        case "running":
            let since = Work.shortSpan(Date.now.timeIntervalSince1970 * 1000 - (task.createdAt ?? task.updatedAt))
            StateLabel(word: since == "now" ? "Just started" : "Working · \(since)", tone: .active)
        case "queued": StateLabel(word: "Queued", tone: .quiet)
        case "proposed": StateLabel(word: "Waits for your approval", tone: .active, strong: true)
        case "interrupted": StateLabel(word: "Interrupted", tone: .active, strong: true)
        case "stopped": StateLabel(word: "Stopped", tone: .quiet)
        default: Text("Ended \(Work.relativeTime(task.record?.endedAt ?? task.updatedAt))").monospacedDigit()
        }
    }

    /// What it was asked, who gave it and how; what waits on it.
    private var brief: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            SectionHead("The brief")
            Text(task.goal)
                .font(Typeset.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("The brief: \(task.goal)")
            dispatch
            facts
        }
        .padding(.vertical, Space.s4)
    }

    /// Its foot: the live line while it works, and its message box.
    private func foot(_ entries: [TrailEntry], running: Bool) -> some View {
        let stopping: (() -> Void)? = canAct ? { answers.run(.stop, task, session: session) } : nil
        return VStack(spacing: 0) {
            if running, let live = Steps.live(entries) { LiveLine(live: live, stop: stopping) }
            if canAct {
                if let hint = hint {
                    Text(hint).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Metrics.margin + Space.s4).padding(.top, Space.s1)
                }
                RoomComposer(room: thread.room, name: name, client: session.client, composing: composing, prompt: "Tell \(name)…")
            }
        }
    }

    /// What its message box says under it: when the agent reads what you tell it.
    private var hint: String? {
        switch task.status {
        case "running": "\(name) answers once this work ends"
        case "queued": "\(name) answers before starting on it"
        default: nil
        }
    }

    /// Who gave it, and how; and when.
    private var dispatch: some View {
        let proposer = task.proposedBy.map { by in session.drawn(by)?.name ?? (by == "primary" ? Primary.name : by) }
        let words: String = {
            if let proposedBy = task.proposedBy {
                return task.status == "proposed" ? "\(proposer ?? proposedBy) proposes it: it starts when you approve it." : "\(proposer ?? proposedBy) proposed it, and it was approved."
            }
            switch task.givenBy {
            case "primary": return "\(Primary.name) gave it to the agents, and \(name) took it as best suited."
            case "owner": return "You gave it to the agents, and \(name) took it as best suited."
            default: return "Given to \(name) by name."
            }
        }()
        return Text("\(words) \(Text(Work.relativeTime(task.createdAt ?? task.updatedAt)).foregroundStyle(.tertiary))")
            .font(Typeset.detail)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var facts: some View {
        let lines = [TaskCard.sensitive(task), TaskCard.stepped(task), task.fix.map { "It fixes the pull request on \($0.branch)" }].compactMap(\.self)
        if !lines.isEmpty { Text(lines.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
        let dependents = session.team?.tasks.filter { $0.dependsOn.contains(task.id) } ?? []
        if !dependents.isEmpty {
            Text("\(dependents.map { "“\($0.title)”" }.joined(separator: ", ")) \(dependents.count == 1 ? "waits" : "wait") on it.").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// The work: while it runs, the steps as they come; once it ended, folded ("Ada worked for 6m 12s ›").
    @ViewBuilder private func work(_ groups: [Steps.Group], running: Bool) -> some View {
        if !groups.isEmpty {
            if running {
                VStack(alignment: .leading, spacing: Space.s1) {
                    SectionHead("The work")
                    StepList(groups: groups)
                }
                .padding(.vertical, Space.s4)
            } else {
                let summary = Steps.summary(thread.entries, record: task.record.map { ($0.startedAt, $0.endedAt) })
                let words = Steps.summaryWords(summary)
                VStack(alignment: .leading, spacing: Space.s1) {
                    Button {
                        withAnimation(.snappy) { workedOpen.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).rotationEffect(.degrees(workedOpen ? 90 : 0))
                            // (Under half a second, no time: never "worked for 0s".)
                            Text("\(name) \(summary.ms >= 500 ? "worked for \(Steps.workedFor(summary.ms))" : "worked")\(Text(words.isEmpty ? "" : " · \(words)").foregroundStyle(.tertiary))")
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(Typeset.detail)
                        .foregroundStyle(.secondary)
                        .frame(minHeight: Metrics.touch)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(workedOpen ? "Shown" : "Folded")
                    if workedOpen { StepList(groups: groups).padding(.bottom, Space.s2) }
                }
                .padding(.vertical, Space.s1)
            }
        } else if running {
            Text("\(Text(name).fontWeight(.semibold).foregroundStyle(.primary)) is starting on it").font(Typeset.detail).foregroundStyle(.secondary).padding(.vertical, Space.s4)
        } else if task.status == "queued" {
            let waitsFor = task.dependsOn.compactMap { dep in session.team?.tasks.first { $0.id == dep } }.filter { !($0.status == "done" && $0.verified) }
            Text(waitsFor.isEmpty ? "Queued: \(name) starts on it next." : "Queued: it starts once \(waitsFor.map { "“\($0.title)”" }.joined(separator: " and ")) \(waitsFor.count == 1 ? "is" : "are") done and verified.")
                .font(Typeset.detail)
                .foregroundStyle(.secondary)
                .padding(.vertical, Space.s4)
        } else {
            Text("No steps were kept.").font(Typeset.detail).foregroundStyle(.tertiary).padding(.vertical, Space.s4)
        }
    }

    /// What only you can do with it now, before it ends (a proposal, work cut short or stopped): said, and its one answer
    /// in full; the rest of its answers are in the bar's menu.
    @ViewBuilder private var callout: some View {
        let answer = TaskCard.answers(task).prominent
        let words: String? = switch task.status {
        case "proposed": "\(task.proposedBy.flatMap { session.drawn($0)?.name } ?? name) proposes this. Nothing runs until you approve it."
        case "interrupted": "The node was cut off while this ran. Look at what it did, then resume it, or give it again."
        case "stopped": "Stopped before it was done."
        default: nil
        }
        if canAct, let words, let answer {
            Divider()
            VStack(alignment: .leading, spacing: Space.s3) {
                Text(words).font(Typeset.body).fixedSize(horizontal: false, vertical: true)
                NeedButton(title: TaskAnswers.title(answer), prominent: true, busy: answers.busy) { answers.run(answer, task, session: session) }
                    .accessibilityIdentifier("task.answer")
            }
            .padding(.vertical, Space.s4)
        }
    }
}

/// The work, folded: each group a line, what is in it a tap away.
private struct StepList: View {
    let groups: [Steps.Group]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(groups, id: \.from) { group in StepRow(group: group) }
        }
        .padding(.leading, 2)
    }
}

private struct StepRow: View {
    let group: Steps.Group
    @State private var open = false

    private var opens: Bool { !(group.items.isEmpty || (group.items.count == 1 && group.kind != .plan && group.kind != .review && group.kind != .gate)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                if opens { withAnimation(.snappy) { open.toggle() } }
            } label: {
                HStack(spacing: Space.s2) {
                    Image(systemName: symbol)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint)
                        .frame(width: 18)
                    Text(group.text).lineLimit(open ? nil : 1)
                    if opens {
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary).rotationEffect(.degrees(open ? 90 : 0))
                    }
                    Spacer(minLength: 0)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!opens)
            .accessibilityValue(opens ? (open ? "Shown" : "Folded") : "")
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                            Text(item.text)
                                .font(group.kind == .plan || group.kind == .review ? .caption : .caption.monospaced())
                                .textSelection(.enabled)
                            if let exit = item.exit, exit != 0 { Text("exit \(exit)").font(.caption.monospaced()).foregroundStyle(Color.failed) }
                        }
                        .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, Space.s3)
                .padding(.vertical, Space.s2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.fill.quinary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
                .padding(.leading, 26)
            }
        }
    }

    private var symbol: String {
        switch group.kind {
        case .gate: group.tone == .ok ? "checkmark" : "xmark"
        case .review: "person.badge.shield.checkmark"
        case .note: group.tone == .warn ? "exclamationmark.triangle" : "info.circle"
        case .plan: "list.bullet"
        case .edit: "pencil"
        case .read: "doc.text"
        case .submitted: "checkmark.shield"
        case .run: "apple.terminal"
        }
    }

    private var tint: Color {
        switch group.tone {
        case .ok: .done
        case .failed: .failed
        case .warn: .needs
        case .neutral: .secondary
        }
    }
}

/// The one live line while it works: what it runs now and since when, and Stop.
private struct LiveLine: View {
    let live: (text: String, command: Bool, since: Double)
    let stop: (() -> Void)?

    var body: some View {
        HStack(spacing: Space.s2) {
            LiveDot(color: .working)
            Group {
                if live.command {
                    Text("Running \(Text(live.text).font(.caption.monospaced()).foregroundStyle(.primary))")
                } else {
                    Text(live.text)
                }
            }
            .lineLimit(1)
            .truncationMode(.tail)
            // Its time since, a second at a time (only while it works).
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(Self.clock(context.date.timeIntervalSince1970 * 1000 - live.since)).monospacedDigit().foregroundStyle(.tertiary)
            }
            Spacer(minLength: Space.s2)
            if let stop {
                Button("Stop", action: stop).font(.footnote.weight(.semibold)).buttonStyle(.borderless).frame(minHeight: Metrics.touch)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, Metrics.margin + Space.s1)
        .accessibilityElement(children: .combine)
    }

    static func clock(_ ms: Double) -> String {
        let seconds = max(0, Int(ms / 1000))
        return "\(seconds / 60):\(seconds % 60 < 10 ? "0" : "")\(seconds % 60)"
    }
}

/// A word in a task's conversation: yours on the right in a bubble, an agent's or the primary's with its name.
private struct ThreadMessage: View {
    let message: TeamMessage
    let speaker: String

    var body: some View {
        let owner = message.speaker == "owner"
        VStack(alignment: owner ? .trailing : .leading, spacing: Space.s1) {
            Text("\(Text(owner ? "You" : speaker).fontWeight(.semibold).foregroundStyle(.primary)) \(Work.relativeTime(message.createdAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Group {
                if owner {
                    Text(message.text)
                        .padding(Metrics.bubblePadding)
                        .background(.fill.tertiary, in: .rect(cornerRadius: 14, style: .continuous))
                } else {
                    MarkdownView(message.text)
                }
            }
            .font(.callout)
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: owner ? .trailing : .leading)
    }
}

/// What proves it, apart from what the agent says: its verdict as its proof allows, what that rests on, each gate and how
/// it stood before the work, the reviewer, what it kept and cost, and its one answer in full. A section of the thread
/// with hairlines, no card: red only where it failed.
private struct ProofSection: View {
    let session: Session
    let task: TeamTask
    let thread: TaskThread
    let agent: Agent?
    let name: String
    let canAct: Bool
    @Bindable var answers: TaskAnswers
    @State private var reviewing = false

    var body: some View {
        let proof = Steps.proof(status: task.status, gates: task.gates ?? [], thread.entries)
        let verified = task.status == "done" && task.verified
        // The verdict as its proof allows: from its trail once read, from its record until then.
        let said = Steps.verdict(status: task.status, verified: task.verified, error: task.error, record: task.record, facts: thread.read ? Steps.facts(proof) : Steps.facts(record: task.record))
        let kind = said?.verdict
        let failed = kind == .failed || kind == .rejected || kind == .gaveUp
        let word = said?.word ?? (verified ? "Reviewed" : "Not verified")
        VStack(alignment: .leading, spacing: 0) {
            SectionHead("Proof").padding(.top, Space.s4).padding(.bottom, Space.s3)
            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                Image(systemName: kind == .proven ? "checkmark" : failed ? "xmark" : "minus")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(failed ? AnyShapeStyle(Color.white) : AnyShapeStyle(.background))
                    .frame(width: 22, height: 22)
                    .background(failed ? Color.danger : kind == .proven ? Color.primary : Color.secondary, in: .circle)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.line) {
                    Text(word).font(Typeset.row).foregroundStyle(failed ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.primary))
                    if let why = Self.why(kind, end: TaskCard.end(task), word: word) {
                        Text(why).font(Typeset.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.bottom, Space.s3)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("task.verdict")
            ForEach(caveats(proof, verified: verified), id: \.self) { line in
                Divider()
                Label(line, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).padding(.vertical, Space.s2)
            }
            if !proof.gates.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(proof.gates.enumerated()), id: \.offset) { _, gate in GateLine(gate: gate, running: task.status == "running", ended: true) }
                }
                .padding(.vertical, Space.s1)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Its gates")
            }
            if let review = proof.review {
                Divider()
                Label {
                    Text("\(Text(review.verdict == "pass" ? "The reviewer passed it" : "The reviewer sent it back").fontWeight(.semibold).foregroundStyle(.primary))\(review.notes.isEmpty ? "" : ": “\(review.notes.components(separatedBy: "\n")[0].prefix(200))”")")
                } icon: {
                    Image(systemName: "person.badge.shield.checkmark").foregroundStyle(.tertiary)
                }
                .font(Typeset.detail)
                .foregroundStyle(.secondary)
                .padding(.vertical, Space.s2)
            }
            Divider()
            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                changes
                Spacer(minLength: Space.s2)
                Text(session.prices != nil || task.record == nil ? Steps.costWords(budgetUsd: task.budgetUsd, record: task.record, prices: session.prices ?? [:]) : "")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .font(Typeset.detail)
            .frame(minHeight: Metrics.touch)
            if canAct, let answer = TaskCard.answers(task).prominent {
                NeedButton(title: TaskAnswers.title(answer), prominent: true, busy: answers.busy) { answers.run(answer, task, session: session) }
                    .padding(.top, Space.s2)
                    .padding(.bottom, Space.s4)
                    .accessibilityIdentifier("task.answer")
            }
            if let shipped = TaskCard.shipped(task), let url = URL(string: shipped.url) {
                Link(destination: url) { Label(shipped.text, systemImage: "arrow.up.right.square") }
                    .font(Typeset.detail.weight(.semibold))
                    .frame(minHeight: Metrics.touch)
            }
        }
        .sheet(isPresented: $reviewing) { WorkspaceView(session: session, id: task.assignee, name: name, startOn: .changes) }
    }

    /// What the verdict rests on, under its word, never that word again (TaskCard.because).
    private static func why(_ kind: Steps.Verdict?, end: (why: String?, said: String?)?, word: String) -> String? {
        switch kind {
        case .proven: "A gate that failed before the work passes now, and a reviewer that didn't write it passed it."
        case .reviewed: "The reviewer passed it; no gate shows the work was done."
        case .failed, .rejected, .gaveUp, .unverified: TaskCard.because(end?.why ?? "Its gates or the review did not pass.", verdict: word)
        case .stopped: TaskCard.because("It stopped where it was.", verdict: word)
        case nil: "It hasn't ended."
        }
    }

    private func caveats(_ proof: Steps.Proof, verified: Bool) -> [String] {
        [
            proof.sameModel ? "The review was by the same model that did the work: no other reviewer model could answer." : nil,
            proof.provesNothing ? (verified ? "Each gate passed before the work too, so none shows it was done: the reviewer decided alone." : "Each gate passes before any work, so none can show this work was done.") : nil,
            proof.gates.isEmpty && verified ? "No commands were given to prove it: the reviewer decided alone." : nil,
        ].compactMap(\.self)
    }

    @ViewBuilder private var changes: some View {
        let files = task.changes?.files ?? thread.changes?.files.count ?? 0
        let added = thread.changes?.files.reduce(0) { $0 + ($1.added ?? 0) }
        let removed = thread.changes?.files.reduce(0) { $0 + ($1.removed ?? 0) }
        if files > 0 {
            HStack(spacing: Space.s1) {
                if agent != nil, session.can("sandbox") {
                    Button {
                        reviewing = true
                    } label: {
                        Text("\(files) file\(files == 1 ? "" : "s") · Review \(Image(systemName: "chevron.right"))").fontWeight(.semibold)
                    }
                    .buttonStyle(.borderless)
                    .frame(minHeight: Metrics.touch)
                } else {
                    Text("\(files) file\(files == 1 ? "" : "s") kept")
                }
                // A diff's sums by their signs, in the page's greys (no green, no red: nothing here went wrong).
                if let added, let removed { Text("+\(added) −\(removed)").monospacedDigit().foregroundStyle(.secondary) }
            }
        } else {
            Text("No changes kept").foregroundStyle(.secondary)
        }
    }
}

/// Give again, once you say so (as Android's thread asks, and as the PWA's opens the task to give in its sheet): it starts
/// the same task once more, to the same agent with the same gates, and that is a run of its own, so a single tap never
/// starts it.
private struct AgainPrompt: ViewModifier {
    @Binding var task: TeamTask?
    let room: AgentRoom
    let client: NodeClient

    func body(content: Content) -> some View {
        content
            .alert("Give it again?", isPresented: .init(get: { task != nil }, set: { if !$0 { task = nil } }), presenting: task) { task in
                Button("Give it again") { Task { await room.giveAgain(task, with: client) } }
                Button("Cancel", role: .cancel) {}
            } message: { task in
                Text("“\(task.title)”, to the same agent, with the same gates.")
            }
    }
}

/// A gate as its latest round left it: its command in mono, and how it ended (its exit, time and what it printed), or
/// running, next, not run.
private struct GateLine: View {
    let gate: Steps.GateRow
    let running: Bool
    /// In the proof card (how it exited, in how long, what it printed, and how it stood before the work, on a line of its
    /// own so none of it is cut), or in the details (its time alone).
    var ended = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the accessibility sizes each part is a line of its own, and none is cut.
        let large = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: Space.line) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Image(systemName: symbol)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tint)
                    .frame(width: 16)
                    .accessibilityLabel(gate.state.rawValue)
                Text(gate.command).font(.caption.monospaced()).lineLimit(large ? 4 : 1).truncationMode(.middle).foregroundStyle(.primary)
                Spacer(minLength: Space.s2)
                if !large, !ended || gate.state == .running || gate.state == .waiting {
                    Text(said).font(.caption).monospacedDigit().lineLimit(1).fixedSize().foregroundStyle(.tertiary)
                }
            }
            if large, !ended || gate.state == .running || gate.state == .waiting {
                Text(said).font(.caption).monospacedDigit().foregroundStyle(.tertiary).padding(.leading, 16 + Space.s2)
            }
            if ended, gate.state == .passed || gate.state == .failed {
                let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.line)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: Space.s1))
                layout {
                    // Its exit and time are never cut; what it printed is, at the end.
                    Text([gate.exit.map { "exit \($0)" }, gate.ms.map(Self.took)].compactMap(\.self).joined(separator: " · "))
                        .fixedSize(horizontal: !large, vertical: false)
                        .foregroundStyle(gate.state == .failed ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.secondary))
                    if let before = beforeWords {
                        Text("\(large ? "" : "· ")\(before)").fixedSize(horizontal: !large, vertical: false).foregroundStyle(gate.before != 0 && gate.exit == 0 ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                    }
                    if !gate.said.isEmpty {
                        Text("\(large ? "" : "· ")\(gate.said)").lineLimit(large ? 3 : 1).truncationMode(.tail).foregroundStyle(.tertiary)
                    }
                }
                .font(.caption)
                .monospacedDigit()
                .padding(.leading, 16 + Space.s2)
            }
        }
        .padding(.vertical, ended ? Space.s1 : 0)
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
    }

    /// How it stood before the work: failed then and passes now (it shows the work was done), or passed then too.
    private var beforeWords: String? {
        guard let before = gate.before else { return nil }
        if before == 0 { return "passed before the work too" }
        return gate.exit == 0 ? "failed before the work" : "failed before the work too"
    }

    /// How long a gate took, to the precision it needs: "340 ms", "4.2 s", "2m 05s". Never "0:00".
    static func took(_ ms: Double) -> String {
        if ms < 1_000 { return "\(Int(ms.rounded())) ms" }
        if ms < 60_000 { return String(format: "%.1f s", ms / 1_000) }
        return Steps.workedFor(ms)
    }

    private var said: String {
        switch gate.state {
        case .running: return "running"
        case .waiting: return running ? "next" : "not run"
        case .passed, .failed: return gate.ms.map(Self.took) ?? "exit \(gate.exit ?? 0)"
        }
    }

    private var symbol: String {
        switch gate.state {
        case .passed: "checkmark"
        case .failed: "xmark"
        case .running: "play.fill"
        case .waiting: "clock"
        }
    }

    private var tint: Color {
        switch gate.state {
        case .passed: .primary
        case .failed: .danger
        case .running: .primary
        case .waiting: .secondary
        }
    }
}

/// A task's details (the PWA's thread details): the agent's VM (Peek, Terminal), where its work began, its changes; its
/// gates as they run and the reviewer; its cost against its budget, what waits on it, and where its work goes.
struct TaskDetails: View {
    let session: Session
    let task: TeamTask
    let thread: TaskThread
    @State private var peeking = false
    @State private var inTerminal = false
    @State private var reviewing = false

    var body: some View {
        let agent = session.drawn(task.assignee)
        let name = agent?.name ?? task.assignee
        let proof = Steps.proof(status: task.status, gates: task.gates ?? [], thread.entries)
        let vm = agent?.workspace
        VStack(alignment: .leading, spacing: 0) {
            section {
                row("desktopcomputer") {
                    if let vm {
                        Text("\(name)'s VM \(Text("on \(vm.node == session.whoami?.node ? "this node" : session.nodeName(of: vm.node))").foregroundStyle(.secondary))")
                    } else {
                        Text("\(name) has no VM yet").foregroundStyle(.secondary)
                    }
                }
                if vm != nil, let agent, session.can("sandbox") {
                        // Its desktop to watch and take over, and its terminal: under it, so neither is squeezed.
                        HStack(spacing: Space.s2) {
                            NeedButton(title: "Peek") { peeking = true }.help("Its desktop, to watch and take over").fixedSize()
                            if vm?.node == session.whoami?.node { NeedButton(title: "Terminal") { inTerminal = true }.fixedSize() }
                        }
                        .padding(.leading, 28)
                        // (Over the thread, its own: the details may be a column with nothing to push onto.)
                        .cover(isPresented: $peeking) {
                            NavigationStack {
                                AgentScreenView(session: session, agent: VMSeat(agent))
                                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { peeking = false } } }
                            }
                        }
                        .cover(isPresented: $inTerminal) { AgentTerminalView(session: session, agent: VMSeat(agent)) }
                }
                row("chevron.left.forwardslash.chevron.right") {
                    if let fix = task.fix {
                        Text(fix.branch).font(.footnote.monospaced())
                    } else if let base = task.changes?.base {
                        Text("from \(base.prefix(10))").font(.footnote.monospaced())
                    } else {
                        Text(agent?.repository != nil ? "its repository, as fetched" : "no repository").foregroundStyle(.secondary)
                    }
                }
                let files = thread.changes?.files.count ?? task.changes?.files
                row("doc") {
                    if let files {
                        Text("Changes · \(files) file\(files == 1 ? "" : "s")")
                    } else {
                        Text(task.status == "running" ? "Changes as it works" : "No changes kept").foregroundStyle(.secondary)
                    }
                } end: {
                    if let changes = thread.changes, let files, files > 0 {
                        let added = changes.files.reduce(0) { $0 + ($1.added ?? 0) }, removed = changes.files.reduce(0) { $0 + ($1.removed ?? 0) }
                        Button {
                            reviewing = true
                        } label: {
                            Text("+\(added) −\(removed) \(Image(systemName: "chevron.right"))").monospacedDigit().foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Review its changes: \(added) lines added, \(removed) removed")
                    }
                }
            }
            Divider()
            section {
                HStack(alignment: .firstTextBaseline) {
                    Text(proof.gates.isEmpty ? "No gates" : "Gates · \(proof.passed) of \(proof.gates.count) passed").monospacedDigit()
                    Spacer(minLength: Space.s2)
                    Text("Reviewer \(reviewerWords(proof.reviewer))")
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, Space.s1)
                ForEach(Array(proof.gates.enumerated()), id: \.offset) { _, gate in GateLine(gate: gate, running: task.status == "running") }
                if proof.gates.isEmpty {
                    Text("No commands were given to prove it: the independent reviewer decides alone.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Divider()
            section {
                HStack(alignment: .firstTextBaseline) {
                    Text("This task")
                    Spacer(minLength: Space.s2)
                    let words = session.prices != nil || task.record == nil ? Steps.costWords(budgetUsd: task.budgetUsd, record: task.record, prices: session.prices ?? [:]) : ""
                    Text(words.isEmpty ? "no budget" : words).monospacedDigit()
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, Space.s1)
                ForEach(session.team?.tasks.filter { $0.dependsOn.contains(task.id) } ?? [], id: \.id) { other in
                    HStack(spacing: Space.s2) {
                        AgentFace(id: other.assignee, profile: session.drawn(other.assignee)?.avatar, size: 16)
                        Text("“\(other.title)” waits on it").lineLimit(1)
                        Spacer(minLength: Space.s2)
                        Text(other.status).foregroundStyle(.secondary)
                    }
                    .font(.footnote)
                    .frame(minHeight: 28)
                }
                row("arrow.up.right.square") { Text(shipWords(agent)) } end: {
                    if let shipped = task.shipped, let url = URL(string: shipped.url) { Link("Open", destination: url).font(.footnote.weight(.semibold)) }
                }
            }
        }
        .padding(.horizontal, Space.s4)
        .sheet(isPresented: $reviewing) { WorkspaceView(session: session, id: task.assignee, name: name, startOn: .changes) }
    }

    private func section(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Space.s1) { content() }.padding(.vertical, Space.s3)
    }

    private func row(_ symbol: String, @ViewBuilder _ value: () -> some View, @ViewBuilder end: () -> some View = { EmptyView() }) -> some View {
        HStack(spacing: Space.s2) {
            Image(systemName: symbol).font(.footnote).foregroundStyle(.secondary).frame(width: 20)
            value().font(.subheadline).lineLimit(1)
            Spacer(minLength: Space.s2)
            end()
        }
        .frame(minHeight: 32)
    }

    private func reviewerWords(_ state: String) -> String {
        switch state {
        case "passed": "passed it"
        case "sent back": "sent it back"
        case "reading": "is reading it"
        case "waits": "waits for the gates"
        default: "not reached"
        }
    }

    private func shipWords(_ agent: Agent?) -> String {
        if let shipped = task.shipped { return shipped.pr.map { "Pull request #\($0)" } ?? "Shipped" }
        if task.status == "done", task.verified, task.changes != nil, task.fix == nil { return "Ready to ship" }
        if let fix = task.fix { return "Onto \(fix.branch) when verified" }
        return task.changes != nil || agent?.repository != nil ? "Ship it when verified" : "Nothing to ship: no repository"
    }
}
