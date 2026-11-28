import XCTest

/*
 * Getting around, counted in taps from your agent's chat, where the app opens (the owner's word of 28 November 2026: "make
 * it as simple as the grokbot app or t3code ios app"): the drawer is a tap away (the chat's drawer button, which counts
 * what needs you), so a past chat, an agent, Needs you and Settings are two taps; a running task three (an agent, its
 * card) and an approval three (Needs you, its card); a link none. What is pushed over the chat goes back by the screen's
 * left edge and by its back button. Against the dev node's busy fleet, each from a fresh launch on the chat.
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

    /// The roster opened, and one of its rows chosen.
    @MainActor
    private func pick(_ app: XCUIApplication, _ row: String, file: StaticString = #filePath, line: UInt = #line) {
        app.openRoster()
        let chosen = app.rosterRow(row)
        XCTAssertTrue(chosen.waitForExistence(timeout: 10), "No \(row) in the roster", file: file, line: line)
        chosen.tap()
    }

    @MainActor
    func testAnAgentIsTwoTaps() throws {
        let app = try opened()
        app.openRoster()
        let agent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'roster.agent.'")).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 10), "No agent in the roster")
        agent.tap()
        shown(app, "agent.screen")
    }

    @MainActor
    func testNeedsYouIsTwoTaps() throws {
        let app = try opened()
        pick(app, "roster.needs")
        shown(app, "needs.screen")
    }

    @MainActor
    func testARunningTaskIsThreeTaps() throws {
        let app = try opened()
        // The agent at work (the dev node's Builder), then its running task's card.
        pick(app, "roster.agent.builder")
        shown(app, "agent.screen")
        let running = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'card.' AND label CONTAINS 'Working'")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 10), "No running task on the agent's page")
        running.tap()
        shown(app, "task.screen")
    }

    @MainActor
    func testAnApprovalIsThreeTaps() throws {
        let app = try opened()
        pick(app, "roster.needs")
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'decision.action:' AND NOT (identifier ENDSWITH '.answer')")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 10), "No approval in Needs you")
        approval.tap()
        shown(app, "approval.card")
    }

    @MainActor
    func testSettingsIsTwoTaps() throws {
        let app = try opened()
        pick(app, "roster.settings")
        shown(app, "settings.screen")
    }

    @MainActor
    func testAPastChatIsTwoTaps() throws {
        let app = try opened()
        app.openRoster()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'roster.chat.'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No past chat in the drawer")
        chat.tap()
        shown(app, "chat.screen")
        if UIDevice.current.userInterfaceIdiom != .pad {
            XCTAssertTrue(app.descendants(matching: .any)["roster"].waitForNonExistence(timeout: 5), "The drawer stayed over the chat")
        }
    }

    @MainActor
    func testALinkToATaskIsNoTap() throws {
        let node = try DevNode.named()
        let app = try opened()
        let id = try node.tasks().working
        app.open(try XCTUnwrap(URL(string: "invincible://task/\(id)")))
        shown(app, "task.screen")
    }

    /// Back from an agent's chat to your agent's by the screen's left edge, as a thumb goes back, and by its back button:
    /// what the drawer opens is pushed over the chat, under the system's bar, and goes back as any pushed page does.
    @MainActor
    func testAnAgentsChatGoesBackByTheEdgeAndByItsButton() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "An iPad's agent is a sidebar's place, with nothing to go back to")
        let app = try opened()
        for way in ["the edge", "its back button"] {
            pick(app, "roster.agent.builder")
            shown(app, "agent.screen")
            if way == "the edge" {
                let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
                edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
            } else {
                let back = app.navigationBars.buttons.element(boundBy: 0)
                XCTAssertTrue(back.waitForExistence(timeout: 5), "The agent's page has no back button")
                back.tap()
            }
            XCTAssertTrue(app.descendants(matching: .any)["agent.screen"].waitForNonExistence(timeout: 5), "Still on the agent's page after \(way)")
            shown(app, "chat.screen")
        }
    }
}
