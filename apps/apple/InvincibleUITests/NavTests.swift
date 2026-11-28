import XCTest

/*
 * Getting around, counted in taps from Home, where the app opens (the owner's word of 28 November 2026: "use grok bot as
 * the app look/UX. like a chat app, with the primary at the top, the other agents, and a settings menu"): your agent's
 * chat, an agent's (its details a tap on its name) and Settings one tap; Needs you two (your agent's chat, then "N more need you" under what waits
 * there); an approval two (your agent's chat, its card there); a running task two (its agent, its card); a past chat four
 * (your agent, its menu, Past chats, the chat); a link none. Against the dev node's busy fleet, each from a fresh launch.
 */
final class NavTests: XCTestCase {
    @MainActor
    private func opened() throws -> XCUIApplication {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.terminate()
        try app.openApp(node)
        return app
    }

    @MainActor
    private func shown(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.descendants(matching: .any)[screen].waitForExistence(timeout: 10), "\(screen) never came", file: file, line: line)
    }

    /// One of Home's rows (or its bar's buttons), tapped.
    @MainActor
    private func tap(_ app: XCUIApplication, _ row: String, file: StaticString = #filePath, line: UInt = #line) {
        let chosen = app.homeRow(row)
        XCTAssertTrue(chosen.waitForExistence(timeout: 10), "No \(row) on Home", file: file, line: line)
        chosen.tap()
    }

    @MainActor
    func testYourAgentsChatIsOneTap() throws {
        let app = try opened()
        tap(app, "home.primary")
        shown(app, "chat.screen")
    }

    @MainActor
    func testAnAgentIsOneTap() throws {
        let app = try opened()
        let agent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'home.agent.'")).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 10), "No agent on Home")
        agent.tap()
        shown(app, "agent.screen")
        // What it is and how its day stands: a tap on its name in the bar (Grok Bot's pill).
        let pill = app.descendants(matching: .any)["agent.pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 5), "No name pill in the agent's bar")
        pill.tap()
        shown(app, "agent.about.screen")
    }

    @MainActor
    func testSettingsIsOneTap() throws {
        let app = try opened()
        tap(app, "home.settings")
        shown(app, "settings.screen")
    }

    @MainActor
    func testNeedsYouIsTwoTaps() throws {
        let app = try opened()
        tap(app, "home.primary")
        let more = app.buttons["chat.needs.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), "Nothing more needs you under your agent's chat")
        more.tap()
        shown(app, "needs.screen")
    }

    @MainActor
    func testAnApprovalIsTwoTaps() throws {
        let app = try opened()
        tap(app, "home.primary")
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'decision.action:' AND NOT (identifier ENDSWITH '.answer')")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 10), "No approval in your agent's chat")
        approval.tap()
        shown(app, "approval.card")
    }

    @MainActor
    func testARunningTaskIsTwoTaps() throws {
        let app = try opened()
        tap(app, "home.agent.builder")
        shown(app, "agent.screen")
        // Its timeline's card at work (the task's title and its state, Working).
        let running = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'card.' AND label CONTAINS 'Working'")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 10), "No running task in Builder's chat")
        running.tap()
        shown(app, "task.screen")
    }

    @MainActor
    func testAPastChatIsFourTaps() throws {
        let app = try opened()
        tap(app, "home.primary")
        shown(app, "chat.screen")
        app.buttons["chat.more"].tap()
        let past = app.buttons["chats"]
        XCTAssertTrue(past.waitForExistence(timeout: 5), "No All chats in its menu")
        past.tap()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chats.'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No past chat among them")
        chat.tap()
        shown(app, "chat.screen")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chats.'")).firstMatch.waitForNonExistence(timeout: 5), "The list stayed over the chat")
    }

    @MainActor
    func testALinkToATaskIsNoTap() throws {
        let node = try DevNode.named()
        let app = try opened()
        let id = try node.tasks().working
        app.open(try XCTUnwrap(URL(string: "invincible://task/\(id)")))
        shown(app, "task.screen")
    }

    /// Back from an agent's chat to Home by the screen's left edge, as a thumb goes back, and by its back button.
    @MainActor
    func testAnAgentsChatGoesBackByTheEdgeAndByItsButton() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "An iPad's chat is beside the list, with nothing to go back to")
        let app = try opened()
        for way in ["the edge", "its back button"] {
            tap(app, "home.agent.builder")
            shown(app, "agent.screen")
            if way == "the edge" {
                let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
                edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
            } else {
                let back = app.navigationBars.buttons.element(boundBy: 0)
                XCTAssertTrue(back.waitForExistence(timeout: 5), "The chat has no back button")
                back.tap()
            }
            XCTAssertTrue(app.descendants(matching: .any)["agent.screen"].waitForNonExistence(timeout: 5), "Still on Builder's chat after \(way)")
            let primary = app.homeRow("home.primary")
            XCTAssertTrue(primary.waitForExistence(timeout: 5) && primary.isHittable, "Home isn't on the screen after \(way)")
        }
    }
}
