import SwiftUI

/*
 * Home: the primary, first (the PWA's views/home.ts; your words, 26 November 2026: "agent first (the primary)"; on an iPhone no
 * tab bar, "a '…' sheet for everything else"). Its orb, the one that moves on the screen, its name and a line of how things
 * stand, the machine it runs on, and "…". Then what needs you, each with its answer in place (NeedsYou.swift); then the
 * work in one list by attention (what is new to you, then what is at work, quieter; what is settled folds), each task a
 * row of three lines that opens its thread, with a filter for each project; and its message box docked at the foot, where
 * whatever you ask it starts a conversation with it. An iPhone opens here; a wide window has it beside the same work in
 * its sidebar.
 */

/// Where Home's parts lead: a place (its conversation, a task's thread, the Inbox, Settings…), and everything else.
struct HomeView: View {
    let session: Session
    /// Goes to a place: its conversation, a task's thread, the Inbox.
    let go: (Place) -> Void
    /// Everything else ("…"): the places sheet on an iPhone. Nil on a wide window, whose "…" is a menu of the places.
    var everything: (() -> Void)? = nil
    /// Gives a task to the agents (nil: this device may not).
    var give: (() -> Void)? = nil
    @FocusState private var composing: Bool
    @State private var filtered: String?
    @AppStorage("home.done") private var doneOpen = false

    private var chat: ChatModel { session.chat }

    var body: some View {
        let work = session.attended
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s6) {
                if let trouble = session.trouble {
                    TroubleRow(trouble: trouble).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                }
                if let since = session.keptSince { KeptLine(since: since) }
                #if os(iOS)
                ReachCard(session: session)
                #endif
                if let work { NeedsYou(session: session, work: work) { go(.task($0)) } }
                workSection(work)
            }
            .padding(.horizontal, Metrics.margin)
            .padding(.top, Space.s2)
            .padding(.bottom, Space.s6)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
        // What scrolls goes under its header and its message box, which keep the system's own edge.
        .scrollEdgeEffectStyle(.hard, for: .top)
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        .safeAreaBar(edge: .top) { header(work) }
        .safeAreaBar(edge: .bottom) { dock }
        #if os(iOS)
        .toolbar(.hidden, for: .navigationBar)
        #endif
        .navigationTitle(Primary.name)
        .onAppear {
            // Back here, the next message starts a conversation of its own (the one you left stays among its chats).
            composing = false
            if !chat.answering { chat.startNew() }
        }
        .task { await session.askProjects() }
        .refreshable { await session.refresh() }
    }

    // MARK: Its header

    private func header(_ work: Attended?) -> some View {
        let glance = work.map { Work.atAGlance($0, needs: session.needsCount($0), its: session.primary.line) } ?? (session.primary.line, false)
        return HStack(spacing: Space.s3) {
            Button { go(.primary) } label: {
                HStack(spacing: Space.s3) {
                    // The one orb that moves here: its (the agents' in their rows are still).
                    PrimaryOrb(size: 48, tone: session.primaryTone, mood: session.primaryMood, key: "primary:home")
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Primary.name)
                            .font(.title2.weight(.bold))
                            .tracking(-0.4)
                            .foregroundStyle(.primary)
                        // One line, whole where it can be: beside the machine chip on a phone it shrinks a little
                        // ("1 at work · 5 need you", as it read then, was cut to "5 nee…" on a 402-point iPhone) before
                        // it is cut.
                        Text(glance.0)
                            .font(.subheadline)
                            .foregroundStyle(glance.1 ? Color.needs : lineColor)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .monospacedDigit()
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(Primary.name): \(glance.0)")
            .accessibilityHint("Opens its own conversation")
            Spacer(minLength: Space.s2)
            MachineChip(session: session) { go(.more) }
            if let everything {
                Button(action: everything) {
                    Image(systemName: "ellipsis").font(.body.weight(.semibold)).frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Everything else")
                .accessibilityIdentifier("everything")
            } else {
                PlacesMenu(session: session, go: go, give: give)
            }
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.vertical, Space.s2)
        .readingWidth()
    }

    /// Its line's colour: where it stands, as everywhere.
    private var lineColor: Color {
        switch session.primaryTone {
        case .warn: .needs
        case .accent: .working
        case .ok: .done
        case .danger: .failed
        case .neutral: .secondary
        }
    }

    // MARK: The work

    @ViewBuilder private func workSection(_ work: Attended?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Text("Work").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.s2)
                if let give {
                    Button(action: give) { Label("New task", systemImage: "plus") }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                        .frame(minHeight: Metrics.touch)
                        .help("Give a task to the agent best suited to it, or to one by name")
                }
            }
            if let work {
                let projects = work.projects
                if projects.count > 1 { filters(projects) }
                let shown = work.only(filtered.flatMap { key in projects.contains { $0.key == key } ? key : nil })
                let rows = shown.active + shown.working
                ForEach(rows) { row in rowButton(row) }
                if !shown.done.isEmpty {
                    if !rows.isEmpty { Divider() }
                    FoldHead(title: "Done", count: shown.done.count, open: $doneOpen)
                    if doneOpen { ForEach(shown.done) { row in rowButton(row) } }
                }
                if rows.isEmpty && shown.done.isEmpty && shown.needs.isEmpty {
                    empty(filtered: filtered != nil)
                }
            } else if let problem = session.teamProblem {
                VStack(alignment: .leading, spacing: Space.s2) {
                    Text("The work can't be read just now.").font(.subheadline)
                    Text(problem).font(.footnote).foregroundStyle(.secondary)
                    Button("Try again") { Task { await session.refresh() } }.buttonStyle(.borderless).frame(minHeight: Metrics.touch)
                }
                .padding(.vertical, Space.s3)
            } else {
                // Until the agents have answered: the rows' places held, quietly.
                VStack(alignment: .leading, spacing: Space.s4) {
                    ForEach(0..<3, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 6) {
                            RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(width: 120, height: 10)
                            RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(height: 12)
                            RoundedRectangle(cornerRadius: 4).fill(.fill.tertiary).frame(width: 180, height: 10)
                        }
                    }
                }
                .padding(.vertical, Space.s3)
                .accessibilityElement()
                .accessibilityLabel("Reading the work")
            }
        }
    }

    private func rowButton(_ row: WorkRow) -> some View {
        Button { go(.task(row.id)) } label: { WorkRowView(row: row, face: 18) }
            .buttonStyle(RowPress())
            .overlay(alignment: .bottom) { Divider().opacity(0.6) }
    }

    /// A filter for each project with work, when there is more than one.
    private func filters(_ projects: [Attended.Project]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip(nil, "All", badge: nil)
                ForEach(projects, id: \.key) { project in
                    chip(project.key, project.name, badge: WorkProject(key: project.key, name: project.name, badge: project.badge))
                }
            }
            .padding(.vertical, Space.s2)
        }
        .scrollClipDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show the work of")
    }

    private func chip(_ key: String?, _ label: String, badge: WorkProject?) -> some View {
        let on = filtered == key
        return Button {
            withAnimation(.snappy) { filtered = key }
        } label: {
            HStack(spacing: 6) {
                if let badge { ProjectBadge(project: badge) }
                Text(label).lineLimit(1)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(on ? Color.onAccent : .primary)
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .background(on ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.fill.quaternary), in: .capsule)
            .overlay(Capsule().strokeBorder(.separator, lineWidth: on ? 0 : 1))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func empty(filtered: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text(filtered ? "Nothing in this project." : "Nothing under way. Ask \(Primary.name) below, or give an agent a task: each is a row here, from its first step to verified.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let give, !filtered {
                NeedButton(title: "Give a task", prominent: true, action: give)
            }
        }
        .padding(.vertical, Space.s3)
    }

    // MARK: Its message box

    @ViewBuilder private var dock: some View {
        if !session.can("chat") {
            EmptyView()
        } else if chat.answering {
            // While it answers in the chat you left, the box is that chat's: a press shows it.
            Button { go(.primary) } label: {
                HStack(spacing: Space.s2) {
                    LiveDot(color: .working)
                    Text(chat.title.map { "Answering in “\($0)”" } ?? "Answering").lineLimit(1)
                    Spacer(minLength: Space.s2)
                    Text("Show").fontWeight(.semibold)
                }
                .font(.subheadline)
                .padding(.horizontal, Space.s4)
                .frame(minHeight: Metrics.touch)
            }
            .buttonStyle(.glass)
            .padding(.horizontal, Metrics.margin)
            .padding(.vertical, Space.s2)
            .readingWidth()
            .accessibilityIdentifier("answering")
        } else {
            Composer(chat: chat, client: session.client, composing: $composing, sent: { go(.primary) }, prompt: "Ask \(Primary.name)…")
        }
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
        .accessibilityLabel("\(name): \(session.trouble != nil ? "can't be reached" : reached ? "answering" : "not answered yet")")
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
        Button { go(.inbox) } label: { Label(session.inboxCount > 0 ? "Inbox · \(session.inboxCount)" : "Inbox", systemImage: "tray") }
        Button { go(.more) } label: { Label("Settings", systemImage: "gearshape") }
    }
}
