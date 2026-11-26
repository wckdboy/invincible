#if os(macOS)
import Foundation
import IOKit.ps

/// Staying on (docs/MAC.md, "A Mac that stays on"): what a node on a Mac needs to be there when you aren't, each read live
/// from the Mac, with what is missing when it doesn't hold. The app reads these and never changes them: each line's
/// button opens the pane of System Settings that does, or, for what is the node's own (its service, keeping awake,
/// publishing on your tailnet), asks the node.
struct StayingOn: Equatable, Sendable {
    enum Item: String, CaseIterable, Sendable {
        case runsAtLogin, logsIn, staysAwake, startsAfterPowerCut, reachable

        var title: String {
            switch self {
            case .runsAtLogin: "Runs at login"
            case .logsIn: "Logs in by itself"
            case .staysAwake: "Doesn't sleep"
            case .startsAfterPowerCut: "Starts after a power cut"
            case .reachable: "Reachable from anywhere"
            }
        }
    }

    /// What puts it right: a pane of System Settings, or the node's own doing.
    enum Fix: Equatable, Sendable {
        case loginItems, runAtLogin, usersAndGroups, fileVault, keepAwake, restart, energy, publish, openTailscale, getTailscale
    }

    struct Line: Identifiable, Equatable, Sendable {
        let item: Item
        /// true: it holds; false: something is missing, which `said` says; nil: this Mac can't tell.
        let holds: Bool?
        let said: String
        var fix: Fix? = nil
        var id: Item { item }
    }

    var lines: [Line]

    var holding: Int { lines.count { $0.holds == true } }
}

/// Tailscale on this Mac, as the node needs it: its command on the node's PATH, signed in, and the app published.
enum Tailscale: Equatable, Sendable {
    /// Not installed.
    case absent
    /// The app, without the command line the node runs (`tailscale`).
    case noCommand
    /// Installed, not running or not signed in: its own word for it (NeedsLogin, Stopped…).
    case off(String)
    /// Running: this Mac's name on your tailnet, and where the primary is published there (nil: it isn't).
    case on(name: String?, published: String?)

    /// Where its command is, where the node's PATH looks (Homebrew's, or the one Tailscale's app installs).
    static let commands = ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    static let app = URL(filePath: "/Applications/Tailscale.app")
    static let download = URL(string: "https://tailscale.com/download/mac")!
}

extension StayingOn {
    static func runsAtLogin(_ state: NodeAgent.State) -> Line {
        switch state {
        case .on: Line(item: .runsAtLogin, holds: true, said: "Its service starts at login, and launchd keeps it running.")
        case .needsApproval: Line(item: .runsAtLogin, holds: false, said: "Waiting for you to allow Invincible in Login Items.", fix: .loginItems)
        case .off: Line(item: .runsAtLogin, holds: false, said: "Its service isn't set to run.", fix: .runAtLogin)
        }
    }

    /// Automatic login, which FileVault turns off (the owner's choice for a Mac mini: FileVault off, docs/MAC.md).
    static func logsIn(autoLogin: String?, me: String, fileVault: Bool?) -> Line {
        if fileVault == true {
            return Line(item: .logsIn, holds: false, said: "FileVault is on, so after a restart this Mac waits for its password, and the node with it.", fix: .fileVault)
        }
        switch autoLogin {
        case me?: return Line(item: .logsIn, holds: true, said: "After a restart it logs in as \(me) by itself.")
        case let other?: return Line(item: .logsIn, holds: false, said: "It logs in by itself as \(other), and the node is \(me)'s.", fix: .usersAndGroups)
        case nil: return Line(item: .logsIn, holds: false, said: "After a restart it waits at the login window: turn on automatic login for \(me).", fix: .usersAndGroups)
        }
    }

    /// The node's own keep-awake (`invincible awake on`), and whether the running node says it holds it.
    static func staysAwake(set: Bool, held: Bool?) -> Line {
        switch (set, held) {
        case (true, false?): Line(item: .staysAwake, holds: false, said: "Set, but the running node isn't holding it yet: it holds it from its next start.", fix: .restart)
        case (true, _): Line(item: .staysAwake, holds: true, said: "The node keeps it from sleeping while it runs; the display may sleep.")
        case (false, _): Line(item: .staysAwake, holds: false, said: "It may sleep, and the node with it.", fix: .keepAwake)
        }
    }

    static func startsAfterPowerCut(_ autorestart: Bool?) -> Line {
        switch autorestart {
        case true?: Line(item: .startsAfterPowerCut, holds: true, said: "It starts by itself when the power comes back.")
        case false?: Line(item: .startsAfterPowerCut, holds: false, said: "After a power cut it stays off until its button is pressed.", fix: .energy)
        case nil: Line(item: .startsAfterPowerCut, holds: nil, said: "This Mac doesn't offer it.")
        }
    }

    static func reachable(_ tailscale: Tailscale) -> Line {
        switch tailscale {
        case .absent: Line(item: .reachable, holds: false, said: "Install Tailscale here and on your iPhone, and sign in to both.", fix: .getTailscale)
        case .noCommand: Line(item: .reachable, holds: false, said: "Tailscale is here, but not its command line, which the node uses: install it from Tailscale's settings.", fix: .openTailscale)
        case .off(let state): Line(item: .reachable, holds: false, said: "Tailscale isn't on (\(state)): open it and sign in.", fix: .openTailscale)
        case .on(_, let published?): Line(item: .reachable, holds: true, said: "Published on your tailnet at \(published).")
        case .on(let name, nil): Line(item: .reachable, holds: false, said: "Tailscale is on\(name.map { " as \($0)" } ?? ""), but Invincible isn't published on your tailnet yet.", fix: .publish)
        }
    }
}

/// Reading each of them from the Mac: the parsers are pure, for the tests; `read` asks the Mac.
enum StayingOnReading {
    /// `autoLoginUser` in loginwindow's preferences (/Library/Preferences/com.apple.loginwindow.plist), which any account may read.
    static func autoLoginUser(plist: Data) -> String? {
        guard let object = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let user = object["autoLoginUser"] as? String, !user.isEmpty else { return nil }
        return user
    }

    /// FileVault after the next restart, which is what automatic login waits on, as `fdesetup status` says it: "FileVault is
    /// On." or "FileVault is Off.", with more after while it works ("…, but will be enabled after the next restart.").
    static func fileVault(_ status: String) -> Bool? {
        if status.contains("FileVault is On") || status.contains("will be enabled") { return true }
        if status.contains("FileVault is Off") { return false }
        return nil
    }

    /// Start up automatically after a power failure, as `pmset -g` lists it (`autorestart 1`); nil where it isn't listed,
    /// as on a Mac with a battery or a virtual one.
    static func autorestart(pmset: String) -> Bool? {
        pmset.firstMatch(of: #/(?m)^\s*autorestart\s+(\d+)/#).map { $0.1 != "0" }
    }

    /// `tailscale status --json --self --peers=false`: running or not, and this Mac's name on the tailnet.
    static func tailscale(status: Data) -> (running: Bool, state: String, name: String?)? {
        struct Status: Decodable {
            struct Me: Decodable { let DNSName: String? }
            let BackendState: String?
            let me: Me?
            enum CodingKeys: String, CodingKey { case BackendState, me = "Self" }
        }
        guard let status = try? JSONDecoder().decode(Status.self, from: status), let state = status.BackendState else { return nil }
        let name = status.me?.DNSName.map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }.flatMap { $0.isEmpty ? nil : $0 }
        return (state == "Running", state, name)
    }

    /// Where `tailscale serve status --json` publishes the node's proxy port (`invincible expose`): its https origin, the port
    /// left out when it is 443 (packages/node/src/capabilities.ts, servedOriginFrom).
    static func published(serve: Data, proxyPort: Int) -> String? {
        struct Serve: Decodable {
            struct Web: Decodable {
                struct Handler: Decodable { let Proxy: String? }
                let Handlers: [String: Handler]?
            }
            let Web: [String: Web]?
        }
        guard let serve = try? JSONDecoder().decode(Serve.self, from: serve) else { return nil }
        let targets = Set(["127.0.0.1", "localhost", "[::1]"].flatMap { host in ["http", "https"].flatMap { ["\($0)://\(host):\(proxyPort)", "\($0)://\(host):\(proxyPort)/"] } })
        for (hostPort, web) in (serve.Web ?? [:]).sorted(by: { $0.key < $1.key }) where (web.Handlers ?? [:]).values.contains(where: { $0.Proxy.map(targets.contains) ?? false }) {
            let parts = hostPort.split(separator: ":")
            guard let host = parts.first else { continue }
            return parts.count > 1 && parts.last != "443" ? "https://\(host):\(parts.last!)" : "https://\(host)"
        }
        return nil
    }

    /// Whether this Mac has a battery: a laptop works while it's open, and skips staying on.
    static var hasBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return false }
        return sources.contains { source in
            let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any]
            return description?[kIOPSTypeKey] as? String == kIOPSInternalBatteryType
        }
    }

    /// Tailscale as it is now.
    static func tailscale(proxyPort: Int) async -> Tailscale {
        guard let command = Tailscale.commands.first(where: FileManager.default.isExecutableFile) else {
            return FileManager.default.fileExists(atPath: Tailscale.app.path) ? .noCommand : .absent
        }
        let tool = URL(filePath: command)
        guard let ran = try? await Command.run(tool, ["status", "--json", "--self", "--peers=false"]),
              let status = tailscale(status: Data(ran.output.utf8)) else { return .off("not answering") }
        guard status.running else { return .off(status.state) }
        let serve = try? await Command.run(tool, ["serve", "status", "--json"])
        return .on(name: status.name, published: serve.flatMap { published(serve: Data($0.output.utf8), proxyPort: proxyPort) })
    }

    /// Everything, now: the node's service as SMAppService says, the rest from the Mac, and keep-awake from the node.
    static func read(agent: NodeAgent.State, home: NodeHome, admin: LocalAdmin?) async -> StayingOn {
        let config = try? home.config()
        let loginwindow = (try? Data(contentsOf: URL(filePath: "/Library/Preferences/com.apple.loginwindow.plist"))).flatMap(autoLoginUser)
        async let fileVault = try? Command.run(URL(filePath: "/usr/bin/fdesetup"), ["status"])
        async let pmset = try? Command.run(URL(filePath: "/usr/bin/pmset"), ["-g"])
        async let tailscale = tailscale(proxyPort: (config?.port ?? 7777) + 1)
        async let held = heldAwake(admin)
        return await StayingOn(lines: [
            StayingOn.runsAtLogin(agent),
            StayingOn.logsIn(autoLogin: loginwindow, me: NSUserName(), fileVault: fileVault.flatMap { self.fileVault($0.output) }),
            StayingOn.staysAwake(set: config?.keepAwake == true, held: held),
            StayingOn.startsAfterPowerCut(pmset.flatMap { autorestart(pmset: $0.output) }),
            StayingOn.reachable(tailscale),
        ])
    }

    /// Whether the running node says it keeps this Mac awake (its capabilities' `awake`); nil when it hasn't said, or
    /// doesn't answer.
    static func heldAwake(_ admin: LocalAdmin?) async -> Bool? {
        guard let admin else { return nil }
        return try? await awakeHeld(admin)
    }

    static func awakeHeld(_ admin: LocalAdmin) async throws -> Bool? {
        struct Fleet: Decodable {
            struct Device: Decodable {
                struct Caps: Decodable { let awake: Bool? }
                let id: String
                let caps: Caps?
            }
            let `self`: String
            let devices: [Device]
        }
        let fleet = try await admin.get("/api/fleet", as: Fleet.self)
        guard let caps = fleet.devices.first(where: { $0.id == fleet.`self` })?.caps else { return nil }
        return caps.awake ?? false
    }
}
#endif
