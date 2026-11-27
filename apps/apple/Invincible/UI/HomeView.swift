import SwiftUI

/*
 * Work (the owner's word of 27 November 2026: the app opens on your agent's chat, as T3 Code opens on a thread; the web's
 * Work, Home's address): what needs you, decisions only, three at most, each with its one answer in place (the rest a
 * swipe away, all of it a tap on the row); and the work by proof: Working, Proven, Failed, and the rest of what is done,
 * folded. No header, no strip of agents and no message box of its own: the roster has the agents, your agent's chat the
 * box. The node is named only when something is wrong. A lazy list: a hundred tasks cost what is on screen.
 */

/// Home's work, by proof: in hand, proven, failed, and the rest of what ended.
struct ByProof: Equatable {
    var working: [WorkRow] = []
    var proven: [WorkRow] = []
    var failed: [WorkRow] = []
    var done: [WorkRow] = []

    /// Every task but those that need you (they are decisions), each in its group, the latest first; at work before queued.
    init(_ work: Attended) {
        for row in work.active + work.working + work.done {
            if row.state == .working || row.state == .queued || (row.verdict == nil && row.attention == .working) {
                working.append(row)
                continue
            }
            switch row.verdict?.kind {
            case .proven: proven.append(row)
            case .failed, .rejected, .gaveUp: failed.append(row)
            default: done.append(row)
            }
        }
        let newest = { (a: WorkRow, b: WorkRow) -> Bool in a.at != b.at ? a.at > b.at : a.id < b.id }
        working.sort { a, b in (a.state == .working) != (b.state == .working) ? a.state == .working : newest(a, b) }
        proven.sort(by: newest)
        failed.sort(by: newest)
        done.sort(by: newest)
    }

    init() {}

    var isEmpty: Bool { working.isEmpty && proven.isEmpty && failed.isEmpty && done.isEmpty }
}

struct HomeView: View {
    let session: Session
    /// Goes to a place: a task's thread, an agent, the Inbox.
    let go: (Place) -> Void
    /// Search, or ask (its ⌕, an iPad's ⌘K).
    var search: (() -> Void)? = nil
    /// Gives a task to the agents (nil: this device may not).
    var give: (() -> Void)? = nil
    @AppStorage("home.done") private var doneOpen = false
    /// What its decisions' answers are doing (shared with Needs you: Decisions.swift).
    @State private var desk = DecisionDesk()

    var body: some View {
        let work = session.attended
        List {
            if Session.showsReconnecting(session.reconnecting, trouble: session.trouble) {
                ReconnectingLine(session: session).listRowSeparator(.hidden)
            } else if let trouble = session.trouble {
                TroubleRow(trouble: trouble).font(.callout).listRowSeparator(.hidden)
            }
            if let since = session.keptSince { KeptLine(since: since, asking: session.asksAgain).listRowSeparator(.hidden) }
            if let work {
                let decisions = desk.decisions(session, work, go: go)
                if !decisions.isEmpty {
                    Section {
                        ForEach(decisions.prefix(3)) { decision in
                            DecisionRow(decision: decision, busy: desk.busy.contains(decision.id))
                        }
                        if decisions.count > 3 {
                            Button { go(.inbox) } label: {
                                HStack {
                                    Text("\(decisions.count - 3) more").fontWeight(.semibold)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                                }
                                .font(.subheadline)
                                .frame(minHeight: Metrics.touch)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("needs.more")
                        }
                    } header: {
                        SectionHead(title: "Needs you", count: session.needsYou, strong: true)
                    }
                }
                let groups = ByProof(work)
                if !groups.working.isEmpty { Section { rows(groups.working) } header: { SectionHead(title: "Working", count: groups.working.count) } }
                if !groups.proven.isEmpty { Section { rows(groups.proven) } header: { SectionHead(title: "Proven", count: groups.proven.count) } }
                if !groups.failed.isEmpty { Section { rows(groups.failed) } header: { SectionHead(title: "Failed", count: groups.failed.count, failed: true) } }
                if !groups.done.isEmpty {
                    Section {
                        FoldHead(title: "Done", count: groups.done.count, open: $doneOpen).listRowSeparator(.hidden)
                        if doneOpen { rows(groups.done) }
                    }
                }
                if groups.isEmpty && decisions.isEmpty { empty }
            } else if let problem = session.teamProblem {
                VStack(alignment: .leading, spacing: Space.s2) {
                    Text("The work can't be read just now.").font(.subheadline)
                    Text(problem).font(.footnote).foregroundStyle(.secondary)
                    Button("Try again") { Task { await session.refresh() } }.buttonStyle(.borderless).frame(minHeight: Metrics.touch)
                }
                .listRowSeparator(.hidden)
            } else {
                // Until the agents have answered: the rows' places held, quietly.
                ForEach(0..<3, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(width: 120, height: 10)
                        RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(height: 12)
                        RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(width: 180, height: 10)
                    }
                    .padding(.vertical, Space.s2)
                    .listRowSeparator(.hidden)
                }
                .accessibilityElement()
                .accessibilityLabel("Reading the work")
            }
        }
        .listStyle(.plain)
        .screen("work.screen")
        .navigationTitle("Work")
        .toolbar {
            ToolbarItemGroup(placement: .barTrailing) {
                if let search {
                    Button(action: search) { Label("Search, or ask", systemImage: "magnifyingglass") }
                        .accessibilityIdentifier("work.search")
                }
                if let give {
                    Button(action: give) { Label("Give a task", systemImage: "square.and.pencil") }
                        .help("Give a task to the agent best suited to it, or to one by name")
                        .accessibilityIdentifier("work.give")
                }
            }
        }
        .task { await session.askProjects() }
        .refreshable { await session.refresh() }
        .modifier(DecisionDeskSheets(desk: desk, session: session))
    }

    // MARK: The work

    private func rows(_ rows: [WorkRow]) -> some View {
        ForEach(rows) { row in
            Button { go(.task(row.id)) } label: { WorkRowView(row: row, face: 18, quietWhenWorking: false) }
                .buttonStyle(RowPress())
                .accessibilityIdentifier("row.\(row.id)")
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text("Nothing under way. Ask your agent, or give an agent a task: each is a row here, from its first step to its proof.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, Space.s3)
        .listRowSeparator(.hidden)
    }
}

/// A section's head on Home: its name in small capitals, and how many.
struct SectionHead: View {
    let title: String
    /// How many (nil: a section that counts nothing, a place's own: Settings' This device).
    var count: Int?
    var strong = false
    var failed = false

    var body: some View {
        HStack(spacing: Space.s2) {
            Text(title.uppercased()).tracking(0.6)
            if let count { Text("\(count)").monospacedDigit() }
            Spacer(minLength: 0)
        }
        .font(Typeset.section)
        .foregroundStyle(failed ? AnyShapeStyle(Color.danger) : strong ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The link to the node went and isn't back: said in one line where how things stand is, with what is shown still the
/// last the node said, and a way to try at once.
struct ReconnectingLine: View {
    let session: Session

    var body: some View {
        let name = session.whoami?.nodeName ?? session.node.nodeName ?? "your node"
        HStack(spacing: Space.s2) {
            ProgressView().controlSize(.mini)
            Text("Reconnecting to \(name)…").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: Space.s2)
            Button("Retry") { session.networkChanged() }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
                .frame(minHeight: Metrics.touch)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("link.down")
        .accessibilityLabel("Reconnecting to \(name)")
    }
}

/// The machine the primary runs on, by its name, its dot green while it answers and red when it can't be reached. It opens
/// Settings, where the node and its fleet are.
struct MachineChip: View {
    let session: Session
    let open: () -> Void

    var body: some View {
        let name = session.whoami?.nodeName ?? session.node.nodeName ?? "This node"
        let reached = session.trouble == nil && session.whoami != nil
        Button(action: open) {
            HStack(spacing: 6) {
                Circle().fill(session.trouble != nil ? Color.failed : reached ? Color.done : Color.secondary).frame(width: 7, height: 7)
                Text(name).lineLimit(1)
            }
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .accessibilityLabel("\(name): \(session.trouble?.notYourNode != nil ? "isn't the node this device paired with" : session.trouble != nil ? "can't be reached" : reached ? "answering" : "not answered yet")")
        .accessibilityHint("Opens Settings")
    }
}

/// A row's press and hover: its ground darkens a little while held or under the pointer, and it never moves the layout.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Pressed(configuration: configuration) }

    private struct Pressed: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .padding(.horizontal, Space.s2)
                .background(configuration.isPressed ? AnyShapeStyle(.fill.tertiary) : hovering ? AnyShapeStyle(.fill.quaternary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, -Space.s2)
                .contentShape(.rect)
                .onHover { hovering = $0 }
        }
    }
}

/// Everything else as a menu, on a wide window: the places the "…" sheet holds on an iPhone.
struct PlacesMenu: View {
    let session: Session
    let go: (Place) -> Void
    var give: (() -> Void)? = nil

    var body: some View {
        Menu {
            PlaceButtons(session: session, go: go, give: give)
        } label: {
            Image(systemName: "ellipsis").font(.body.weight(.semibold)).frame(width: 30, height: 30)
        }
        .menuStyle(.button)
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .menuIndicator(.hidden)
        .accessibilityLabel("Everything else")
    }
}

/// The places beyond Home, as buttons (a menu's, or the sheet's rows): give a task, the agents, the Inbox, Settings.
struct PlaceButtons: View {
    let session: Session
    let go: (Place) -> Void
    var give: (() -> Void)? = nil

    var body: some View {
        if let give { Button(action: give) { Label("Give a task…", systemImage: "square.stack.3d.up") } }
        Button { go(.primary) } label: { Label(Primary.name, systemImage: "bubble.left.and.text.bubble.right") }
        Button { go(.agents) } label: { Label("Agents", systemImage: "person.3") }
        Button { go(.inbox) } label: { Label(session.needsYou > 0 ? "Needs you · \(session.needsYou)" : "Needs you", systemImage: "tray") }
        Button { go(.more) } label: { Label("Settings", systemImage: "gearshape") }
    }
}
