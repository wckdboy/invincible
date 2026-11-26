#if os(macOS)
import AppKit
import Foundation
import ScreenCaptureKit
import SwiftUI
import Testing
@testable import Invincible

/// A dev node to pair with, and a folder for the pictures, were given.
private let shotsAsked = ProcessInfo.processInfo.environment["INVINCIBLE_DEV_NODE"] != nil && ProcessInfo.processInfo.environment["INVINCIBLE_SHOTS"] != nil

/**
 * The Mac app as it looks, in pictures, as the PWA's `measure/first-load.ts --shots` takes its own: the first run's three
 * steps, the main window among the agents, an agent, the primary's chat, the Inbox (and at its end, what was noticed) and
 * This Mac, Settings, the app menu with Check for Updates, and the agents in the menu bar, in light and dark. Run
 * only when asked, against a fresh throwaway node (`scripts/dev-node.ts`, which lets one app in): it pairs as you would,
 * the two codes compared before it approves, then pictures the app's own windows as the window server draws them (an app
 * may picture its own windows without being let record the screen). This Mac's node is shown as given (`ThisMac.show`):
 * a build here carries none, and this Mac is never made one. It leaves no key behind.
 *
 *   bun apps/apple/scripts/dev-node.ts --dir /tmp/invincible-mac-shots
 *   TEST_RUNNER_INVINCIBLE_DEV_NODE=/tmp/invincible-mac-shots TEST_RUNNER_INVINCIBLE_SHOTS=/tmp/shots \
 *     xcodebuild -scheme InvincibleMac -destination 'platform=macOS' -derivedDataPath build test -only-testing:InvincibleMacTests/MacShots
 */
@MainActor @Suite(.serialized, .enabled(if: shotsAsked, "takes pictures only when asked, against a dev node"))
struct MacShots {
    let node = URL(fileURLWithPath: ProcessInfo.processInfo.environment["INVINCIBLE_DEV_NODE"] ?? "/nonexistent")
    let shots = URL(fileURLWithPath: ProcessInfo.processInfo.environment["INVINCIBLE_SHOTS"] ?? "/nonexistent")

    @Test(.timeLimit(.minutes(5))) func theMacAsItLooks() async throws {
        try FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        let tag = "sh.invincible.bot.tests.shots.\(UUID().uuidString)"
        defer {
            try? DeviceKey.delete(tag: tag)
            PairedNode.forget()
            NSApp.appearance = nil
        }
        let main = try window { $0.identifier?.rawValue.hasPrefix(MacApp.main) == true }
        main.setContentSize(NSSize(width: 1280, height: 800))
        MacApp.shared.thisMac.show(config: NodeHome.Config(name: "mini", fleet: nil, port: 7777, keystore: "os", keepAwake: true),
                                   revision: "4f2c9e1a7b30d58e6c41f9a2b7d3e0c5a8f61b24", service: .on, started: Date.now.addingTimeInterval(-3 * 3600 - 12 * 60),
                                   answering: WhoAmI(device: "admin", kind: "admin", scopes: [], node: "n_mini", nodeName: "mini", fleet: nil, fleetName: "homelab"),
                                   stayingOn: StayingOn(lines: [
                                       StayingOn.runsAtLogin(.on),
                                       StayingOn.logsIn(autoLogin: "owner", me: "owner", fileVault: false),
                                       StayingOn.staysAwake(set: true, held: true),
                                       StayingOn.startsAfterPowerCut(false),
                                       StayingOn.reachable(.on(name: "mini.example.test", published: nil)),
                                   ]),
                                   command: .none,
                                   log: "[invincible] node mini up · fleet homelab · http://127.0.0.1:7777 · vault unlocked · 1 loop(s) here of 1\n[invincible] compute: Measured this node for the first time\n[invincible] node mini up · fleet homelab · http://127.0.0.1:7777 · vault unlocked · 1 loop(s) here of 1")
        // In front, as you would see it: Settings opened from the app's menu brings the app in front.
        try await openSettings().close()
        // Its agents' VMs as `invincible sandbox setup status` said them on the Mac mini made fresh, then once set up.
        let fresh: [VMSetup.Line] = [
            .init(step: .container, state: .todo, said: "not installed: Apple's signed installer (1.7.1, 170 MB) is fetched from its releases on GitHub, checked against the one Apple published, and installed"),
            .init(step: .firewall, state: .todo, said: "not installed: it keeps each sandbox here from this Mac, your network and the other sandboxes"),
            .init(step: .service, state: .todo, said: "not running: it is started, and container fetches its recommended Linux kernel, once"),
            .init(step: .node, state: .todo, said: "it doesn't host VMs yet: it is restarted, and finds container as it starts"),
            .init(step: .image, state: .todo, said: "not built yet: the node builds it (a few minutes, the first time)"),
            .init(step: .vm, state: .todo, said: "not tried yet: one is made through the firewall, a command run in it, and it is removed"),
        ]
        let setUp: [VMSetup.Line] = [
            .init(step: .container, state: .done, said: "1.7.1 is installed"),
            .init(step: .firewall, state: .done, said: "on: a gateway sandbox reaches the gateway alone, an online one its resolver and the internet, and no sandbox another"),
            .init(step: .service, state: .done, said: "running, with its kernel"),
            .init(step: .node, state: .done, said: "it hosts agents' VMs"),
            .init(step: .image, state: .done, said: "built"),
            .init(step: .vm, state: .done, said: "one was made through the firewall, ran a command, and was removed, in 4 s"),
        ]
        MacApp.shared.vmSetup.show(fresh)
        // The first run's three steps, as a Mac with no node sees them, in a window of the test's own: this build carries
        // no node and isn't in Applications, which the first run would say.
        let run = FirstRun()
        run.name = "mini"
        let first = firstRunWindow(run, size: main.frame.size)
        NSApp.activate()
        for (look, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for (step, name) in [(FirstRun.Step.node, "1-node"), (.stayOn, "2-keep-on"), (.vms, "3-vms")] {
                run.step = step
                try await Task.sleep(for: .seconds(1.5))
                try await snap(first, "first-run-\(name)-\(look)")
            }
            MacApp.shared.vmSetup.show(setUp)
            try await Task.sleep(for: .seconds(1.5))
            try await snap(first, "first-run-3-vms-set-up-\(look)")
            MacApp.shared.vmSetup.show(fresh)
            run.step = .node
            run.way = .join
            run.invite = "gi1.not-a-real-invite-only-a-picture-of-one"
            try await Task.sleep(for: .seconds(1.5))
            try await snap(first, "first-run-1-join-\(look)")
            run.way = .start
        }
        first.close()
        NSApp.appearance = nil
        MacApp.shared.vmSetup.show(setUp)
        // Just the app: joining, with an `invincible:` link's invite filled in.
        MacApp.shared.firstRun.active = false
        main.makeKeyAndOrderFront(nil)
        MacApp.shared.handed = try String(contentsOf: node.appending(path: "invite.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        for (look, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            try await Task.sleep(for: .seconds(1.5))
            try await snap(main, "join-\(look)")
        }
        NSApp.appearance = nil

        let session = try await pair(tag: tag)
        try await until(30) { session.team != nil && session.inboxLoaded }

        // Files with a message, sent up to the node as the paperclip sends them: a picture of Writer's orb, and a log.
        try await openSettings().close()
        main.makeKeyAndOrderFront(nil)
        MacApp.shared.place = .primary
        NSApp.appearance = NSAppearance(named: .aqua)
        let picture = try #require(png(AgentFace(id: "writer", size: 240).environment(\.colorScheme, .dark)))
        session.chat.outbox.attach([(name: "writer.png", data: picture), (name: "test.log", data: Data("FAIL db.test.ts\n  connect ECONNREFUSED 127.0.0.1:5432\n".utf8))], with: session.client)
        try await until(30) { session.chat.outbox.waiting.count == 2 && session.chat.outbox.waiting.allSatisfy { $0.state == .up } }
        session.chat.draft = "Why does this fail?"
        try await Task.sleep(for: .seconds(1.5))
        try await snap(main, "main-chat-attaching-light")
        session.chat.send(with: session.client)
        try await until(60) { !session.chat.answering && session.chat.thread.turns.count >= 2 }
        try await Task.sleep(for: .seconds(1.5))
        try await snap(main, "main-chat-attached-light")
        NSApp.appearance = nil

        // The primary asked to show what it found: the stand-in's answer holds everything an answer can.
        session.chat.draft = "Show me where the release stands"
        session.chat.send(with: session.client)
        try await until(60) { !session.chat.answering && session.chat.thread.turns.count >= 4 }
        // In front, as you would see it (a window behind another is drawn dimmed). macOS doesn't let an app put itself in
        // front, but Settings opened from its menu comes in front, and the app with it.
        try await openSettings().close()
        main.makeKeyAndOrderFront(nil)

        for (look, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for (place, name) in [(Place.agents, "agents"), (.agent("ada"), "agent"), (.primary, "chat"), (.inbox, "inbox"), (.thisMac, "this-mac")] {
                MacApp.shared.place = place
                try await Task.sleep(for: .seconds(3))
                try await snap(main, "main-\(name)-\(look)")
                if place == .inbox {
                    // What was noticed for you, below the fold: the Inbox at its end, as a wheel would bring it.
                    try scrollToEnd(main)
                    try await Task.sleep(for: .seconds(1.5))
                    try await snap(main, "main-inbox-end-\(look)")
                }
            }
            // ⌘K: a task for the agents.
            MacApp.shared.giving = true
            try await Task.sleep(for: .seconds(2))
            try await snap(try #require(main.attachedSheet), "give-\(look)")
            MacApp.shared.giving = false
            try await Task.sleep(for: .seconds(1))
            let settings = try await openSettings()
            try await snap(settings, "settings-\(look)")
            settings.close()
            main.makeKeyAndOrderFront(nil)
            // The app menu, open, with Check for Updates (off in a build that carries no update key).
            try await snapAppMenu("app-menu-\(look)")
            // The menu bar's mark, and the panel it opens.
            let bar = try window { $0.isVisible && $0.contentView.flatMap(statusButton) != nil }
            let button = try #require(bar.contentView.flatMap(statusButton))
            try draw(button, "menu-bar-mark-\(look)")
            // What the mark opens, as the app draws it, on the menu's own material: in a panel of this test's, since SwiftUI
            // fills its own panel only for a click on the mark, which can't be made from inside the app.
            let panel = menuPanel()
            try await Task.sleep(for: .seconds(2))
            try await snap(panel, "menu-bar-\(look)")
            panel.orderOut(nil)
        }
        // ⌘N: a new chat, its message box holding the keys.
        NSApp.appearance = NSAppearance(named: .aqua)
        MacApp.shared.newChat()
        try await Task.sleep(for: .seconds(2))
        #expect(!MacApp.shared.composerWanted, "the new chat's message box didn't take the keys")
        try await snap(main, "main-new-chat-light")
        // ⌘V there, with a picture copied alone (on a pasteboard of the test's own: this Mac's clipboard is untouched).
        let board = NSPasteboard.withUniqueName()
        defer {
            Pasted.board = .general
            board.releaseGlobally()
        }
        board.clearContents()
        board.setData(try AttachmentsTests.picture(width: 1200, height: 750, type: .png), forType: .png)
        Pasted.board = board
        let paste = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: main.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))
        NSApp.postEvent(paste, atStart: false)
        try await until(30) { session.chat.outbox.waiting.count == 1 && session.chat.outbox.waiting.allSatisfy { $0.state == .up } }
        #expect(session.chat.outbox.waiting.map(\.name) == ["Pasted picture.png"])
        try await Task.sleep(for: .seconds(1.5))
        try await snap(main, "main-new-chat-pasted-light")
    }

    /// Pairs as you would with the dev node's invite: asks, compares the node's code with this Mac's, then approves.
    /// A view as a PNG, as SwiftUI draws it alone.
    private func png(_ view: some View) -> Data? {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        return renderer.cgImage.flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) }
    }

    private func pair(tag: String) async throws -> Session {
        let link = try String(contentsOf: node.appending(path: "invite.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let invite = try Invite.decode(link)
        let origin = try #require(Joining.origin(for: link, invite: invite))
        let key = try DeviceKey.create(tag: tag)
        let joining = Joining(invite: invite, device: key.device, transport: NodePairTransport(origin: origin))
        try await joining.ask(name: "Invincible app on Mac")
        let shown = node.appending(path: "pairing.txt")
        try await until(10) { FileManager.default.fileExists(atPath: shown.path) }
        let code = try String(contentsOf: shown, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try #require(code == joining.code, "the node shows another code: not approved")
        try code.filter(\.isNumber).write(to: node.appending(path: "approve"), atomically: true, encoding: .utf8)
        try await joining.approval()
        let me = try? await NodeClient(origin: origin, signer: key).get("/api/whoami", as: WhoAmI.self)
        MacApp.shared.app.paired(key: key, node: PairedNode(origin: origin, device: key.device, name: "Invincible app on Mac", fleet: invite.f, nodeName: me?.nodeName, fleetName: me?.fleetName))
        return try #require(MacApp.shared.session)
    }

    /// Settings, opened as a click on Settings… in the app's menu opens it.
    private func openSettings() async throws -> NSWindow {
        let appMenu = try #require(NSApp.mainMenu?.items.first?.submenu)
        let item = try #require(appMenu.items.firstIndex { $0.keyEquivalent == "," })
        appMenu.performActionForItem(at: item)
        try await Task.sleep(for: .seconds(2))
        return try window { $0.identifier?.rawValue.localizedStandardContains("settings") == true }
    }

    /// A window of the test's own holding the first run, as the main window holds it.
    private func firstRunWindow(_ run: FirstRun, size: NSSize) -> NSWindow {
        let view = FirstRunView(mac: MacApp.shared, run: run, unready: nil, carriesNode: true)
            .frame(minWidth: 820, minHeight: 560)
            .tint(.ink)
            .formStyle(.grouped)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = Primary.name
        window.contentView = NSHostingView(rootView: view)
        window.setContentSize(NSSize(width: 1180, height: 760))
        window.center()
        window.makeKeyAndOrderFront(nil)
        return window
    }

    /// The app menu, pictured while it is open. The menu's tracking holds the main thread, the main actor with it, so the
    /// window it opened (the window server lists it among this app's) is pictured off it, and the menu is closed from the
    /// run loop's tracking mode, or by an Escape, as a click elsewhere would close it.
    private func snapAppMenu(_ name: String) async throws {
        let menu = try #require(NSApp.mainMenu?.items.first?.submenu)
        let before = Set(try await SCShareableContent.currentProcess.windows.map(\.windowID))
        let file = shots.appending(path: "\(name).png")
        nonisolated(unsafe) let open = menu
        let taking = Task.detached { () -> String? in
            defer {
                RunLoop.main.perform(inModes: [.eventTracking, .default]) {
                    MainActor.assumeIsolated {
                        open.cancelTracking()
                        let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\u{1B}", charactersIgnoringModifiers: "\u{1B}", isARepeat: false, keyCode: 53)
                        if let escape { NSApp.postEvent(escape, atStart: false) }
                    }
                }
            }
            do {
                try await Task.sleep(for: .seconds(1.5))
                let opened = try await SCShareableContent.currentProcess.windows.filter { !before.contains($0.windowID) && $0.frame.height > 100 }
                guard let window = opened.max(by: { $0.frame.height < $1.frame.height }) else { return "no window opened for the menu" }
                try await Self.capture(window.windowID, to: file)
                return nil
            } catch {
                return "\(error)"
            }
        }
        let screen = try #require(NSScreen.main)
        menu.popUp(positioning: nil, at: NSPoint(x: screen.visibleFrame.minX + 24, y: screen.visibleFrame.maxY - 4), in: nil)
        if let failure = await taking.value { Issue.record("the app menu wasn't pictured: \(failure)") }
    }

    private func menuPanel() -> NSPanel {
        let content = NSHostingView(rootView: MenuBarAgents(mac: MacApp.shared))
        let size = content.fittingSize
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let material = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        (material.material, material.blendingMode, material.state) = (.menu, .behindWindow, .active)
        material.wantsLayer = true
        material.layer?.cornerRadius = Metrics.innerRadius
        material.layer?.masksToBounds = true
        content.frame = material.bounds
        content.autoresizingMask = [.width, .height]
        material.addSubview(content)
        panel.contentView = material
        (panel.isOpaque, panel.backgroundColor, panel.hasShadow) = (false, .clear, true)
        if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - size.width - 80, y: screen.visibleFrame.maxY - 8))
        }
        panel.orderFrontRegardless()
        return panel
    }

    private func until(_ seconds: Double, _ done: () -> Bool) async throws {
        let end = Date.now.addingTimeInterval(seconds)
        while !done() {
            try #require(Date.now < end, "waited \(seconds) s")
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    private func window(_ which: (NSWindow) -> Bool) throws -> NSWindow {
        let found = NSApp.windows.first(where: which)
        let among = NSApp.windows.map { "\($0.className) \($0.identifier?.rawValue ?? "-")" }
        return try #require(found, "no such window among \(among)")
    }

    /// The window's largest scrolling view (its detail, not the sidebar), scrolled to its end.
    private func scrollToEnd(_ window: NSWindow) throws {
        func scrollers(in view: NSView) -> [NSScrollView] {
            view.subviews.flatMap { scrollers(in: $0) } + [view as? NSScrollView].compactMap { $0 }
        }
        let content = try #require(window.contentView)
        let scroll = try #require(scrollers(in: content).max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        let document = try #require(scroll.documentView)
        let end = document.isFlipped ? max(0, document.frame.height - scroll.contentView.bounds.height) : 0
        scroll.contentView.scroll(to: NSPoint(x: scroll.contentView.bounds.minX, y: end))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func statusButton(in view: NSView) -> NSStatusBarButton? {
        if let button = view as? NSStatusBarButton { return button }
        return view.subviews.lazy.compactMap(statusButton).first
    }

    /// A window as the window server draws it, glass and all: one of this app's own, which it may picture without being let
    /// record the screen.
    private func snap(_ window: NSWindow, _ name: String) async throws {
        let id = try #require(CGWindowID(exactly: window.windowNumber), "\(window.className) isn't one of the window server's")
        try await Self.capture(id, to: shots.appending(path: "\(name).png"))
    }

    /// One of this app's windows, by the window server's id for it, pictured into `file`.
    nonisolated private static func capture(_ id: CGWindowID, to file: URL) async throws {
        let content = try await SCShareableContent.currentProcess
        let shown = try #require(content.windows.first { $0.windowID == id }, "the window server doesn't list this window")
        let filter = SCContentFilter(desktopIndependentWindow: shown)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])).write(to: file)
    }

    /// A view as it draws itself: the menu bar's mark, whose window the menu bar's own process holds.
    private func draw(_ view: NSView, _ name: String) throws {
        let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try #require(rep.representation(using: .png, properties: [:])).write(to: shots.appending(path: "\(name).png"))
    }
}
#endif
