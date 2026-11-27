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

    @Test func theSidebarIsShownAndHiddenFromTheKeyboard() {
        // View ▸ Show Sidebar / Hide Sidebar, ⌃⌘S, in the menus the app's scenes give it.
        let items = NSApp.mainMenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
        #expect(items.contains { $0.keyEquivalent == "s" && $0.keyEquivalentModifierMask.intersection(.deviceIndependentFlagsMask) == [.command, .control] }, "no ⌃⌘S among \(items.map(\.title))")
    }
}
#endif
