import XCTest

/*
 * Getting around, counted in taps from your agent's chat, where the app opens (the owner's word of 27 November 2026:
 * "something like t3code on desktop, and openmausbot/grokbot on mobile"): the roster is a tap away (the chat's back
 * arrow, which counts what needs you), so an agent, Needs you, the work and Settings are two taps; a running task and an
 * approval three (the work's row, Needs you's card); a past chat three (the chat's menu, All chats, the chat); a link
 * none. Against the dev node's busy fleet, each from a fresh launch on the chat.
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
        pick(app, "roster.work")
        let running = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'row.' AND label CONTAINS 'Working'")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 10), "No running task in the work")
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
    func testAPastChatIsThreeTaps() throws {
        let app = try opened()
        app.buttons["chat.more"].tap()
        let all = app.buttons["chats"]
        XCTAssertTrue(all.waitForExistence(timeout: 5), "No All chats in the chat's menu")
        all.tap()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chats.'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No past chat among them")
        chat.tap()
        shown(app, "chat.screen")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chats.'")).firstMatch.exists, "The list stayed over the chat")
    }

    @MainActor
    func testALinkToATaskIsNoTap() throws {
        let node = try DevNode.named()
        let app = try opened()
        let id = try node.tasks().working
        app.open(try XCTUnwrap(URL(string: "invincible://task/\(id)")))
        shown(app, "task.screen")
    }

    /// Back from the work to your agent's chat by the screen's left edge, as a thumb goes back, and by its back button. On
    /// an iPhone the work draws its own head where the system bar was (its scroll's cost: PerfTests.testScrollWork), and
    /// a hidden bar takes the edge with it unless the work gives it back.
    @MainActor
    func testTheWorkGoesBackByTheEdgeAndByItsButton() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "An iPad's work is a sidebar's place, with nothing to go back to")
        let app = try opened()
        for way in ["the edge", "its back button"] {
            pick(app, "roster.work")
            shown(app, "work.screen")
            if way == "the edge" {
                let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.55))
                edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
            } else {
                let back = app.buttons["work.back"]
                XCTAssertTrue(back.waitForExistence(timeout: 5), "The work has no back button")
                back.tap()
            }
            XCTAssertTrue(app.descendants(matching: .any)["work.screen"].waitForNonExistence(timeout: 5), "Still on the work after \(way)")
            shown(app, "chat.screen")
        }
    }
}
