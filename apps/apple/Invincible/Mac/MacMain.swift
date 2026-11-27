#if os(macOS)
import Foundation

/*
 * The app's binary is the node's launcher too (docs/MAC.md, M2). launchd starts it with --serve-node (its agent's
 * BundleProgram), and it becomes the bundled Bun running the bundled node; --cli is the bundled CLI. What a terminal asks
 * of the app, or a Mac with no screen to click (the VM it is tried in), runs here with no window, through the code the
 * app's buttons run. Anything else is the app.
 *
 *   Invincible --serve-node                                          the node, its output in ~/.invincible/logs/node.log
 *   Invincible --cli <arguments>                                     the bundled CLI: Invincible --cli doctor
 *   Invincible --agent [status | register | unregister | restart]    the node's agent
 *   Invincible --this-mac                                            what This Mac shows: the node, and staying on
 *   Invincible --first-run start [--name <name>] [--fleet <fleet>]   Start a fleet, then keep it on, as the first run does
 *   Invincible --first-run join <invite> [--name <name>]             Join my fleet, then keep it on
 *   Invincible --desktop <op> …                                      This Mac's screen, as the primary's computer (MacScreen.swift)
 */
@main
enum MacMain {
    @MainActor static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        switch arguments.first {
        case "--serve-node": NodeBundle.main.become(["serve"], log: NodeHome.standard.log)
        case "--cli": NodeBundle.main.become(Array(arguments.dropFirst()), log: nil)
        case "--agent", "--first-run", "--this-mac":
            // Each line as it is said, even into a file (open --stdout).
            setvbuf(stdout, nil, _IOLBF, 0)
            Task { exit(await Headless.run(arguments)) }
            dispatchMain()
        case "--desktop":
            Task { exit(await MacScreen.run(Array(arguments.dropFirst()))) }
            dispatchMain()
        default: InvincibleMacApp.main()
        }
    }
}

/// The app's work with no window.
@MainActor enum Headless {
    static func run(_ arguments: [String]) async -> Int32 {
        let agent = NodeAgent()
        switch (arguments.first, arguments.dropFirst().first) {
        case ("--agent", nil), ("--agent", "status"?):
            print("the node's agent (\(NodeAgent.label)): \(words(agent.state))")
            return 0
        case ("--agent", "register"?):
            do {
                try agent.register()
            } catch where agent.state == .needsApproval {
            } catch {
                print("not registered: \(error.localizedDescription) (\(words(agent.state)))")
                return 1
            }
            print("registered: \(words(agent.state))")
            return agent.state == .on ? 0 : 1
        case ("--agent", "unregister"?):
            do {
                try await agent.unregister()
                print("unregistered: \(words(agent.state))")
                return 0
            } catch {
                print("not unregistered: \(error.localizedDescription)")
                return 1
            }
        case ("--agent", "restart"?):
            do {
                try await agent.restart()
                print("restarted")
                return 0
            } catch {
                print(error.localizedDescription)
                return 1
            }
        case ("--first-run", let way?) where way == "start" || way == "join":
            return await firstRun(way, Array(arguments.dropFirst(2)))
        case ("--this-mac", nil):
            return await thisMac()
        default:
            print("usage: Invincible --agent [status|register|unregister|restart] | --first-run start [--name <name>] [--fleet <fleet>] | --first-run join <invite> [--name <name>] | --this-mac")
            return 2
        }
    }

    private static func words(_ state: NodeAgent.State) -> String {
        switch state {
        case .on: "enabled"
        case .off: "not registered"
        case .needsApproval: "waiting for approval in System Settings → General → Login Items"
        }
    }

    /// This Mac, as its page shows it: the node, then each line of staying on, read as the page reads them.
    private static func thisMac() async -> Int32 {
        let node = ThisMac()
        await node.refresh()
        guard let config = node.config else {
            print(node.bundle.carriesNode ? "This Mac isn't a node." : "This build carries no node.")
            return 0
        }
        print("\(config.name): \(node.running ? "running" : "not answering") · service \(words(node.service))\(node.scripted ? " (install.sh's)" : "")")
        if let revision = node.revision { print("  revision \(revision.prefix(12))") }
        if let started = node.started { print("  up since \(started.formatted(date: .abbreviated, time: .standard))") }
        print("  invincible on your PATH: \(node.command)")
        for line in node.stayingOn?.lines ?? [] {
            let mark = line.holds == true ? "✓" : line.holds == false ? "○" : "–"
            print("\(mark) \(line.item.title): \(line.said)\(line.fix.map { " [\($0)]" } ?? "")")
        }
        return 0
    }

    /// Step 1's Start a fleet or Join my fleet, then step 2's keep-awake, as the window's buttons run them.
    private static func firstRun(_ way: String, _ rest: [String]) async -> Int32 {
        func flag(_ name: String) -> String? {
            rest.firstIndex(of: "--\(name)").flatMap { rest.indices.contains($0 + 1) ? rest[$0 + 1] : nil }
        }
        let setup = NodeSetup { print("→ \($0.words)") }
        if let unready = setup.unready {
            print("✗ \(unready)")
            return 1
        }
        if setup.home.exists {
            print("✗ this Mac is a node already: \(setup.home.dir.path)")
            return 1
        }
        let name = flag("name") ?? NodeSetup.defaultName()
        do {
            if way == "start" {
                try await setup.found(name: name, fleet: flag("fleet") ?? "homelab")
            } else {
                guard let invite = rest.first(where: { $0.hasPrefix("gi1.") }) else {
                    print("✗ join needs the invite (gi1.…) from invincible invite on a node of your fleet")
                    return 2
                }
                try await setup.join(invite: invite, name: name)
            }
            let me = try await setup.serve(app: AppModel())
            if StayingOnReading.hasBattery {
                print("→ a Mac with a battery isn't kept awake: it works while it's open")
            } else {
                try await setup.keepAwake()
            }
            print("✓ \(me.nodeName) is a node of the fleet \(me.fleetName ?? "?"), and this app is paired with it")
            return 0
        } catch {
            print("✗ \(error.localizedDescription)")
            return 1
        }
    }
}
#endif
