#if os(macOS)
import AppKit
import Foundation
import Testing
@testable import Invincible

/// The Mac app's own behaviour, apart from its node (MacNodeTests): what it does as it starts, and what its menus offer.
@MainActor struct MacAppTests {
    @Test func aTestRunNeverStartsTheAppOnTheMacItRunsOn() {
        // Hosted by a test, the app reads no device key, no pairing and no node of the Mac it runs on: the test makes its own.
        #expect(MacApp.startsItself([:]))
        #expect(!MacApp.startsItself(["XCTestConfigurationFilePath": "/tmp/a-test-run.xctestconfiguration"]))
        #expect(!MacApp.startsItself(ProcessInfo.processInfo.environment), "this run is a test's, and the app started itself")
    }

    @Test func theMenusOfferSearchAndATaskWhenTheyCanBeHad() {
        // Search or Ask finds places as well as asking: there on any paired Mac, with agents or without, admin or not.
        #expect(MacCommands.maySearch(paired: true, admin: false, agents: 0))
        #expect(MacCommands.maySearch(paired: true, admin: true, agents: 0))
        #expect(!MacCommands.maySearch(paired: false, admin: true, agents: 3))
        // A task is given only where this Mac may give one, once the node has said who there is to take it, as Home's and
        // the sidebar's Give: before 27 November 2026 the menu's was always on, and Search was off without agents.
        #expect(MacCommands.mayGive(paired: true, admin: true, chat: true, read: true, agents: 2))
        #expect(!MacCommands.mayGive(paired: true, admin: true, chat: true, read: true, agents: 0))
        #expect(!MacCommands.mayGive(paired: true, admin: false, chat: true, read: true, agents: 2))
        #expect(!MacCommands.mayGive(paired: true, admin: true, chat: false, read: true, agents: 2))
        #expect(!MacCommands.mayGive(paired: true, admin: true, chat: true, read: false, agents: 2))
        #expect(!MacCommands.mayGive(paired: false, admin: true, chat: true, read: true, agents: 2))
    }

    @Test func anInvincibleLinkOpensItsPlaceInTheMainWindow() async throws {
        // (As an iPad's: a task's thread, an agent's page, Needs you; an invite is the join screen's, as before.)
        let mac = MacApp.shared
        let before = mac.place
        defer { mac.place = before }
        let task = try #require(URL(string: "invincible://task/task-abcdefghijkl"))
        await mac.follow(try #require(Push.link(task)))
        #expect(mac.place == .task("task-abcdefghijkl"))
        let agent = try #require(URL(string: "invincible://agent/builder"))
        await mac.follow(try #require(Push.link(agent)))
        #expect(mac.place == .agent("builder"))
        await mac.follow(.inbox)
        #expect(mac.place == .inbox)
    }

    @Test func theMenusComeOnWhenThisMacIsPairedWhileTheAppRuns() async throws {
        // A first run's join pairs this Mac while the app runs (AppModel.paired): File's New Chat, Search or Ask and Build,
        // and View's places, come on at once, with no menu opened since, and ⌘K opens Search; they go off again as it is
        // forgotten. Before 27 November 2026 they kept the state they were last filled with (SwiftUI fills them as a menu
        // opens), and their keys did nothing until File or View had been opened. Paired with the test's own key and a node it
        // never reaches (port 9 of this Mac, where nothing answers), so it reads and touches nothing of the Mac it runs on.
        let app = MacApp.shared.app
        let tag = "sh.invincible.bot.tests.menus.\(UUID().uuidString)"
        defer { try? app.forget(tag: tag) }
        app.start(tag: tag)
        try #require(MacApp.shared.session == nil, "paired before the test paired it")
        let needsAFleet: Set = ["New Chat", "Search or Ask…", "Build with \(Primary.name)", "Home", "Agents", "Needs you"]
        let before = try offered()
        #expect(needsAFleet.isDisjoint(with: before), "on before this Mac is paired: \(needsAFleet.intersection(before).sorted())")

        let key = try DeviceKey.create(tag: tag)
        let nowhere = try #require(URL(string: "http://127.0.0.1:9"))
        app.paired(key: key, node: PairedNode(origin: nowhere, device: key.device, name: "Invincible app on Mac", fleet: "f_menus_test", nodeName: nil, fleetName: nil))
        try #require(MacApp.shared.session != nil)
        try await until(5) { needsAFleet.isSubset(of: try offered()) }
        let paired = try offered()
        #expect(needsAFleet.isSubset(of: paired), "still off once this Mac is paired: \(needsAFleet.subtracting(paired).sorted())")
        // (A task waits until the node has said who there is to take it, which this one never does.)
        #expect(!paired.contains("Give the agents a Task…"))
        // ⌘K, as pressed: the menus' key opens Search or Ask.
        MacApp.shared.searching = false
        defer { MacApp.shared.searching = false }
        press("k", keyCode: 40)
        try await until(2) { MacApp.shared.searching }
        #expect(MacApp.shared.searching, "⌘K did nothing once this Mac was paired")

        try app.forget(tag: tag)
        try await until(5) { needsAFleet.isDisjoint(with: try offered()) }
        let forgotten = try offered()
        #expect(needsAFleet.isDisjoint(with: forgotten), "still on once this Mac is forgotten: \(needsAFleet.intersection(forgotten).sorted())")
    }

    @Test func theMenusFollowWhatTheyReadEachTimeItChanges() async throws {
        // (MacMenus, which the menus follow: what it reads of an observable model is in its offer as it changes, again and
        // again, as the app's pairing, its session and its updater change; each new offer is told on, and only a new one,
        // as the app's has the main menu filled again.)
        let source = MenusSource()
        let menus = MacMenus(reading: { MacMenus.Offer(paired: source.paired, mayCheckForUpdates: source.updates) }, changed: { source.told.append($0) })
        #expect(menus.offer == MacMenus.Offer())
        source.paired = true
        try await until(2) { menus.offer.paired }
        #expect(menus.offer == MacMenus.Offer(paired: true))
        source.updates = true
        try await until(2) { menus.offer.mayCheckForUpdates }
        #expect(menus.offer == MacMenus.Offer(paired: true, mayCheckForUpdates: true))
        source.paired = false
        try await until(2) { !menus.offer.paired }
        #expect(menus.offer == MacMenus.Offer(mayCheckForUpdates: true))
        source.updates = true
        try await Task.sleep(for: .milliseconds(200))
        #expect(source.told == [MacMenus.Offer(paired: true), MacMenus.Offer(paired: true, mayCheckForUpdates: true), MacMenus.Offer(mayCheckForUpdates: true)])
    }

    /// The titles of the File and View menus' items that are on as they stand, neither menu filled first as opening it
    /// would have it: the state their keys go by. Found again each time: the menus may be made anew as they change.
    private func offered() throws -> Set<String> {
        let menus = try ["New Chat", "Agents"].map { title in
            try #require(NSApp.mainMenu?.items.compactMap(\.submenu).first { $0.items.contains { $0.title == title } }, "no menu with \(title) among \(NSApp.mainMenu?.items.map(\.title) ?? [])")
        }
        return Set(menus.flatMap { menu in
            menu.update()
            return menu.items.filter(\.isEnabled).map(\.title)
        })
    }

    /// A key pressed with ⌘, as the menu bar takes it.
    private func press(_ key: String, keyCode: UInt16) {
        let window = NSApp.windows.first { $0.isVisible }?.windowNumber ?? 0
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window,
                                           context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: keyCode) else { return }
        _ = NSApp.mainMenu?.performKeyEquivalent(with: event)
    }

    /// Waits until it holds, or `seconds` have gone by (the test's own #expect then says what didn't).
    private func until(_ seconds: Double, _ holds: () throws -> Bool) async throws {
        let end = Date.now.addingTimeInterval(seconds)
        while try !holds(), Date.now < end { try await Task.sleep(for: .milliseconds(100)) }
    }

    @Test func theSidebarIsShownAndHiddenFromTheKeyboard() {
        // View ▸ Show Sidebar / Hide Sidebar, ⌃⌘S, in the menus the app's scenes give it.
        let items = NSApp.mainMenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
        #expect(items.contains { $0.keyEquivalent == "s" && $0.keyEquivalentModifierMask.intersection(.deviceIndependentFlagsMask) == [.command, .control] }, "no ⌃⌘S among \(items.map(\.title))")
    }
}

/// What MacMenus reads in its test: an observable model, as the app's are.
@MainActor @Observable private final class MenusSource {
    var paired = false
    var updates = false
    /// Each offer MacMenus told on.
    var told: [MacMenus.Offer] = []
}
#endif
