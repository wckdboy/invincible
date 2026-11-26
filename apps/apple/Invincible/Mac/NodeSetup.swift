#if os(macOS)
import Foundation
import Observation

/// Making this Mac a node, as the first run's buttons do it and `the primary --first-run` does it with no window: the node
/// founded or joined by the bundled CLI, run as this app; its agent registered; the node answering; this app paired with
/// it; and, on a Mac with no battery, the Mac kept awake while its node runs. Each stage is said as it begins.
@MainActor struct NodeSetup {
    enum Stage: Equatable, Sendable {
        case founding(fleet: String)
        /// Joining: the code to compare, once the node that invited this Mac has answered.
        case joining(code: String?)
        case registering
        /// Waiting for you in System Settings → General → Login Items.
        case approving
        case starting
        case pairing
        case keepingAwake

        /// What the window says, and `--first-run` prints.
        var words: String {
            switch self {
            case .founding(let fleet): "Founding the fleet \(fleet)…"
            case .joining(nil): "Asking your fleet to let this Mac in…"
            case .joining(let code?): "Your code is \(code). Approve this Mac on the node that invited it, only if that node shows the same code."
            case .registering: "Setting the node to run at login…"
            case .approving: "macOS asks you first: allow Invincible in System Settings → General → Login Items."
            case .starting: "Starting the node. It measures this Mac first, which takes a few seconds…"
            case .pairing: "Pairing this app with its node…"
            case .keepingAwake: "Keeping this Mac awake while its node runs…"
            }
        }
    }

    struct Failed: LocalizedError {
        let errorDescription: String?
    }

    var bundle = NodeBundle.main
    var home = NodeHome.standard
    var agent = NodeAgent()
    let say: @MainActor (Stage) -> Void

    /// What this Mac is called in the fleet unless you name it: its short host name, as install.sh takes it.
    nonisolated static func defaultName(host: String = hostName()) -> String {
        let short = host.split(separator: ".").first.map(String.init) ?? ""
        let name = String(short.unicodeScalars.map { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_") ? Character($0) : "-" }).prefix(40)
        return name.isEmpty ? "mac" : String(name)
    }

    nonisolated static func hostName() -> String {
        var name = [CChar](repeating: 0, count: 256)
        guard gethostname(&name, name.count) == 0 else { return "" }
        return String(decoding: name.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    /// Why this app can't make this Mac a node from where it is now, or nil when it can.
    var unready: String? {
        if !bundle.carriesNode { return "This build of Invincible carries no node (it is made with mac-node-bundle.sh): it can be your client, not a node." }
        switch bundle.place {
        case .applications: break
        case .translocated, .diskImage, .elsewhere: return "Invincible runs your node from where the app is, so it needs to be in your Applications folder first."
        }
        return nil
    }

    /// Start a fleet: `invincible init --name … --fleet …`.
    func found(name: String, fleet: String) async throws {
        say(.founding(fleet: fleet))
        let ran = try await bundle.cli(["init", "--name", name, "--fleet", fleet])
        guard ran.succeeded else { throw Failed(errorDescription: ran.lastLine) }
    }

    /// Join my fleet: `invincible join <invite> --name …`, which waits for your approval on the node that invited this Mac,
    /// given once the two codes match.
    func join(invite: String, name: String) async throws {
        say(.joining(code: nil))
        let said = say
        let ran = try await bundle.cli(["join", invite.trimmingCharacters(in: .whitespacesAndNewlines), "--name", name]) { line in
            if let code = Self.code(in: line) { Task { @MainActor in said(.joining(code: code)) } }
        }
        guard ran.succeeded else { throw Failed(errorDescription: ran.lastLine) }
    }

    /// The code `invincible join` shows to compare.
    nonisolated static func code(in line: String) -> String? {
        line.firstMatch(of: #/Confirmation code:\s+(\d{3} \d{3})/#).map { String($0.1) }
    }

    /// Then: its agent registered (and allowed, where macOS asks), the node answering, and this app paired with it. A
    /// node install.sh made keeps its own service, and this app pairs with it as it runs.
    func serve(app: AppModel) async throws -> WhoAmI {
        if !NodeAgent.installedByScript, agent.state != .on {
            say(.registering)
            do {
                try agent.register()
            } catch {
                // Registered but not allowed yet reads as an error too: the state says which.
                guard agent.state == .needsApproval else { throw Failed(errorDescription: "macOS didn't let the node's service run: \(error.localizedDescription)") }
            }
            if agent.state == .needsApproval {
                say(.approving)
                while agent.state == .needsApproval { try await Task.sleep(for: .seconds(1)) }
            }
            guard agent.state == .on else { throw Failed(errorDescription: "The node's service isn't allowed to run: turn Invincible on in System Settings → General → Login Items.") }
        }
        say(.starting)
        let admin = try LocalAdmin(home: home)
        let me = try await admin.answering(within: 120)
        say(.pairing)
        try await pair(app: app, admin: admin, me: me)
        return me
    }

    /// This app, paired with its own node.
    func pair(app: AppModel, admin: LocalAdmin, me: WhoAmI) async throws {
        let key = try DeviceKey.load() ?? DeviceKey.create()
        let name = "Invincible app on \(me.nodeName)"
        var node: PairedNode
        do {
            node = try await SelfPairing.pair(admin: admin, origin: admin.origin, transport: NodePairTransport(origin: admin.origin), device: key.device, name: name)
        } catch Joining.Stop.alreadyEnrolled {
            // This Mac's key is in the fleet already (paired with another of its nodes before): a signed request says
            // whether this node takes it.
            _ = try await NodeClient(origin: admin.origin, signer: key).get("/api/whoami", as: WhoAmI.self)
            node = PairedNode(origin: admin.origin, device: key.device, name: name, fleet: me.fleet ?? "")
        }
        (node.nodeName, node.fleetName) = (me.nodeName, me.fleetName)
        app.paired(key: key, node: node)
    }

    /// Keep it on: the node keeps this Mac from sleeping (`invincible awake on`) from its next start, which is now.
    func keepAwake() async throws {
        say(.keepingAwake)
        let ran = try await bundle.cli(["awake", "on"])
        guard ran.succeeded else { throw Failed(errorDescription: ran.lastLine) }
        if !NodeAgent.installedByScript { try await agent.restart() }
        _ = try await LocalAdmin(home: home).answering(within: 120)
    }
}

/// The first run, on a Mac that isn't a node and isn't paired: one window, three steps (docs/MAC.md, "The screens"). Make
/// this Mac a node (start a fleet, join yours, or just the app); keep it on; give its agents VMs.
@MainActor @Observable final class FirstRun {
    enum Step: Int, CaseIterable, Comparable {
        case node = 1, stayOn, vms

        static func < (a: Step, b: Step) -> Bool { a.rawValue < b.rawValue }

        var title: String {
            switch self {
            case .node: "Make this Mac a node"
            case .stayOn: "Keep it on"
            case .vms: "Give its agents VMs"
            }
        }
    }

    enum Way: Hashable { case start, join, client }

    /// Whether it holds the main window.
    var active = false
    var step = Step.node
    var way = Way.start
    var name = NodeSetup.defaultName()
    var fleet = "homelab"
    var invite = ""
    /// What it is doing now; nil while it waits for you.
    private(set) var stage: NodeSetup.Stage?
    private(set) var problem: String?
    /// The node answered, as its owner here: its name, its fleet's.
    private(set) var node: WhoAmI?
    private var task: Task<Void, Never>?

    /// What was chosen at step 1, once it was done: `node`, or `client` (just the app).
    static let chosen = "sh.invincible.bot.mac.first-run"

    /// Wanted on a Mac that isn't a node, by an app that isn't paired and hasn't been through it.
    static func wanted(paired: Bool, home: NodeHome = .standard, defaults: UserDefaults = .standard) -> Bool {
        !paired && !home.exists && defaults.string(forKey: chosen) == nil
    }

    var working: Bool { task != nil }

    var canGo: Bool {
        guard !working, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        switch way {
        case .start: return !fleet.trimmingCharacters(in: .whitespaces).isEmpty
        case .join: return invite.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("gi1.")
        case .client: return true
        }
    }

    /// Opened again from This Mac: Make this Mac a node.
    func begin() {
        (active, step, problem, stage) = (true, .node, nil, nil)
    }

    /// Step 1's button: the chosen way. The app alone ends the first run here, at joining a fleet as its client.
    func go(app: AppModel, setup: NodeSetup? = nil) {
        guard canGo else { return }
        if way == .client {
            UserDefaults.standard.set("client", forKey: Self.chosen)
            active = false
            return
        }
        problem = nil
        let setup = setup ?? NodeSetup { [weak self] stage in self?.stage = stage }
        let (way, name, fleet, invite) = (way, name.trimmingCharacters(in: .whitespaces), fleet.trimmingCharacters(in: .whitespaces), invite)
        task = Task {
            defer { (task, stage) = (nil, nil) }
            do {
                if way == .start { try await setup.found(name: name, fleet: fleet) } else { try await setup.join(invite: invite, name: name) }
                node = try await setup.serve(app: app)
                UserDefaults.standard.set("node", forKey: Self.chosen)
                step = StayingOnReading.hasBattery ? .vms : .stayOn
                if step == .stayOn { try await setup.keepAwake() }
            } catch is CancellationError {
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    /// Already a node (install.sh made it, or the app was asked to forget its key): this app paired with it as it runs.
    func open(app: AppModel) {
        guard !working else { return }
        problem = nil
        let setup = NodeSetup { [weak self] stage in self?.stage = stage }
        task = Task {
            defer { (task, stage) = (nil, nil) }
            do {
                node = try await setup.serve(app: app)
            } catch is CancellationError {
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }

    func next() {
        guard !working else { return }
        problem = nil
        if let later = Step(rawValue: step.rawValue + 1) { step = later } else { active = false }
    }
}
#endif
