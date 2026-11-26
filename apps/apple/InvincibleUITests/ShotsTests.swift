import XCTest

/*
 * Every iPhone screen pictured, as the owner's bar asks before a screen ships (docs/ARCHITECTURE.md §8): in light and
 * dark, at the default text size and at the largest accessibility size, against the dev node's busy fleet. Each picture
 * is an attachment of the run's result bundle, named `shot-<n>-<screen>-<look>` (the Live Activity's `live-<state>-<where>`),
 * kept always:
 *   xcrun xcresulttool export attachments --path <bundle>.xcresult --output-path <folder>
 * It runs only when asked (INVINCIBLE_SHOTS, xcodebuild's TEST_RUNNER_INVINCIBLE_SHOTS), on a simulator of its own: the
 * first launch of a fresh one is the Join screen, pictured before it pairs. Otherwise it says it was skipped.
 * INVINCIBLE_SHOTS=light or dark pictures that appearance's looks, the simulator set to it before the run
 * (`xcrun simctl ui <udid> appearance dark`): XCUITest's own setting doesn't reach an iOS 27 simulator, whose "dark"
 * pictures came out light. Anything else pictures all four, the appearance set through XCUITest.
 * Each test wants a fresh simulator of its own (-only-testing one at a time): opening a task at work starts its Live
 * Activity, which would stand in front of the one the Live Activity's tests picture.
 */
final class ShotsTests: XCTestCase {
    /// A look: light or dark, and a text size (nil: the default).
    private struct Look {
        let name: String
        let dark: Bool
        let size: String?
    }

    private let looks = [
        Look(name: "light", dark: false, size: nil),
        Look(name: "dark", dark: true, size: nil),
        Look(name: "light-ax5", dark: false, size: "UICTContentSizeCategoryAccessibilityXXXL"),
        Look(name: "dark-ax5", dark: true, size: "UICTContentSizeCategoryAccessibilityXXXL"),
    ]

    /// What this run was asked for: light, dark, or anything else for all four looks.
    private var asking: String { ProcessInfo.processInfo.environment["INVINCIBLE_SHOTS"] ?? "" }
    /// The simulator's appearance was set for the run (light or dark), so XCUITest's is never touched.
    private var appearanceGiven: Bool { asking == "light" || asking == "dark" }
    /// The looks this run pictures.
    private var pictured: [Look] { appearanceGiven ? looks.filter { $0.dark == (asking == "dark") } : looks }

    @MainActor
    func testEveryScreen() throws {
        try asked()
        let node = try DevNode.named()
        let tasks = try node.tasks()
        let app = XCUIApplication()
        defer { if !appearanceGiven { XCUIDevice.shared.appearance = .light } }
        // A fresh simulator opens on Join: pictured in every look before it pairs.
        launch(app, pictured[0])
        if app.descendants(matching: .any)["invite-link"].waitForExistence(timeout: 15) {
            for look in pictured {
                launch(app, look)
                _ = app.descendants(matching: .any)["invite-link"].waitForExistence(timeout: 10)
                shot("00-join", look)
            }
        }
        for look in pictured {
            try home(app, look, node)
            settle(3)
            shot("01-home", look)
            // Home's work, a swipe down: its rows.
            app.swipeUp()
            settle(1.5)
            shot("01-home-work", look)
            // A task proven, one that failed, one at work: each its thread, by its link (the same ones in every look).
            for (n, word, id) in [("02", "proven", tasks.proven), ("03", "failed", tasks.failed), ("04", "working", tasks.working)] {
                guard let id else { continue }
                try home(app, look, node)
                guard open(app, "invincible://task/\(id)", "task.screen") else { continue }
                settle(2.5)
                shot("\(n)-task-\(word)", look)
                if n == "02", tapIfThere(app.buttons["task.details"], app) {
                    settle(1.5)
                    shot("\(n)-task-details", look)
                    dismissSheet(app)
                }
            }
            // An agent's page: Builder's, at work.
            try home(app, look, node)
            if open(app, "invincible://agent/builder", "agent.screen") {
                settle(2)
                shot("05-agent", look)
            }
            // The primary's chat, from Home's line.
            try home(app, look, node)
            if tapIfThere(app.glance, app) {
                wait(app, "chat.screen")
                settle(2)
                shot("06-chat", look)
            }
            // While it answers: a message queued behind it, a side question, and the queue held once it's stopped.
            try home(app, look, node)
            busyChat(app, look)
            // The drawer, and each place in it.
            for (n, place, screen) in [("08", "drawer.needs", "needs.screen"), ("09", "drawer.agents", "agents.screen"), ("10", "drawer.chats", "chats.screen"), ("11", "drawer.settings", "settings.screen"), ("13", "drawer.keys", "keys.screen"), ("14", "drawer.connectors", "connectors.screen")] {
                try home(app, look, node)
                guard tapIfThere(app.buttons["home.drawer"], app) else { continue }
                if n == "08" {
                    settle(1)
                    shot("07-drawer", look)
                }
                if tapIfThere(reach(app.buttons[place], app), app) {
                    wait(app, screen)
                    settle(2)
                    shot("\(n)-\(place.dropFirst("drawer.".count))", look)
                    // About, from Settings.
                    if place == "drawer.settings", tapIfThere(reach(app.buttons["settings.about"], app), app) {
                        wait(app, "about.screen")
                        settle(1)
                        shot("12-about", look)
                    }
                }
            }
            // Search and ask, from the bar.
            try home(app, look, node)
            if tapIfThere(app.buttons["bar.search"], app) {
                settle(1.5)
                shot("15-search", look)
            }
        }
    }

    /// The Home Screen, its Lock Screen and the Dynamic Island: the system's own.
    @MainActor private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// A task's Live Activity as it goes: at work and under review (the Dynamic Island, compact and opened, and the Lock
    /// Screen), then proven (the Lock Screen: an activity that has ended leaves the island). Alone on a fresh simulator.
    @MainActor
    func testTheLiveActivity() throws {
        try asked()
        let node = try DevNode.named()
        let app = XCUIApplication()
        defer { if !appearanceGiven { XCUIDevice.shared.appearance = .light } }
        try home(app, looks[1], node)
        // At work: the demo task, held at its start, opened in hand, so the app starts its activity.
        let demo = try node.demo()
        try node.demoUntil(demo.task, "running")
        XCTAssertTrue(open(app, "invincible://task/\(demo.task)", "task.screen"), "The demo task's thread never opened")
        settle(4)
        picture("running", app)
        // Its work and its gates, then its reviewer reading it (held there); the app, in front, tells its activity.
        try node.demoUntil(demo.task, "review")
        settle(6)
        picture("review", app)
        // The reviewer passes it: proven, and its activity ended with its verdict (kept on the Lock Screen a while).
        try node.demoUntil(demo.task, "done")
        settle(6)
        lockScreen("proven", app)
    }

    /// A task whose gate failed, on its Live Activity's Lock Screen. Alone on a fresh simulator.
    @MainActor
    func testTheLiveActivityOfAFailedGate() throws {
        try asked()
        let node = try DevNode.named()
        let app = XCUIApplication()
        defer { if !appearanceGiven { XCUIDevice.shared.appearance = .light } }
        try home(app, looks[1], node)
        let failing = try node.demoFailing()
        try node.demoUntil(failing.task, "running")
        XCTAssertTrue(open(app, "invincible://task/\(failing.task)", "task.screen"), "The failing task's thread never opened")
        settle(4)
        try node.demoUntil(failing.task, "failed")
        settle(6)
        lockScreen("failed", app)
    }

    // MARK: Steps

    /// Pictures only when asked: otherwise skipped, saying so.
    private func asked() throws {
        guard ProcessInfo.processInfo.environment["INVINCIBLE_SHOTS"] != nil else {
            throw XCTSkip("Unverified: no pictures asked for. Run with TEST_RUNNER_INVINCIBLE_SHOTS=1 (and a dev node) to picture every screen.")
        }
    }

    /// The app started afresh in a look and paired, on Home.
    @MainActor
    private func home(_ app: XCUIApplication, _ look: Look, _ node: DevNode) throws {
        launch(app, look)
        try app.openHome(node)
    }

    /// One of the app's links opened, and the screen it lands on come; false when it didn't.
    @MainActor
    private func open(_ app: XCUIApplication, _ link: String, _ screen: String) -> Bool {
        guard let url = URL(string: link) else { return false }
        app.open(url)
        return app.descendants(matching: .any)[screen].waitForExistence(timeout: 15)
    }

    /// The primary's chat while it answers, from a new one it takes its time over: a message queued behind it, a question
    /// asked on the side, and once it's stopped, the queue held.
    @MainActor
    private func busyChat(_ app: XCUIApplication, _ look: Look) {
        let bar = app.descendants(matching: .any)["composer"]
        guard bar.waitForExistence(timeout: 10) else { return }
        bar.tap()
        bar.typeText("Take your time: what's next for the importer?")
        guard tapIfThere(app.buttons["send"], app) else { return }
        let chat = app.descendants(matching: .any)["chat.screen"]
        let queue = app.buttons["composer.queue"]
        guard chat.waitForExistence(timeout: 10), queue.waitForExistence(timeout: 20) else { return }
        let box = chat.descendants(matching: .any)["composer"]
        box.tap()
        box.typeText("And after that, the CLI's help.")
        queue.tap()
        _ = app.descendants(matching: .any)["queue.head"].waitForExistence(timeout: 10)
        // The keyboard put away (a tap above the box closes it), so the picture is the chat's.
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        settle(1.5)
        shot("06-chat-busy", look)
        if tapIfThere(app.buttons["chat.more"], app), tapIfThere(app.buttons["chat.aside"], app) {
            wait(app, "aside.question")
            settle(1)
            shot("06-chat-aside", look)
            dismissSheet(app)
        }
        if tapIfThere(app.buttons["composer.stop"], app) {
            _ = app.descendants(matching: .any)["queue.held"].waitForExistence(timeout: 20)
            settle(1)
            shot("06-chat-held", look)
        }
    }

    /// Its Dynamic Island, compact and opened, and its Lock Screen; then back to the app.
    @MainActor
    private func picture(_ state: String, _ app: XCUIApplication) {
        XCUIDevice.shared.press(.home)
        settle(2)
        shot("live-\(state)-island")
        // Held, the island opens to the activity's whole view.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.03)).press(forDuration: 1.2)
        settle(1.5)
        shot("live-\(state)-island-open")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()
        settle(1)
        lockScreen(state, app)
    }

    /// The Lock Screen with the activity on it; then unlocked, the app in front again.
    @MainActor
    private func lockScreen(_ state: String, _ app: XCUIApplication) {
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        settle(1.5)
        XCUIDevice.shared.press(.home)
        settle(2)
        shot("live-\(state)-lock")
        springboard.swipeUp(velocity: .fast)
        settle(1.5)
        app.activate()
        settle(2)
    }

    @MainActor
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The app started afresh in a look: its appearance, and its text size.
    @MainActor
    private func launch(_ app: XCUIApplication, _ look: Look) {
        app.terminate()
        if !appearanceGiven { XCUIDevice.shared.appearance = look.dark ? .dark : .light }
        app.launchArguments = look.size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? []
        app.launch()
    }

    /// Whether it is on the screen, so whether it can be tapped may be asked (asked of one off it, the run fails).
    @MainActor
    private func onScreen(_ element: XCUIElement, _ app: XCUIApplication) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        return !frame.isEmpty && app.windows.firstMatch.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
    }

    /// One further down a list, scrolled to (a few swipes at most). A lazy list's row isn't there at all until it's near,
    /// so it swipes while the row isn't on the screen, there or not.
    @MainActor
    private func reach(_ element: XCUIElement, _ app: XCUIApplication) -> XCUIElement {
        _ = element.waitForExistence(timeout: 2)
        for _ in 0..<8 where !onScreen(element, app) {
            app.swipeUp()
            settle(0.5)
        }
        return element
    }

    @MainActor
    private func tapIfThere(_ element: XCUIElement, _ app: XCUIApplication) -> Bool {
        guard element.waitForExistence(timeout: 8), onScreen(element, app), element.isHittable else { return false }
        element.tap()
        return true
    }

    @MainActor
    private func wait(_ app: XCUIApplication, _ screen: String) {
        _ = app.descendants(matching: .any)[screen].waitForExistence(timeout: 10)
    }

    @MainActor
    private func dismissSheet(_ app: XCUIApplication) {
        let close = app.buttons["Close"]
        if close.exists { close.tap() } else { app.swipeDown(velocity: .fast) }
        settle(1)
    }

    /// The screen as it is now, kept with the run.
    @MainActor
    private func shot(_ name: String, _ look: Look) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "shot-\(name)-\(look.name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
