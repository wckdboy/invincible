import XCTest

/*
 * Getting around, counted in taps from Home (X2's targets, 26 November 2026): a running task, an agent and an approval in
 * one; Settings and a past chat in two (the drawer, then the place); a link in none. Against the dev node's busy fleet,
 * each from a fresh launch on Home.
 */
final class NavTests: XCTestCase {
    @MainActor
    private func home() throws -> XCUIApplication {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.terminate()
        try app.openHome(node)
        return app
    }

    @MainActor
    private func shown(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.descendants(matching: .any)[screen].waitForExistence(timeout: 10), "\(screen) never came", file: file, line: line)
    }

    @MainActor
    func testARunningTaskIsOneTap() throws {
        let app = try home()
        let running = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'row.' AND label CONTAINS 'Working'")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 10), "No running task on Home")
        running.tap()
        shown(app, "task.screen")
    }

    @MainActor
    func testAnAgentIsOneTap() throws {
        let app = try home()
        let agent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'agent.'")).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 10), "No agent on Home")
        agent.tap()
        shown(app, "agent.screen")
    }

    @MainActor
    func testAnApprovalIsOneTap() throws {
        let app = try home()
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'decision.action:' AND NOT (identifier ENDSWITH '.answer')")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 10), "No approval on Home")
        approval.tap()
        shown(app, "approval.card")
    }

    @MainActor
    func testSettingsIsTwoTaps() throws {
        let app = try home()
        app.buttons["home.drawer"].tap()
        let settings = app.buttons["drawer.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        shown(app, "settings.screen")
    }

    @MainActor
    func testAPastChatIsTwoTaps() throws {
        let app = try home()
        app.buttons["home.drawer"].tap()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'drawer.chat.'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No past chat in the drawer")
        chat.tap()
        shown(app, "chat.screen")
    }

    @MainActor
    func testALinkToATaskIsNoTap() throws {
        let app = try home()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'row.task-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let id = String(row.identifier.dropFirst("row.".count))
        app.open(try XCTUnwrap(URL(string: "invincible://task/\(id)")))
        shown(app, "task.screen")
    }
}
