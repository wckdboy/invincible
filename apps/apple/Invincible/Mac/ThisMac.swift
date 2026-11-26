#if os(macOS)
import AppKit
import Observation
import SwiftUI

/// This Mac as a node, as This Mac shows it (in Settings, and at the sidebar's foot): its service, its process and its
/// revision, staying on, the `primary` command, its log and its doctor. Read again every few seconds while it is shown.
@MainActor @Observable final class ThisMac {
    let bundle: NodeBundle
    let home: NodeHome
    let agent = NodeAgent()
    /// Where `primary` goes on your PATH (install.sh puts its own there too).
    let commandFile: URL

    private(set) var config: NodeHome.Config?
    /// The node's revision, as this app carries it.
    private(set) var revision: String?
    private(set) var service = NodeAgent.State.off
    /// A node install.sh made, run by its own service.
    private(set) var scripted = false
    private(set) var started: Date?
    /// The node answered its owner here.
    private(set) var answering: WhoAmI?
    private(set) var stayingOn: StayingOn?
    private(set) var command = CommandOnPath.none
    private(set) var log = ""
    private(set) var doctor: Ran?
    /// What it is doing for you now (restarting the node, running the doctor…).
    private(set) var busy: String?
    private(set) var problem: String?
    private(set) var read = false
    /// Shown as given (`show`), not read from this Mac.
    private var given = false

    init(bundle: NodeBundle = .main, home: NodeHome = .standard, commandFile: URL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/bin/invincible")) {
        (self.bundle, self.home, self.commandFile) = (bundle, home, commandFile)
    }

    var isNode: Bool { config != nil }
    var running: Bool { answering != nil }

    /// Where the node stands, in a word and a tone, for the sidebar's foot.
    var summary: (words: String, tone: Tone) {
        guard isNode else { return (bundle.carriesNode ? "Not a node" : "Your client", .quiet) }
        if service == .needsApproval { return ("Allow it in Login Items", .needsYou) }
        guard running else { return (service == .on || scripted ? "Starting…" : "Not running", .quiet) }
        guard let stayingOn else { return ("Running", .good) }
        let held = stayingOn.holding
        return held == stayingOn.lines.count ? ("Running, stays on", .good) : ("Running · \(held) of \(stayingOn.lines.count) staying on", .good)
    }

    enum Tone { case good, quiet, needsYou }

    func refresh() async {
        guard !given else { return }
        config = try? home.config()
        revision = bundle.revision
        scripted = NodeAgent.installedByScript
        // A build without the node has no agent to ask about (SMAppService logs an error for each ask).
        service = bundle.carriesNode ? agent.state : .off
        command = CommandOnPath.read(commandFile, bundle: bundle)
        defer { read = true }
        guard isNode else {
            (started, answering, stayingOn, log) = (nil, nil, nil, "")
            return
        }
        let admin = try? LocalAdmin(home: home)
        async let pid = agent.pid()
        async let me = try? admin?.get("/api/whoami", as: WhoAmI.self, timeout: 3)
        let (process, whoami) = await (pid, me)
        started = process.flatMap(NodeAgent.started)
        answering = whoami
        // install.sh's service runs at login as the app's would: what matters is that launchd has it.
        let state: NodeAgent.State = scripted ? (process != nil ? .on : .off) : service
        stayingOn = await StayingOnReading.read(agent: state, home: home, admin: whoami == nil ? nil : admin)
        log = home.tail(200)
    }

    /// What This Mac shows, given rather than read from this Mac: for its pictures (MacShots) and previews. It isn't read
    /// from the Mac after.
    func show(config: NodeHome.Config, revision: String, service: NodeAgent.State, started: Date, answering: WhoAmI, stayingOn: StayingOn, command: CommandOnPath, log: String) {
        (self.config, self.revision, self.service, self.started, self.answering) = (config, revision, service, started, answering)
        (self.stayingOn, self.command, self.log, scripted, read, given) = (stayingOn, command, log, false, true, true)
    }

    /// Runs `work`, saying `doing` meanwhile, then reads everything again.
    private func work(_ doing: String, _ work: @escaping @MainActor () async throws -> Void) {
        guard busy == nil else { return }
        (busy, problem) = (doing, nil)
        Task {
            do { try await work() } catch is CancellationError {} catch { problem = error.localizedDescription }
            busy = nil
            await refresh()
        }
    }

    func restart() {
        work("Restarting the node…") { try await self.agent.restart() }
    }

    /// Its service set to run at login again (or for the first time); macOS may ask you first, in Login Items.
    func runAtLogin() {
        work("Setting it to run at login…") {
            do { try self.agent.register() } catch where self.agent.state == .needsApproval {}
        }
    }

    /// Stop being a node: its service unregistered, so it stops now and at every login. Its home stays as it was.
    func stopService() {
        work("Stopping the node…") { try await self.agent.unregister() }
    }

    /// The node keeps this Mac awake (`invincible awake on`), from its next start, which is now.
    func keepAwake() {
        work("Keeping this Mac awake…") {
            let ran = try await self.bundle.cli(["awake", "on"])
            guard ran.succeeded else { throw NodeSetup.Failed(errorDescription: ran.lastLine) }
            if !self.scripted { try await self.agent.restart() }
        }
    }

    /// The primary published on your tailnet (`invincible expose`), as install.sh does.
    func publish() {
        work("Publishing it on your tailnet…") {
            let ran = try await self.bundle.cli(["expose"])
            guard ran.succeeded else { throw NodeSetup.Failed(errorDescription: ran.lastLine) }
        }
    }

    func runDoctor() {
        work("The doctor is looking…") { self.doctor = try await self.bundle.cli(["doctor"]) }
    }

    /// `primary` on your PATH: written when there is none, or over another only when you said to.
    func putCommand() {
        do {
            try CommandOnPath.write(commandFile, bundle: bundle)
            command = .ours
        } catch {
            problem = "\(commandFile.path) couldn't be written: \(error.localizedDescription)"
        }
    }

    /// After an update the node runs the release before until it restarts: once, onto this app's, as a planned restart.
    func restartIfNewRelease(defaults: UserDefaults = .standard) async {
        let key = "sh.invincible.bot.mac.node-revision"
        guard home.exists, bundle.carriesNode, !NodeAgent.installedByScript, agent.state == .on, let revision = bundle.revision else { return }
        let before = defaults.string(forKey: key)
        defaults.set(revision, forKey: key)
        if let before, before != revision { try? await agent.restart() }
    }
}

/// `invincible` in `~/.local/bin`: none, this app's (its two lines), or another's (install.sh's, most likely), which is left
/// as it is unless you say otherwise.
enum CommandOnPath: Equatable, Sendable {
    case none, ours, another

    static func read(_ file: URL, bundle: NodeBundle) -> CommandOnPath {
        guard FileManager.default.fileExists(atPath: file.path) else { return .none }
        return (try? String(contentsOf: file, encoding: .utf8)) == bundle.command ? .ours : .another
    }

    /// Written beside, then put in place in one step, as install.sh does.
    static func write(_ file: URL, bundle: NodeBundle) throws {
        let folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let new = folder.appending(path: ".\(file.lastPathComponent).new")
        try Data(bundle.command.utf8).write(to: new)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: new.path)
        guard rename(new.path, file.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}

/// This Mac's node, in sections of a grouped form: the node, staying on, `primary` in Terminal, updates, its log and its
/// doctor. When this Mac isn't a node, it says so, and offers to make it one.
struct ThisMacSections: View {
    let mac: MacApp
    @State private var stopping = false
    @State private var replacing = false

    private var node: ThisMac { mac.thisMac }

    var body: some View {
        if node.isNode {
            nodeSection
            vmsSection
            stayingOnSection
            commandSection
            updatesSection
            logSection
            doctorSection
        } else if node.read {
            Section("The node") {
                if node.bundle.carriesNode {
                    Text("This Mac isn't a node: it is your client. As a node it would run \(Primary.name) and its agents itself, from this app, whenever it's on.")
                        .foregroundStyle(.secondary)
                    Button("Make This Mac a Node…") { mac.firstRun.begin() }
                } else {
                    Text("This build of Invincible carries no node, so on this Mac it is your client alone.")
                        .foregroundStyle(.secondary)
                }
            }
            updatesSection
        }
    }

    private var nodeSection: some View {
        Section {
            LabeledContent("Name") {
                Text(node.config.map { name in [name.name, node.answering?.fleetName.map { "fleet \($0)" }].compactMap { $0 }.joined(separator: ", ") } ?? "")
            }
            LabeledContent("State") {
                HStack(spacing: Space.s2) {
                    Circle().fill(node.running ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
                    Text(stateWords)
                }
            }
            if let revision = node.revision {
                LabeledContent("Revision") { Text(String(revision.prefix(12))).font(.body.monospaced()).textSelection(.enabled) }
            }
            if let started = node.started {
                LabeledContent("Up since") { Text("\(started.formatted(date: .abbreviated, time: .shortened)) (\(started, style: .relative))") }
            }
            if node.scripted {
                Text("Its service is the one install.sh made (\(NodeAgent.scriptPlist.path)): this app pairs with it and shows it, and runs no second one.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: Space.s2) {
                    switch node.service {
                    case .on:
                        Button("Restart") { node.restart() }
                        Button("Stop Being a Node…", role: .destructive) { stopping = true }
                    case .needsApproval:
                        Button("Open Login Items") { node.agent.openLoginItems() }
                    case .off:
                        Button("Run It at Login") { node.runAtLogin() }
                    }
                    Spacer()
                    if let busy = node.busy {
                        ProgressView().controlSize(.small)
                        Text(busy).foregroundStyle(.secondary)
                    }
                }
            }
            if let problem = node.problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        } header: {
            Text("The node")
        }
        .confirmationDialog("Stop being a node?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop Being a Node", role: .destructive) { node.stopService() }
        } message: {
            Text("Its service is unregistered: the node stops now and doesn't start at login. Its home (~/.invincible) stays as it is, so running it again picks up where it was, and invincible still runs in Terminal.")
        }
    }

    private var stateWords: String {
        if node.running { return "Running" }
        switch node.service {
        case .needsApproval: return "Waiting for your approval in Login Items"
        case .on: return "Starting, or not answering"
        case .off: return node.scripted && node.started != nil ? "Starting, or not answering" : "Not running"
        }
    }

    /// What its agents' VMs need, read when This Mac opens; Set Up gives what doesn't hold (`invincible sandbox setup`).
    private var vmsSection: some View {
        let setup = mac.vmSetup
        return Section {
            VMSetupRows(setup: setup)
            if let problem = setup.problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            if setup.bundle.carriesNode {
                HStack(spacing: Space.s2) {
                    Spacer()
                    Button("Check Again") { Task { await setup.status() } }.disabled(setup.running)
                    if !setup.holds {
                        Button(setup.failed ? "Try Again" : "Set Up") { setup.setUp() }.disabled(setup.running || !setup.read)
                    }
                }
            }
        } header: {
            Text("Agents' VMs")
        } footer: {
            Text(setup.holds ? "Each agent's VM is made here with Apple's container, behind the sandbox firewall. invincible sandbox setup in Terminal says the same." : VMSetupRows.footer)
        }
        .task { if !setup.read { await setup.status() } }
    }

    @ViewBuilder private var stayingOnSection: some View {
        if let stayingOn = node.stayingOn {
            Section {
                ForEach(stayingOn.lines) { line in
                    StayingOnRow(line: line) { StayingOnAction(line: line, node: node) }
                }
            } header: {
                Text("Staying on")
            } footer: {
                Text("Each line is read from this Mac as it is now. Invincible never changes these settings itself: each button opens the place that does.")
            }
        }
    }

    private var commandSection: some View {
        Section {
            switch node.command {
            case .ours:
                Label("invincible runs this app's node, in Terminal and over SSH.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.secondary)
            case .none:
                HStack {
                    Text("Put invincible on your PATH, as a two-line script in ~/.local/bin that runs this app's node.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Add") { node.putCommand() }
                }
            case .another:
                HStack {
                    Text("~/.local/bin/invincible is there already, probably from install.sh: it is left as it is.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Replace It…") { replacing = true }
                }
            }
        } header: {
            Text("In Terminal")
        } footer: {
            Text("If your shell doesn't find it, add ~/.local/bin to your PATH.")
        }
        .confirmationDialog("Replace ~/.local/bin/invincible?", isPresented: $replacing, titleVisibility: .visible) {
            Button("Replace It") { node.putCommand() }
        } message: {
            Text("invincible will run this app's node instead of what it runs now.")
        }
    }

    private var updatesSection: some View {
        Section("Updates") {
            HStack {
                Text(Updates.shared.available ? "New releases come from invincible.sh, each checked against Invincible's signing key before it is installed." : "Off in this build: it carries no key to check updates with yet.")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Check for Updates…") { Updates.shared.check() }.disabled(!Updates.shared.canCheck)
            }
        }
    }

    private var logSection: some View {
        Section {
            ScrollView {
                Text(node.log.isEmpty ? "Nothing in it yet." : node.log)
                    .font(.caption.monospaced())
                    .foregroundStyle(node.log.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.s2)
                    .id("end")
            }
            .defaultScrollAnchor(.bottom)
            .frame(height: 180)
            .background(.fill.quaternary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
        } header: {
            HStack {
                Text("Its log")
                Spacer()
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([node.home.log]) }
                    .buttonStyle(.link)
                    .font(.callout)
            }
        }
    }

    private var doctorSection: some View {
        Section {
            HStack {
                Text("One look at the whole installation: its keys, the mind, its clock, sync, its models (each asked a word) and its sandboxes.")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Run the Doctor") { node.runDoctor() }.disabled(node.busy != nil)
            }
            if let doctor = node.doctor {
                Label(doctor.status == 0 ? "All is well." : doctor.status == 1 ? "Something needs you." : "Something is broken.",
                      systemImage: doctor.status == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(doctor.status == 0 ? Color.green : doctor.status == 1 ? Color.orange : Color.danger)
                Text(doctor.output)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } header: {
            Text("The doctor")
        }
    }
}

/// A line of staying on: a tick when it holds, an empty ring when something is missing (said under it), a dash when this
/// Mac can't tell; and its button.
struct StayingOnRow<Action: View>: View {
    let line: StayingOn.Line
    @ViewBuilder let action: Action

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Image(systemName: line.holds == true ? "checkmark.circle.fill" : line.holds == false ? "circle" : "minus.circle")
                .foregroundStyle(line.holds == true ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                .font(.body)
                .frame(width: Metrics.iconColumn - Space.s1)
                .accessibilityLabel(line.holds == true ? "Holds" : line.holds == false ? "Missing" : "Can't tell")
            VStack(alignment: .leading, spacing: Space.line) {
                Text(line.item.title)
                Text(line.said).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.s2)
            action.controlSize(.small)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The panes of System Settings a line opens.
enum SystemSettings {
    enum Pane: String {
        case usersAndGroups = "com.apple.Users-Groups-Settings.extension"
        /// Energy on a Mac with no battery; Battery on one with (one pane, one name: seen on macOS 27.2).
        case energy = "com.apple.Battery-Settings.extension"
        case privacy = "com.apple.settings.PrivacySecurity.extension"
    }

    static func open(_ pane: Pane) {
        if let url = URL(string: "x-apple.systempreferences:\(pane.rawValue)") { NSWorkspace.shared.open(url) }
    }
}

/// This Mac at the sidebar's foot: where its node stands, in a line. A click opens This Mac.
struct ThisMacFoot: View {
    let mac: MacApp

    /// A laptop or a Mac mini, as this Mac is (a Mac with a battery is drawn as a laptop).
    static let symbol = StayingOnReading.hasBattery ? "laptopcomputer" : "macmini"

    var body: some View {
        let summary = mac.thisMac.summary
        Button {
            mac.place = .thisMac
        } label: {
            HStack(spacing: Space.s2) {
                Image(systemName: Self.symbol)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: Metrics.iconColumn)
                VStack(alignment: .leading, spacing: Space.line) {
                    Text("This Mac").font(.headline)
                    HStack(spacing: Space.s1) {
                        Circle()
                            .fill(summary.tone == .good ? Color.green : summary.tone == .needsYou ? Color.danger : Color.secondary.opacity(0.5))
                            .frame(width: 7, height: 7)
                        Text(summary.words).lineLimit(1)
                    }
                    .font(.subheadline)
                    .foregroundStyle(summary.tone == .needsYou ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.secondary))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2)
            .background(mac.place == .thisMac ? AnyShapeStyle(.fill.secondary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: Space.s2, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Space.s2)
        .padding(.vertical, Space.s1)
        .accessibilityLabel("This Mac: \(summary.words)")
    }
}
#endif
