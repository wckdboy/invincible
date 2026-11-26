import SwiftUI

/// An agent's workspace (its VM's /work, or the primary's computer's), read: its files to browse and open, and what its
/// task changed (`POST /api/team/files`, `/file`, `/changes`; the terminal's `invincible agents files|read|changes`).
/// Beside its conversation on an iPad or a Mac (an inspector), a sheet on an iPhone. Nothing here writes to it.
struct WorkspaceView: View {
    let session: Session
    let id: String
    let name: String
    /// Where it starts: its /work, or a project's checkout (the Build view's), whose changes are that repository's own.
    var root = "/work"
    /// Changed when what it shows may have (an answer ended, a commit): its changes are read again, where you are kept.
    var refresh = 0
    @State private var shown: Shown
    /// Where you are in it, over its top (a folder, a file, a diff): its own stack, never the page's, so in a column
    /// beside a conversation it moves within the column.
    @State private var path: [WorkspaceItem] = []
    @Environment(\.dismiss) private var dismiss
    /// Hosted as a column beside the page: its page's button closes it, so it has no Done of its own.
    @Environment(\.workspaceColumn) private var column

    enum Shown: String, CaseIterable { case files = "Files", changes = "Changes" }

    /// `startOn`: Files, or Changes (the Build window's: what it changed comes first there).
    init(session: Session, id: String, name: String, root: String = "/work", refresh: Int = 0, startOn: Shown = .files) {
        self.session = session
        self.id = id
        self.name = name
        self.root = root
        self.refresh = refresh
        _shown = State(initialValue: startOn)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s2)
            Divider()
            Group {
                switch path.last {
                case .folder(let at): FolderView(session: session, id: id, path: at, open: open)
                case .file(let at): WorkspaceFile(session: session, id: id, path: at)
                case .diff(_, let text): CodeLines(text: text, lang: "diff")
                case nil:
                    switch shown {
                    case .files: FolderView(session: session, id: id, path: root, open: open)
                    case .changes: ChangesView(session: session, id: id, path: root == "/work" ? nil : root, refresh: refresh, open: open)
                    }
                }
            }
            // Each page its own: a folder opened after another reads its own entries.
            .id(path.last)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityLabel("\(name)'s workspace")
    }

    private func open(_ item: WorkspaceItem) { path.append(item) }

    @ViewBuilder private var header: some View {
        HStack(spacing: Space.s2) {
            if let top = path.last {
                Button { path.removeLast() } label: { Label("Back", systemImage: "chevron.backward").labelStyle(.iconOnly).frame(width: 32, height: 32) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("[", modifiers: .command)
                Text(top.title).font(.headline).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: Space.s2)
            } else {
                Picker("Show", selection: $shown) {
                    ForEach(Shown.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                Spacer(minLength: Space.s2)
            }
            if column == nil { Button("Done") { dismiss() }.fontWeight(.semibold) }
        }
        .frame(minHeight: 36)
    }
}

/// Where a workspace's pages go: a folder, a file, or a diff (one file's part, or all of it).
enum WorkspaceItem: Hashable {
    case folder(String)
    case file(String)
    case diff(title: String, text: String)

    var title: String {
        switch self {
        case .folder(let path), .file(let path): String(path.split(separator: "/").last ?? "Workspace")
        case .diff(let title, _): title
        }
    }
}

/// A chat as a thread of a project in the Build window (docs/BUILD.md): its project's name, and the branch it works on.
struct BuildThread: Equatable {
    let project: String
    let branch: String?
}

extension EnvironmentValues {
    /// Set by the Build window: the chat there is a project's thread, which the window titles and has the tools of.
    @Entry var buildThread: BuildThread? = nil
    /// The workspace column beside this page, when what holds the page hosts one (an iPad's or a Mac's split view, a
    /// Mac's window): shown or not. Absent (an iPhone): a page shows its workspace as a sheet of its own.
    @Entry var workspaceColumn: Binding<Bool>? = nil
}

extension View {
    /// The workspace column beside the pages of a navigation stack, hosted outside the stack, as an inspector belongs:
    /// inside the stack it took a page's own bar away on an iPad and kept a page from being pushed on an iPhone (iOS 27).
    /// `seat`: whose workspace, for the page shown (none: no column).
    func workspaceColumn(session: Session, seat: WorkspaceSeat?) -> some View {
        modifier(WorkspaceColumn(session: session, seat: seat))
    }
}

/// Whose workspace a page can show beside it: an agent's, or the primary's computer's (`primary`).
struct WorkspaceSeat: Equatable {
    let id: String
    let name: String
}

extension Place {
    /// The workspace beside this place: an agent's, or its computer's beside the primary's chat.
    @MainActor func workspaceSeat(_ session: Session) -> WorkspaceSeat? {
        switch self {
        case .agent(let id): WorkspaceSeat(id: id, name: session.agent(id)?.name ?? id)
        case .primary: WorkspaceSeat(id: "primary", name: Primary.name)
        default: nil
        }
    }
}

private struct WorkspaceColumn: ViewModifier {
    let session: Session
    let seat: WorkspaceSeat?
    @State private var shown = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var width
    #endif

    private var hosts: Bool {
        #if os(iOS)
        seat != nil && width == .regular
        #else
        seat != nil
        #endif
    }

    func body(content: Content) -> some View {
        if hosts {
            content
                .environment(\.workspaceColumn, $shown)
                .inspector(isPresented: $shown) {
                    if let seat {
                        WorkspaceView(session: session, id: seat.id, name: seat.name)
                            .id(seat.id)
                            .environment(\.workspaceColumn, $shown)
                            .inspectorColumnWidth(min: 320, ideal: 440, max: 720)
                    }
                }
        } else {
            content
        }
    }
}


/// A folder of the workspace: folders first, then files with their sizes; each opens where it is.
private struct FolderView: View {
    let session: Session
    let id: String
    let path: String
    let open: (WorkspaceItem) -> Void
    @State private var view: TeamFilesView?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger)
            }
            if let view {
                ForEach(view.entries, id: \.name) { entry in
                    let full = path == "/work" ? "/work/\(entry.name)" : "\(path)/\(entry.name)"
                    Button {
                        open(entry.kind == "dir" ? .folder(full) : .file(full))
                    } label: {
                        HStack(spacing: Space.s3) {
                            Image(systemName: entry.kind == "dir" ? "folder.fill" : entry.kind == "link" ? "arrowshape.turn.up.right" : "doc.text")
                                .foregroundStyle(entry.kind == "dir" ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.secondary))
                                .frame(width: 22)
                            Text(entry.name).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: Space.s2)
                            if entry.kind == "file" {
                                Text(AttachedView.size(entry.size)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(entry.kind == "other")
                }
                if view.more {
                    Text("Only its first \(view.entries.count) entries are listed.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .overlay {
            if let view, view.entries.isEmpty, problem == nil {
                ContentUnavailableView("Nothing here yet", systemImage: "folder", description: Text("\(path) is empty."))
            } else if view == nil, problem == nil {
                ProgressView()
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        struct Ask: Encodable { let id: String; let path: String }
        do {
            view = try await session.client.post("/api/team/files", Ask(id: id, path: path), as: TeamFilesView.self)
            problem = nil
        } catch {
            problem = "This folder couldn't be read: \(error.localizedDescription)"
        }
    }
}

/// One file of the workspace: code coloured with its lines numbered, Markdown drawn (or its source), a picture, or what
/// it is when it is neither.
private struct WorkspaceFile: View {
    let session: Session
    let id: String
    let path: String
    @State private var file: TeamFileView?
    @State private var problem: String?
    @State private var source = false
    @AppStorage("code.wrap") private var wrap = false

    private var name: String { String(path.split(separator: "/").last ?? "File") }
    private var markdown: Bool { name.lowercased().hasSuffix(".md") || name.lowercased().hasSuffix(".markdown") }

    var body: some View {
        Group {
            if let file {
                switch file.kind {
                case "text":
                    if markdown, !source {
                        ScrollView { MarkdownView(file.text ?? "").frame(maxWidth: .infinity, alignment: .leading).padding(Space.s4) }
                    } else {
                        CodeLines(text: file.text ?? "", lang: DiffParts.language(of: path), wrap: wrap)
                    }
                case "image":
                    if let data = file.data.flatMap({ Data(base64Encoded: $0) }), let image = PlatformImage(data: data) {
                        ScrollView([.vertical, .horizontal]) { Image(platformImage: image).resizable().scaledToFit().frame(maxWidth: 1200) }
                    } else {
                        ContentUnavailableView("This picture couldn't be drawn", systemImage: "photo")
                    }
                case "large":
                    ContentUnavailableView("Too big to show here", systemImage: "photo", description: Text("A picture of \(AttachedView.size(file.size)). Open it in its terminal, or keep it as an artifact."))
                default:
                    ContentUnavailableView("Not text", systemImage: "doc", description: Text("\(AttachedView.size(file.size)) that isn't text or a picture this app shows."))
                }
            } else if let problem {
                ContentUnavailableView("It couldn't be read", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else {
                ProgressView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let file, file.cut == true || file.redacted == true {
                Label(file.cut == true ? "Only its beginning is here: it is \(AttachedView.size(file.size))." : "Something that looked like a key was redacted.", systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(Space.s2)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let text = file?.text {
                HStack(spacing: Space.s4) {
                    Spacer()
                    if markdown {
                        Toggle(isOn: $source) { Label("Source", systemImage: "chevron.left.forwardslash.chevron.right") }
                    } else {
                        Toggle(isOn: $wrap) { Label("Wrap Lines", systemImage: "text.word.spacing") }
                    }
                    ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
                }
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s1)
            }
        }
        .task { await load() }
    }

    private func load() async {
        struct Ask: Encodable { let id: String; let path: String }
        do {
            file = try await session.client.post("/api/team/file", Ask(id: id, path: path), as: TeamFileView.self)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// What the agent's latest task changed (or its repository, with none): each file with its lines added and removed,
/// opening its part of the diff, and the whole diff.
private struct ChangesView: View {
    let session: Session
    let id: String
    /// A repository by its path (a project's checkout), instead of the agent's task's.
    var path: String? = nil
    var refresh = 0
    let open: (WorkspaceItem) -> Void
    @State private var changes: TeamChangesView?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger)
            }
            if let changes {
                let parts = DiffParts.of(changes.diff)
                Section {
                    ForEach(changes.files, id: \.self) { file in
                        let part = parts.first { $0.path == file.path }
                        Button {
                            if let part { open(.diff(title: file.path, text: part.text)) }
                        } label: {
                            HStack(spacing: Space.s3) {
                                Text(file.status)
                                    .font(.caption.monospaced().weight(.bold))
                                    .foregroundStyle(file.status == "A" ? Highlight.Tone.added.color : file.status == "D" ? Highlight.Tone.removed.color : .secondary)
                                    .frame(width: 16)
                                Text(file.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                                Spacer(minLength: Space.s2)
                                if let added = file.added, let removed = file.removed {
                                    Text("+\(added)").foregroundStyle(Highlight.Tone.added.color)
                                    Text("−\(removed)").foregroundStyle(Highlight.Tone.removed.color)
                                } else {
                                    Text("binary").foregroundStyle(.secondary)
                                }
                                Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                            .font(.caption.monospacedDigit())
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .disabled(part == nil)
                    }
                    ForEach(changes.untracked, id: \.self) { file in
                        HStack(spacing: Space.s3) {
                            Text("?").font(.caption.monospaced().weight(.bold)).foregroundStyle(.secondary).frame(width: 16)
                            Text(file).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                        }
                        .accessibilityLabel("\(file), not tracked yet")
                    }
                } header: {
                    Text(heading(changes))
                } footer: {
                    if changes.files.isEmpty, changes.untracked.isEmpty { Text("Nothing changed yet.") }
                    else if changes.cut { Text("The diff is cut: only its beginning is here.") }
                    else if changes.redacted == true { Text("Something that looked like a key was redacted.") }
                }
                if !changes.diff.isEmpty {
                    Button {
                        open(.diff(title: "The whole diff", text: changes.diff))
                    } label: {
                        Label("The whole diff", systemImage: "doc.plaintext").contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .overlay { if changes == nil, problem == nil { ProgressView() } }
        .refreshable { await load() }
        .task(id: refresh) { await load() }
    }

    private func heading(_ changes: TeamChangesView) -> String {
        let from = changes.base.map { "from \($0.prefix(8))" } ?? "since its last commit"
        return changes.task == nil ? "Its repository, \(from)" : "Its latest task, \(from)"
    }

    private func load() async {
        struct Ask: Encodable { let id: String; let path: String? }
        do {
            changes = try await session.client.post("/api/team/changes", Ask(id: id, path: path), as: TeamChangesView.self)
            problem = nil
        } catch {
            problem = "Its changes couldn't be read: \(error.localizedDescription)"
        }
    }
}
