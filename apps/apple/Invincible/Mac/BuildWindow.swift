#if os(macOS)
import SwiftUI

/*
 * The Build window (docs/BUILD.md): T3 Code's workbench, with the primary. Your projects down the side, each with its
 * threads (its chats in it); the thread in the middle, its work in it shown as it does it; beside it what changed in the
 * project's checkout on its computer since its last commit, and its files; under it, a terminal there. Its bar has the
 * branch the checkout is on (switched to or started from there), a Commit for what changed, and the model it answers
 * with. It works; you review, then commit, or ask for more.
 */

/// What the Build window shows: a project's thread, or a new one in it.
enum BuildSelection: Hashable {
    case thread(String)
    case new(String)
}

@MainActor @Observable final class BuildModel {
    let session: Session
    private(set) var projects: [ProjectView] = []
    private(set) var threads: [ConversationSummary] = []
    private(set) var loaded = false
    private(set) var problem: String?
    var selection: BuildSelection? {
        didSet { if selection != oldValue, !adopting { chose() } }
    }
    /// A new thread the node has just kept, taken as the one chosen without opening it again.
    private var adopting = false
    private(set) var chat = ChatModel()
    /// The chat on screen's identity: a new one each time another thread is chosen.
    private(set) var chatID = UUID()
    private(set) var git: ProjectGitView?
    private(set) var gitProblem: String?
    /// The node said the primary has no computer yet: where it works on your projects, made from here.
    private(set) var noComputer = false
    /// A git action under way.
    private(set) var acting = false
    /// Counted up after each answer and action: the changes beside the thread are read again.
    private(set) var looked = 0
    /// The roster's models, the primary's own role's first: what a thread may answer with.
    private(set) var models: [String] = []
    var reviewShown = true
    var terminalShown = false

    init(session: Session) { self.session = session }

    /// The project the chosen thread is in.
    var project: ProjectView? {
        switch selection {
        case .new(let id): return projects.first { $0.id == id }
        case .thread(let id): return threads.first { $0.id == id }?.project.flatMap { project in projects.first { $0.id == project } }
        case nil: return nil
        }
    }

    /// Where the project's work is kept on its computer.
    var checkout: String? { project.map { $0.checkout ?? "/work/projects/\($0.id)" } }

    func threads(in project: ProjectView) -> [ConversationSummary] {
        threads.filter { $0.project == project.id }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func load() async {
        struct Projects: Decodable { let projects: [ProjectView] }
        struct Conversations: Decodable { let conversations: [ConversationSummary] }
        do {
            async let listed = session.client.get("/api/projects", as: Projects.self)
            async let kept = session.client.get("/api/conversations", as: Conversations.self)
            projects = try await listed.projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            threads = try await kept.conversations
            problem = nil
        } catch {
            problem = "Your projects couldn't be read: \(error.localizedDescription)"
        }
        loaded = true
        if selection == nil, let first = projects.first {
            selection = threads(in: first).first.map { .thread($0.id) } ?? .new(first.id)
        }
        if models.isEmpty, let roles = await session.roles() {
            let ordered = (roles["planner"]?.models ?? []) + roles.keys.sorted().flatMap { roles[$0]?.models ?? [] }
            var seen = Set<String>()
            models = ordered.filter { seen.insert($0).inserted }
        }
    }

    /// Another thread chosen: its chat, its project's checkout as it stands.
    private func chose() {
        let next = ChatModel()
        next.model = chat.model
        switch selection {
        case .new(let id):
            next.startNew()
            next.project = id
        case .thread(let id):
            next.project = threads.first { $0.id == id }?.project
            Task { await next.open(id, with: session.client) }
        case nil:
            next.startNew()
        }
        chat = next
        chatID = UUID()
        git = nil
        Task { await refresh() }
    }

    /// An answer ended: the thread it made or moved, and the checkout as it left it.
    func answered() async {
        await load()
        if case .new = selection, let id = chat.conversation {
            adopting = true
            selection = .thread(id)
            adopting = false
        }
        await refresh()
    }

    func refresh() async {
        guard let project else { return }
        struct Ask: Encodable { let id: String }
        do {
            git = try await session.client.post("/api/projects/git", Ask(id: project.id), as: ProjectGitView.self)
            gitProblem = nil
            noComputer = false
        } catch let error as NodeError {
            gitProblem = error.localizedDescription
            noComputer = error.status == 424
        } catch {
            gitProblem = error.localizedDescription
        }
        looked += 1
    }

    /// Its computer, made (as the web app's Computer page makes it: a VM of its own, with a desktop): nil when made, else why not.
    func makeComputer() async -> String? {
        struct Make: Encodable { let id: String }
        acting = true
        defer { acting = false }
        do {
            _ = try await session.client.post("/api/team/provision", Make(id: "primary"), as: JSONValue.self)
            await session.refresh()
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Switch the checkout to a branch, or start one: nil when done, else why not.
    func branch(_ name: String, create: Bool) async -> String? {
        struct Ask: Encodable { let id: String; let branch: String; let create: Bool }
        guard let project else { return nil }
        return await act { try await self.session.client.post("/api/projects/branch", Ask(id: project.id, branch: name, create: create), as: ProjectGitView.self) }
    }

    /// Commit everything changed: nil when done, else why not.
    func commit(_ message: String) async -> String? {
        struct Ask: Encodable { let id: String; let message: String }
        guard let project else { return nil }
        return await act { try await self.session.client.post("/api/projects/commit", Ask(id: project.id, message: message), as: ProjectGitView.self) }
    }

    /// Clone the project's repository into its checkout, the first time.
    func setUp() async -> String? {
        struct Ask: Encodable { let id: String }
        guard let project else { return nil }
        return await act { try await self.session.client.post("/api/projects/clone", Ask(id: project.id), as: ProjectGitView.self) }
    }

    private func act(_ work: () async throws -> ProjectGitView) async -> String? {
        acting = true
        defer { acting = false }
        do {
            git = try await work()
            gitProblem = nil
            looked += 1
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// A new project, chosen with a new thread in it: nil when made, else why not.
    func make(name: String, repo: String, instructions: String) async -> String? {
        struct Project: Encodable { let id: String; let name: String; let repo: String?; let instructions: String? }
        struct Made: Decodable { let project: ProjectView }
        let id = Self.id(for: name, taken: Set(projects.map(\.id)))
        let address = repo.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let made = try await session.client.post("/api/projects", Project(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), repo: address.isEmpty ? nil : address, instructions: words.isEmpty ? nil : words), as: Made.self).project
            await load()
            selection = .new(made.id)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// A project's id from its name (core's ProjectId: lowercase letters, digits and -, up to 40), not one taken.
    static func id(for name: String, taken: Set<String>) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        var id = String(folded.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        while id.contains("--") { id = id.replacingOccurrences(of: "--", with: "-") }
        id = id.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        id = String(id.prefix(36)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if id.isEmpty { id = "project" }
        var candidate = id
        var n = 2
        while taken.contains(candidate) {
            candidate = "\(id)-\(n)"
            n += 1
        }
        return candidate
    }
}

/// The Build window: projects and their threads, the thread, what changed beside it, a terminal under it.
struct BuildWindow: View {
    @State private var model: BuildModel
    @State private var making = false
    @State private var committing = false
    @State private var branching = false
    @State private var problem: String?

    init(session: Session) { _model = State(initialValue: BuildModel(session: session)) }

    var body: some View {
        NavigationSplitView {
            BuildSidebar(model: model, making: $making)
                .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 400)
        } detail: {
            detail
        }
        .sheet(isPresented: $making) { NewProjectSheet(model: model) }
        .sheet(isPresented: $committing) { CommitSheet(model: model) }
        .sheet(isPresented: $branching) { BranchSheet(model: model) }
        .alert("Couldn't do that", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
        .task { await model.load() }
        // Its answer ended: the thread list, and the checkout as it left it.
        .onChange(of: model.chat.answering) { was, now in
            if was, !now { Task { await model.answered() } }
        }
    }

    @ViewBuilder private var detail: some View {
        if let project = model.project {
            VStack(spacing: 0) {
                if model.noComputer { computerBanner }
                workbench(project)
            }
            .toolbar { toolbar(project) }
        } else if model.loaded {
            ContentUnavailableView {
                Label("Build with \(Primary.name)", systemImage: "hammer")
            } description: {
                Text(model.problem ?? "A project is a repository it works on in its computer, one thread for each piece of work. You read what it changed, then commit it.")
            } actions: {
                Button("New Project…") { making = true }.buttonStyle(.borderedProminent)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Where its work in a project happens, not there yet: said, and made from here.
    private var computerBanner: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "desktopcomputer").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Space.line) {
                Text("\(Primary.name) has no computer yet").font(.headline)
                Text("Its own VM on your node, kept between conversations: each project's checkout lives there, with a terminal and a desktop. \(ComputerStart.words(desktop: true)); it grows as the work needs.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: Space.s3)
            Button("Make Its Computer") { Task { problem = await model.makeComputer() } }
                .buttonStyle(.borderedProminent)
                .disabled(model.acting)
        }
        .padding(Space.s4)
        .background(.fill.quaternary)
    }

    @ViewBuilder private func workbench(_ project: ProjectView) -> some View {
            VSplitView {
                HSplitView {
                    ChatView(session: model.session, chat: model.chat)
                        .id(model.chatID)
                        .environment(\.buildThread, BuildThread(project: project.name, branch: model.git?.branch))
                        .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                    if model.reviewShown {
                        WorkspaceView(session: model.session, id: "primary", name: Primary.name, root: model.checkout ?? "/work", refresh: model.looked, startOn: .changes)
                            .id(project.id)
                            .environment(\.workspaceColumn, $model.reviewShown)
                            .frame(minWidth: 300, idealWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                if model.terminalShown {
                    if let computer = model.session.team?.computer, let sandbox = VMSeat(computer: computer).sandbox {
                        BuildTerminal(session: model.session, sandbox: sandbox, startIn: model.checkout)
                            .id(project.id)
                            .frame(minHeight: 120, idealHeight: 260, maxHeight: .infinity)
                    } else {
                        Text("\(Primary.name) has no computer yet: Make Its Computer, above.").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 80)
                    }
                }
            }
    }

    @ToolbarContentBuilder private func toolbar(_ project: ProjectView) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) { branchMenu(project) }
        ToolbarItemGroup(placement: .primaryAction) {
            modelMenu
            Button {
                committing = true
            } label: {
                Label(model.git.map { $0.changed > 0 ? "Commit \($0.changed)" : "Commit" } ?? "Commit", systemImage: "checkmark.circle")
                    .labelStyle(.titleAndIcon)
            }
            .help("Commit what changed in the checkout")
            .disabled(model.git?.state != "ready" || (model.git?.changed ?? 0) == 0 || model.acting)
            Toggle(isOn: $model.reviewShown) { Label("Changes", systemImage: "sidebar.right") }
                .help("What changed, and the files (⌘D)")
                .keyboardShortcut("d")
            Toggle(isOn: $model.terminalShown) { Label("Terminal", systemImage: "apple.terminal") }
                .help("A terminal in the checkout (⌘J)")
                .keyboardShortcut("j")
            Button {
                Task { await model.refresh() }
            } label: {
                Label("Look Again", systemImage: "arrow.clockwise")
            }
            .help("Read the checkout again (⌘R)")
            .keyboardShortcut("r")
        }
    }

    /// The branch the checkout is on, to switch or start one; a checkout not there yet, to set up.
    private func branchMenu(_ project: ProjectView) -> some View {
        Menu {
            if let git = model.git, git.state == "ready" {
                ForEach(git.branches, id: \.self) { name in
                    Button {
                        Task { problem = await model.branch(name, create: false) }
                    } label: {
                        if name == git.branch { Label(name, systemImage: "checkmark") } else { Text(name) }
                    }
                }
                Divider()
                Button("New Branch…") { branching = true }
            } else if model.git?.state == "missing" {
                Button("Set Up Checkout") { Task { problem = await model.setUp() } }
                    .disabled(project.repo == nil)
                if project.repo == nil { Text("No repository: ask \(Primary.name) to start it") }
            } else if model.git?.state == "not-a-repository" {
                Text("\(model.checkout ?? "") isn't a git repository")
            } else {
                Text(model.gitProblem ?? "Reading the checkout…")
            }
        } label: {
            Label(branchWords, systemImage: "arrow.triangle.branch")
                .labelStyle(.titleAndIcon)
        }
        .help(model.checkout ?? "")
        .disabled(model.acting)
    }

    private var branchWords: String {
        guard let git = model.git else { return model.noComputer ? "No computer" : model.gitProblem == nil ? "…" : "Can't read it" }
        switch git.state {
        case "ready": return git.branch ?? "No branch"
        case "missing": return "Not set up"
        default: return "Not a repository"
        }
    }

    /// The model this thread answers with: its usual (the planner role's, first to last), or one of the roster's.
    private var modelMenu: some View {
        Menu {
            Button {
                model.chat.model = nil
            } label: {
                if model.chat.model == nil { Label("Its Usual", systemImage: "checkmark") } else { Text("Its Usual") }
            }
            if !model.models.isEmpty { Divider() }
            ForEach(model.models, id: \.self) { ref in
                Button {
                    model.chat.model = ref
                } label: {
                    if model.chat.model == ref { Label(ref, systemImage: "checkmark") } else { Text(ref) }
                }
            }
        } label: {
            Label(model.chat.model ?? "Its Usual", systemImage: "cpu")
                .labelStyle(.titleAndIcon)
        }
        .help("The model it answers with in this thread")
    }
}

/// Your projects, each with its threads, the latest first, and a new one.
private struct BuildSidebar: View {
    @Bindable var model: BuildModel
    @Binding var making: Bool

    var body: some View {
        List(selection: $model.selection) {
            ForEach(model.projects) { project in
                Section {
                    ForEach(model.threads(in: project)) { thread in
                        BuildThreadRow(thread: thread).tag(BuildSelection.thread(thread.id))
                    }
                    Label("New Thread", systemImage: "square.and.pencil")
                        .foregroundStyle(.secondary)
                        .tag(BuildSelection.new(project.id))
                } header: {
                    Text(project.name)
                }
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if model.loaded, model.projects.isEmpty {
                ContentUnavailableView("No projects yet", systemImage: "folder", description: Text("New Project starts one."))
            }
        }
        .toolbar {
            ToolbarItem {
                Button { making = true } label: { Label("New Project", systemImage: "folder.badge.plus") }
                    .help("A new project: a repository it works on")
            }
        }
    }
}

/// A thread in the sidebar: its title, and what it is at.
private struct BuildThreadRow: View {
    let thread: ConversationSummary

    var body: some View {
        VStack(alignment: .leading, spacing: Space.line) {
            Text(thread.title).lineLimit(1)
            Text(state)
                .font(.caption)
                .foregroundStyle(thread.needs != nil ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.secondary))
                .lineLimit(1)
        }
        .padding(.vertical, Space.line)
    }

    private var state: String {
        if let needs = thread.needs, needs.approvals + needs.keys > 0 || needs.question { return "Needs you" }
        switch thread.state {
        case "working": return "Working"
        case "queued": return "Queued"
        case "failed": return "Failed"
        case "stopped": return "Stopped"
        default: return Date(timeIntervalSince1970: thread.updatedAt / 1000).formatted(.relative(presentation: .named))
        }
    }
}

/// A terminal in its computer, under the thread, started in the project's checkout.
private struct BuildTerminal: View {
    let session: Session
    @State private var terminal: AgentTerminal
    @State private var bridge: TerminalBridge

    init(session: Session, sandbox: String, startIn: String?) {
        self.session = session
        _terminal = State(initialValue: AgentTerminal(sandbox: sandbox, startIn: startIn))
        _bridge = State(initialValue: TerminalBridge(origin: session.node.origin))
    }

    var body: some View {
        VStack(spacing: 0) {
            TerminalScreen(bridge: bridge)
                .background(Color(red: 6 / 255, green: 6 / 255, blue: 7 / 255))
            if !terminal.status.isEmpty {
                Text(terminal.status).font(.caption).foregroundStyle(.secondary).padding(Space.s1)
            }
        }
        .task { await terminal.run(with: session.client, on: bridge) }
    }
}

/// A new project: its name, its repository (cloned into its checkout on its computer), and its instructions for it.
private struct NewProjectSheet: View {
    let model: BuildModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var repo = ""
    @State private var instructions = ""
    @State private var problem: String?
    @State private var making = false

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("The site"))
                TextField("Repository", text: $repo, prompt: Text("https://github.com/you/site"))
            } footer: {
                Text("It works on its checkout in its computer, \(name.isEmpty ? "/work/projects/…" : "/work/projects/\(BuildModel.id(for: name, taken: Set(model.projects.map(\.id))))"). With no repository, it starts it there.")
            }
            Section("Its instructions for it") {
                TextField("Instructions", text: $instructions, prompt: Text("How you like it built, what to leave alone, how to test it"), axis: .vertical)
                    .lineLimit(4...10)
            }
            if let problem { Text(problem).foregroundStyle(Color.danger) }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Make Project") {
                    making = true
                    Task {
                        problem = await model.make(name: name, repo: repo, instructions: instructions)
                        making = false
                        if problem == nil { dismiss() }
                    }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || making)
            }
        }
    }
}

/// What changed, committed with a message of yours.
private struct CommitSheet: View {
    let model: BuildModel
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var problem: String?

    var body: some View {
        Form {
            Section {
                TextField("Message", text: $message, prompt: Text("What this change does"), axis: .vertical)
                    .lineLimit(2...8)
            } header: {
                Text("Commit \(model.git?.changed ?? 0) changed on \(model.git?.branch ?? "this branch")")
            } footer: {
                Text("Everything changed or new in \(model.checkout ?? "the checkout"): read it under Changes first.")
            }
            if let problem { Text(problem).foregroundStyle(Color.danger) }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Commit") {
                    Task {
                        problem = await model.commit(message.trimmingCharacters(in: .whitespacesAndNewlines))
                        if problem == nil { dismiss() }
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.acting)
            }
        }
    }
}

/// A new branch, started where the checkout stands.
private struct BranchSheet: View {
    let model: BuildModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var problem: String?

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("fix/login-redirect"))
            } footer: {
                Text("Started from \(model.git?.branch ?? "where it stands"), with what isn't committed carried over.")
            }
            if let problem { Text(problem).foregroundStyle(Color.danger) }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Start Branch") {
                    Task {
                        problem = await model.branch(name.trimmingCharacters(in: .whitespaces), create: true)
                        if problem == nil { dismiss() }
                    }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || model.acting)
            }
        }
    }
}

/// The Build window's root: the window, once this Mac is paired.
struct MacBuildRoot: View {
    let mac: MacApp

    var body: some View {
        Group {
            if let session = mac.session {
                BuildWindow(session: session)
            } else {
                ContentUnavailableView("Not in a fleet", systemImage: "person.2.slash", description: Text("Join your fleet in Invincible's window first."))
            }
        }
        .frame(minWidth: 900, minHeight: 560)
        .tint(.ink)
    }
}
#endif
