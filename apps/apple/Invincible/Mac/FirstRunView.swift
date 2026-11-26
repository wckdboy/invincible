#if os(macOS)
import AppKit
import SwiftUI

/// The first run, on a Mac with no node: one window, three steps down its side as an installer's are (docs/MAC.md, "The
/// screens"). Make this Mac a node (start a fleet, join yours, or just the app); keep it on (a Mac with a battery skips
/// it: it works while it's open); give its agents VMs.
struct FirstRunView: View {
    let mac: MacApp
    @Bindable var run: FirstRun
    /// Why this app can't make this Mac a node from where it is (NodeSetup.unready), or nil.
    var unready: String? = NodeSetup { _ in }.unready
    var carriesNode = NodeBundle.main.carriesNode

    var body: some View {
        HStack(spacing: 0) {
            FirstRunSteps(current: run.step)
                .frame(width: 236)
            Divider()
            VStack(spacing: 0) {
                Form {
                    switch run.step {
                    case .node: nodeStep
                    case .stayOn: stayOnStep
                    case .vms: vmsStep
                    }
                }
                .formStyle(.grouped)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
                Divider()
                footer
            }
        }
        .task(id: run.step) {
            // What its agents' VMs need is read as the step opens (each read asks container and the node).
            if run.step == .vms { await mac.vmSetup.status() }
            // Staying on is read again every few seconds while it is shown, as you change what it reads.
            guard run.step == .stayOn else { return }
            while !Task.isCancelled {
                await mac.thisMac.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    // MARK: 1. Make this Mac a node

    @ViewBuilder private var nodeStep: some View {
        Section {
            TextField("Name", text: $run.name)
                .disabled(run.working)
        } header: {
            StepHead(title: FirstRun.Step.node.title, line: "A node is where \(Primary.name) and its agents do their work. This Mac can be one, run by this app whenever the Mac is on, or it can be your client alone.")
        } footer: {
            Text("How this Mac appears in your fleet.")
        }
        if run.way != .client, let unready {
            Section {
                Label(unready, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                if carriesNode {
                    Text("Drag Invincible into Applications, then open it from there.").foregroundStyle(.secondary)
                    Button("Show the Applications Folder") { NSWorkspace.shared.open(URL(filePath: "/Applications")) }
                }
            }
        }
        Section {
            WayRow(title: "Start a fleet", detail: "This Mac is your fleet's first node, its keys and its memory kept here.", chosen: run.way == .start) { run.way = .start }
            if run.way == .start {
                TextField("Its fleet's name", text: $run.fleet)
                    .padding(.leading, WayRow.indent)
                    .disabled(run.working)
            }
            WayRow(title: "Join my fleet", detail: "Another node of yours invites it: run invincible invite there. You approve it there once the two codes match.", chosen: run.way == .join) { run.way = .join }
            if run.way == .join {
                FormField("Paste the invite (gi1.…)", text: $run.invite, axis: .vertical)
                    .lineLimit(2...4)
                    .font(.footnote.monospaced())
                    .autocorrectionDisabled()
                    .padding(.leading, WayRow.indent)
                    .disabled(run.working)
            }
            WayRow(title: "Just the app", detail: "Your client alone, paired with a node elsewhere. This Mac can still become a node later, from This Mac.", chosen: run.way == .client) { run.way = .client }
        } header: {
            Text("This Mac will")
        }
        .disabled(run.working)
        progress
    }

    // MARK: 2. Keep it on

    @ViewBuilder private var stayOnStep: some View {
        Section {
            if let stayingOn = mac.thisMac.stayingOn {
                ForEach(stayingOn.lines) { line in
                    StayingOnRow(line: line) { StayingOnAction(line: line, node: mac.thisMac) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            StepHead(title: FirstRun.Step.stayOn.title, line: "A node is only useful while it's up. Each line is read from this Mac as it is now: a tick, or what is missing. Invincible never changes these settings itself; each button opens the place that does.")
        } footer: {
            Text("You can come back to these in Settings → This Mac.")
        }
        progress
    }

    // MARK: 3. Give its agents VMs

    @ViewBuilder private var vmsStep: some View {
        Section {
            VMSetupRows(setup: mac.vmSetup)
        } header: {
            StepHead(title: FirstRun.Step.vms.title, line: "Each agent works in a VM of its own. On a Mac they are made with Apple's container, which runs each one in a lightweight VM on this Mac's own silicon, behind a firewall that keeps it to what it may reach.")
        } footer: {
            Text(mac.vmSetup.holds ? "Agents' VMs are made on this Mac now." : VMSetupRows.footer)
        }
        if let problem = mac.vmSetup.problem {
            Section {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        }
    }

    // MARK: Shared

    /// What it is doing now, the code to compare while joining, and what went wrong.
    @ViewBuilder private var progress: some View {
        if let stage = run.stage {
            Section {
                if case .joining(let code?) = stage {
                    VStack(spacing: Space.s3) {
                        Text("Your code").font(.subheadline).foregroundStyle(.secondary)
                        Text(code)
                            .font(.system(size: 46, weight: .semibold, design: .monospaced))
                            .accessibilityLabel(code.map(String.init).joined(separator: " "))
                        Text("Approve \(Text(run.name).bold()) on the node that invited it, only if that node shows this exact code.")
                            .font(.callout)
                            .multilineTextAlignment(.center)
                        HStack(spacing: Space.s2) {
                            ProgressView().controlSize(.small)
                            Text("Waiting for your approval…")
                        }
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.s2)
                } else {
                    HStack(spacing: Space.s2) {
                        ProgressView().controlSize(.small)
                        Text(stage.words)
                    }
                    if stage == .approving {
                        Button("Open Login Items") { mac.thisMac.agent.openLoginItems() }
                    }
                }
            }
        }
        if let problem = run.problem {
            Section {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Space.s3) {
            if run.working {
                Button("Cancel") { run.cancel() }
                    .disabled(run.step != .node)
            }
            Spacer()
            // Not now is fine: agents work on your other nodes until then.
            if run.step == .vms, !mac.vmSetup.holds {
                Button("Not Now") { run.next() }
                    .controlSize(.large)
                    .disabled(mac.vmSetup.running)
            }
            Button {
                switch run.step {
                case .node: run.go(app: mac.app)
                case .stayOn: run.next()
                case .vms: if mac.vmSetup.holds { run.next() } else { mac.vmSetup.setUp() }
                }
            } label: {
                Text(primary)
                    .fontWeight(.semibold)
                    .foregroundStyle(Prominent.label(dimmed: !canContinue))
                    .padding(.horizontal, Space.s2)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(!canContinue)
        }
        .padding(.horizontal, Space.s6)
        .padding(.vertical, Space.s4)
    }

    private var primary: String {
        switch run.step {
        case .node: run.way == .start ? "Start the Fleet" : run.way == .join ? "Join the Fleet" : "Continue"
        case .stayOn: "Continue"
        case .vms: mac.vmSetup.holds ? "Done" : mac.vmSetup.running ? "Setting Up…" : mac.vmSetup.failed ? "Try Again" : "Set Up"
        }
    }

    private var canContinue: Bool {
        switch run.step {
        case .node: run.canGo && (run.way == .client || unready == nil)
        case .stayOn: !run.working
        case .vms: !run.working && !mac.vmSetup.running && mac.vmSetup.read
        }
    }
}

/// The three steps down the window's side: those done ticked, the one you're on in the ink, those to come in grey.
struct FirstRunSteps: View {
    let current: FirstRun.Step

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s4) {
            AppMark(size: 56)
                .padding(.bottom, Space.s4)
            ForEach(FirstRun.Step.allCases, id: \.self) { step in
                HStack(spacing: Space.s2) {
                    Image(systemName: step < current ? "checkmark.circle.fill" : step == current ? "\(step.rawValue).circle.fill" : "\(step.rawValue).circle")
                        .font(.title3)
                        .foregroundStyle(step == current ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.secondary))
                    Text(step.title)
                        .fontWeight(step == current ? .semibold : .regular)
                        .foregroundStyle(step > current ? .secondary : .primary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(step == current ? .isSelected : [])
            }
            Spacer()
        }
        .padding(Space.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// A step's title and what it is for: the head of its first section, so it lines up with the rows under it and stands on
/// the page, not in a card.
private struct StepHead: View {
    let title: String
    let line: String

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text(title).font(.largeTitle.bold()).foregroundStyle(.primary)
            Text(line).font(.body).fontWeight(.regular).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .textCase(nil)
        .padding(.top, Space.s4)
        .padding(.bottom, Space.s3)
    }
}

/// One of step 1's three ways, chosen as a radio button is.
private struct WayRow: View {
    let title: String
    let detail: String
    let chosen: Bool
    let choose: () -> Void

    /// Where a way's words start, so what it asks for under it (a fleet's name, an invite) starts there too.
    static let indent = Space.s4 + Space.s1 + Space.s3

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.secondary))
                    .frame(width: Space.s4 + Space.s1)
                VStack(alignment: .leading, spacing: Space.line) {
                    Text(title).font(.headline)
                    Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// What a line of staying on offers to put it right: the pane of System Settings that changes it, or, for what is the
/// node's own (its service, keeping awake, publishing on your tailnet), the node.
struct StayingOnAction: View {
    let line: StayingOn.Line
    let node: ThisMac

    var body: some View {
        switch line.fix {
        case .loginItems?: Button("Open Login Items") { node.agent.openLoginItems() }
        // A node install.sh made has a service of its own.
        case .runAtLogin? where !node.scripted: Button("Run at Login") { node.runAtLogin() }
        case .usersAndGroups?: Button("Open Users & Groups") { SystemSettings.open(.usersAndGroups) }
        case .fileVault?: Button("Open FileVault") { SystemSettings.open(.privacy) }
        case .keepAwake?: Button("Keep Awake") { node.keepAwake() }.disabled(node.busy != nil)
        case .restart?: Button("Restart the Node") { node.restart() }.disabled(node.busy != nil)
        case .energy?: Button("Open Energy") { SystemSettings.open(.energy) }
        case .publish?: Button("Publish") { node.publish() }.disabled(node.busy != nil)
        case .openTailscale?: Button("Open Tailscale") { NSWorkspace.shared.open(Tailscale.app) }
        case .getTailscale?: Button("Get Tailscale") { NSWorkspace.shared.open(Tailscale.download) }
        case .runAtLogin?, nil: EmptyView()
        }
    }
}

/// A Mac that is a node already (install.sh made it, or this app was asked to forget its key), and this app isn't paired:
/// it pairs with that node as it runs, or with another as its client.
struct LocalNodeOpen: View {
    let mac: MacApp
    @Bindable var run: FirstRun
    @State private var elsewhere = false

    var body: some View {
        if elsewhere {
            JoinView(app: mac.app, handed: mac.handed)
        } else {
            Form {
                Section {
                    VStack(spacing: Space.s3) {
                        AppMark(size: 88)
                        Text("This Mac is a node").font(.largeTitle.bold())
                        Text(lines)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.s2)
                }
                .listRowBackground(Color.clear)
                if let stage = run.stage {
                    Section {
                        HStack(spacing: Space.s2) {
                            ProgressView().controlSize(.small)
                            Text(stage.words)
                        }
                    }
                }
                if let problem = run.problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                }
                Section {
                    Button {
                        run.open(app: mac.app)
                    } label: {
                        Text("Open It Here").fontWeight(.semibold)
                            .foregroundStyle(Prominent.label(dimmed: run.working))
                            .frame(maxWidth: .infinity, minHeight: 34)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(run.working)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text("This app pairs with it as its own client. It is your account on this Mac, so there is no code to compare.")
                }
                Section {
                    Button("Pair with Another Node Instead…") { elsewhere = true }.disabled(run.working)
                }
            }
            .formStyle(.grouped)
            .frame(maxWidth: 600)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var lines: String {
        let config = try? NodeHome.standard.config()
        let name = config.map { "It is \($0.name), with its home in ~/.invincible." } ?? "Its home is ~/.invincible."
        return "\(name) This app can be its client too, and show you how it is kept running."
    }
}
#endif
