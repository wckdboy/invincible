#if os(macOS)
import Darwin
import Foundation
import ServiceManagement

/*
 * The node inside the app (docs/MAC.md, M2): what the app carries of it (scripts/mac-node-bundle.sh puts it there), its
 * home (~/.invincible, the CLI's and the node's, as on Linux), the launchd agent the app registers for it, the bundled CLI
 * run as this app, and the node spoken to as its owner on this Mac.
 */

/// What this app carries of the node: the pinned Bun, the node at one revision, and its agent. A build without them
/// (an everyday one: the bundling is a release step) is the client alone.
struct NodeBundle: Sendable {
    let app: URL

    static let main = NodeBundle(app: Bundle.main.bundleURL)

    var bun: URL { app.appending(path: "Contents/Helpers/bun") }
    var node: URL { app.appending(path: "Contents/Resources/node") }
    var cli: URL { node.appending(path: "packages/node/src/cli.ts") }
    var agent: URL { app.appending(path: "Contents/Library/LaunchAgents/\(NodeAgent.plist)") }

    /// Whether this build carries the node at all.
    var carriesNode: Bool {
        FileManager.default.isExecutableFile(atPath: bun.path) && FileManager.default.fileExists(atPath: cli.path) && FileManager.default.fileExists(atPath: agent.path)
    }

    /// The node's revision as it was bundled (its REVISION file), or nil.
    var revision: String? {
        (try? String(contentsOf: node.appending(path: "REVISION"), encoding: .utf8)).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Where the app runs from, which is where launchd will run the node from.
    enum Place: Equatable, Sendable {
        /// An Applications folder: where it stays.
        case applications
        /// A read-only copy macOS made of a download opened where it was (App Translocation): gone at the next restart.
        case translocated
        /// A disk image, gone once it is ejected.
        case diskImage
        /// Anywhere else (Downloads, a build folder).
        case elsewhere
    }

    var place: Place { Self.place(of: app.path, home: FileManager.default.homeDirectoryForCurrentUser.path) }

    static func place(of path: String, home: String) -> Place {
        if path.contains("/AppTranslocation/") { return .translocated }
        if path.hasPrefix("/Volumes/") { return .diskImage }
        if path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/") { return .applications }
        return .elsewhere
    }

    /// Where Homebrew, Tailscale's command line and Apple's `container` put their commands, then the system's: the node's
    /// PATH as a service, as install.sh's agent has it (launchd gives an agent only the system's own).
    static let servicePath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    /// The PATH the CLI runs with: yours, with the service's directories it lacks after it.
    static func path(_ yours: String?) -> String {
        var parts = (yours ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        for standard in servicePath.split(separator: ":").map(String.init) where !parts.contains(standard) {
            parts.append(standard)
        }
        return parts.joined(separator: ":")
    }

    /// Becomes the bundled Bun running the bundled CLI with these arguments (exec: launchd keeps one process). With a
    /// `log`, its output goes there and it runs in the node's folder, as the node's service; without, it is the CLI where
    /// it was asked for. Never returns.
    func become(_ arguments: [String], log: URL?) -> Never {
        if let log {
            try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let fd = open(log.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
            if fd >= 0 {
                dup2(fd, STDOUT_FILENO)
                dup2(fd, STDERR_FILENO)
                close(fd)
            }
            FileManager.default.changeCurrentDirectoryPath(node.path)
        }
        setenv("PATH", log != nil ? Self.servicePath : Self.path(ProcessInfo.processInfo.environment["PATH"]), 1)
        let argv = ([bun.path, cli.path] + arguments).map { strdup($0) } + [nil]
        execv(bun.path, argv)
        perror("Invincible: can't run \(bun.path)")
        exit(127)
    }

    /// The bundled CLI, run as this app: in your session, so `init` and `join` keep the node's keys in your Keychain (over
    /// SSH they would fall back to a file). The lines it prints go to `line` as they come.
    func cli(_ arguments: [String], line: (@Sendable (String) -> Void)? = nil) async throws -> Ran {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Self.path(environment["PATH"])
        return try await Command.run(bun, [cli.path] + arguments, environment: environment, line: line)
    }

    /// The two lines `~/.local/bin/invincible` holds: the bundled Bun on the bundled CLI.
    var command: String {
        "#!/bin/sh\nexec \(Self.quoted(bun.path)) \(Self.quoted(cli.path)) \"$@\"\n"
    }

    private static func quoted(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}

/// The node's home, `~/.invincible`, as the node lays it out (packages/node/src/home.ts).
struct NodeHome: Sendable {
    let dir: URL

    /// Where this Mac's node lives, as the node finds its own home (home.ts): INVINCIBLE_HOME where it is set, else ~/.invincible.
    static let standard = NodeHome(dir: dir(environment: ProcessInfo.processInfo.environment))

    static func dir(environment: [String: String], user: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let set = environment["INVINCIBLE_HOME"], !set.isEmpty { return URL(fileURLWithPath: set) }
        return user.appending(path: ".invincible")
    }

    var configFile: URL { dir.appending(path: "config.json") }
    var adminTokenFile: URL { dir.appending(path: "admin.token") }
    var log: URL { dir.appending(path: "logs/node.log") }

    /// Whether this Mac is a node: it has been founded or joined (`invincible init`, `invincible join`).
    var exists: Bool { FileManager.default.fileExists(atPath: configFile.path) }

    /// What the app reads of the node's config.json (the node keeps more).
    struct Config: Decodable, Sendable, Equatable {
        let name: String
        let fleet: String?
        let port: Int
        let keystore: String
        /// The node keeps this Mac awake while it runs (`invincible awake on`). Absent: off.
        var keepAwake: Bool?
    }

    func config() throws -> Config {
        try JSONDecoder().decode(Config.self, from: Data(contentsOf: configFile))
    }

    struct Refused: LocalizedError {
        let errorDescription: String?
    }

    /// The node's local admin credential, read only when this account alone can read it: anyone else who could would be
    /// this node's owner.
    func adminToken() throws -> String {
        let attributes = try FileManager.default.attributesOfItem(atPath: adminTokenFile.path)
        let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
        let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
        guard mode & 0o077 == 0, owner == getuid() else {
            throw Refused(errorDescription: "\(adminTokenFile.path) can be read by other accounts on this Mac, so it isn't used. Delete it and restart the node, which makes a new one only you can read.")
        }
        let token = try String(contentsOf: adminTokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.hasPrefix("adm_") else { throw Refused(errorDescription: "\(adminTokenFile.path) doesn't hold a node's admin credential.") }
        return token
    }

    /// The last `count` lines of the node's log.
    func tail(_ count: Int = 200) -> String {
        guard let handle = try? FileHandle(forReadingFrom: log) else { return "" }
        defer { try? handle.close() }
        // The end of it is enough: a long log is read from its last 64 KB.
        let size = (try? handle.seekToEnd()) ?? 0
        let from = size > 65_536 ? size - 65_536 : 0
        try? handle.seek(toOffset: from)
        var lines = String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
        // Not the line the read began inside, nor the nothing after the last newline.
        if from > 0, !lines.isEmpty { lines.removeFirst() }
        if lines.last?.isEmpty == true { lines.removeLast() }
        return lines.suffix(count).joined(separator: "\n")
    }
}

/// The node's launchd agent: the plist inside the app, registered by the app with SMAppService under the label install.sh
/// uses (so a node install.sh made is taken over, not doubled). launchd runs the app's binary with --serve-node.
struct NodeAgent: Sendable {
    static let label = "sh.invincible.node"
    static let plist = "\(label).plist"

    enum State: Equatable, Sendable {
        case off
        case on
        /// Registered, and waiting for you in System Settings → General → Login Items.
        case needsApproval
    }

    /// SMAppService's status in the app's words. Before its first registration an agent reads `notFound` rather than
    /// `notRegistered` (seen on macOS 27.2), which is the same thing here.
    static func state(_ status: SMAppService.Status) -> State {
        switch status {
        case .enabled: .on
        case .requiresApproval: .needsApproval
        case .notRegistered, .notFound: .off
        @unknown default: .off
        }
    }

    /// The plist install.sh writes for a service of its own under the same label. While it is there, that service runs
    /// the node, and this app pairs with it and shows it rather than register a second one.
    static var scriptPlist: URL { FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/LaunchAgents/\(plist)") }
    static var installedByScript: Bool { FileManager.default.fileExists(atPath: scriptPlist.path) }

    private var service: SMAppService { SMAppService.agent(plistName: Self.plist) }

    var state: State { Self.state(service.status) }

    func register() throws { try service.register() }

    func unregister() async throws { try await service.unregister() }

    func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }

    private static var target: String { "gui/\(getuid())/\(label)" }

    /// Stops the node and starts it again (launchctl kickstart -k): after a change to its config, or on a new release.
    func restart() async throws {
        let ran = try await Command.run(URL(filePath: "/bin/launchctl"), ["kickstart", "-k", Self.target])
        guard ran.succeeded else { throw NodeHome.Refused(errorDescription: "launchd didn't restart the node: \(ran.lastLine)") }
    }

    /// The node's process now, as launchd says (nil when it isn't running).
    func pid() async -> Int32? {
        guard let ran = try? await Command.run(URL(filePath: "/bin/launchctl"), ["print", Self.target]), ran.succeeded else { return nil }
        return Self.pid(in: ran.output)
    }

    /// The pid in `launchctl print`'s description of a service.
    static func pid(in printed: String) -> Int32? {
        printed.firstMatch(of: #/(?m)^\s*pid = (\d+)\s*$/#).flatMap { Int32($0.1) }
    }

    /// When a process of this account's started (the kernel's own record).
    static func started(_ pid: Int32) -> Date? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        return start.tv_sec > 0 ? Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000) : nil
    }
}

/// A command, run to its end: how it ended and what it printed (its output and its errors, as they came).
struct Ran: Sendable {
    let status: Int32
    let output: String

    var succeeded: Bool { status == 0 }

    /// The last thing it said: why a failed command failed, as it put it.
    var lastLine: String {
        output.split(separator: "\n").map { Command.plain(String($0)).trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? "it ended with \(status)"
    }
}

enum Command {
    /// Runs `executable` with `arguments`, each line it prints passed to `line` as it comes. Cancelling the task stops it.
    static func run(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil, line: (@Sendable (String) -> Void)? = nil) async throws -> Ran {
        let running = Running()
        let process = running.process
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        let ended = AsyncStream<Int32> { continuation in
            process.terminationHandler = { finished in
                continuation.yield(finished.terminationStatus)
                continuation.finish()
            }
        }
        try process.run()
        return try await withTaskCancellationHandler {
            var output = ""
            for try await text in pipe.fileHandleForReading.bytes.lines {
                output += text + "\n"
                line?(plain(text))
            }
            var status: Int32 = -1
            for await code in ended { status = code }
            try Task.checkCancellation()
            return Ran(status: status, output: output)
        } onCancel: {
            running.process.terminate()
        }
    }

    /// A line with a terminal's colours taken out.
    static func plain(_ text: String) -> String { text.replacing(#/\u{1B}\[[0-9;]*[A-Za-z]/#, with: "") }

    private final class Running: @unchecked Sendable {
        let process = Process()
    }
}

/// This Mac's own node, spoken to as its owner here: on loopback with its local admin credential, which the node takes
/// nowhere else (packages/node/src/server.ts). Nothing it answers is cached, and no redirect is followed.
struct LocalAdmin: Sendable {
    let origin: URL
    let token: String

    init(origin: URL, token: String) {
        self.origin = origin
        self.token = token
    }

    init(home: NodeHome) throws {
        let config = try home.config()
        guard let origin = URL(string: "http://127.0.0.1:\(config.port)") else { throw NodeHome.Refused(errorDescription: "The node's config names no port it can be reached on.") }
        try self.init(origin: origin, token: home.adminToken())
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self, timeout: TimeInterval = 10) async throws -> T {
        try decode(await send("GET", path, body: nil, timeout: timeout))
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable, as type: T.Type = T.self, timeout: TimeInterval = 30) async throws -> T {
        try decode(await send("POST", path, body: JSONEncoder().encode(body), timeout: timeout))
    }

    /// Waits for the node to answer (it measures this Mac as it starts): asks every half second for up to `seconds`.
    func answering(within seconds: Double) async throws -> WhoAmI {
        let end = Date.now.addingTimeInterval(seconds)
        while true {
            do {
                return try await get("/api/whoami", timeout: 3)
            } catch let error as NodeError where error.status == 0 || error.unreachable {
                guard Date.now < end else { throw NodeHome.Refused(errorDescription: "The node didn't answer within \(Int(seconds)) s. Its log says why.") }
                try await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private func send(_ method: String, _ path: String, body: Data?, timeout: TimeInterval) async throws -> Data {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL else { throw NodeError(status: 0, message: "\(path) isn't a path on the node") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        do {
            let (data, response) = try await NodeClient.session.data(for: request)
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                let headers = (http?.allHeaderFields ?? [:]).reduce(into: [String: String]()) { headers, field in
                    if let name = field.key as? String, let value = field.value as? String { headers[name.lowercased()] = value }
                }
                throw NodeError.from(status: status, headers: headers, body: data)
            }
            return data
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw NodeError(status: 0, message: "Nothing answers on \(origin.absoluteString): the node isn't running.", unreachable: true)
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NodeError(status: 200, message: "The node's answer wasn't what this app reads (\(error.localizedDescription)).")
        }
    }
}

/// What making an invite and approving a device take: this Mac's node, as its owner (LocalAdmin), or a stand-in in tests.
protocol PairingAdmin: Sendable {
    /// A one-time client invite (`gi1.…`) for devices that reach the node at `origin`.
    func clientInvite(origin: URL) async throws -> String
    func approve(invite: String, device: String) async throws
}

extension LocalAdmin: PairingAdmin {
    func clientInvite(origin: URL) async throws -> String {
        struct Asked: Encodable { let kind = "client"; let origin: String }
        struct Made: Decodable { let invite: String }
        return try await post("/api/invites", Asked(origin: origin.absoluteString), as: Made.self).invite
    }

    func approve(invite: String, device: String) async throws {
        struct Answer: Encodable { let invite: String; let device: String }
        _ = try await post("/api/pairings/approve", Answer(invite: invite, device: device), as: JSONValue.self)
    }
}

/// This app paired with the node on its own Mac. It is the same account on the same machine, so there is no code for you
/// to compare: the app makes the invite and approves its own request with the node's admin credential. Everything else is
/// pairing as any device pairs: the node's code must be this app's own, and its approval counts only with its proof.
enum SelfPairing {
    /// Pairs `device` (this app's key's) as `name`: approved only once the node's code for it is this app's own.
    static func pair(admin: some PairingAdmin, origin: URL, transport: some PairTransport, device: String, name: String) async throws -> PairedNode {
        let invite = try await Invite.decode(admin.clientInvite(origin: origin))
        let joining = Joining(invite: invite, device: device, transport: transport)
        try await joining.ask(name: name)
        try await admin.approve(invite: invite.i, device: device)
        try await joining.approval()
        return PairedNode(origin: origin, device: device, name: name, fleet: invite.f)
    }
}
#endif
