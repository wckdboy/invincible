import XCTest

/*
 * A loop drafted for you, woken by a webhook, added from its sheet in Needs you: the webhook's secret is said this once,
 * so the secret and Done are in view as the sheet stands, without scrolling (27 November 2026: Done had been below the
 * sheet's fold, under the loop's description). Against the dev node's drafted loop (/__dev/loop).
 */
final class LoopDraftTests: XCTestCase {
    @MainActor
    func testAWebhookLoopsSecretAndDoneAreInViewOnceAdded() throws {
        let node = try DevNode.named()
        let drafted = try node.loop()
        let app = XCUIApplication()
        app.terminate()
        try app.openHome(node)
        app.buttons["home.drawer"].tap()
        let needs = app.buttons["drawer.needs"]
        XCTAssertTrue(needs.waitForExistence(timeout: 5), "No Needs you in the drawer")
        needs.tap()
        XCTAssertTrue(app.descendants(matching: .any)["needs.screen"].waitForExistence(timeout: 10), "Needs you never came")
        // Below the fixture's other decisions: drawn once it's scrolled to.
        let row = app.buttons["decision.draft:\(drafted.draft)"]
        var swipes = 0
        while !row.waitForExistence(timeout: 2), swipes < 8 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(row.exists, "The drafted loop isn't in Needs you")
        row.tap()
        let adding = app.buttons["Add loop"]
        XCTAssertTrue(adding.waitForExistence(timeout: 10), "Its sheet never offered Add loop")
        adding.tap()
        let secret = app.descendants(matching: .any)["loop.secret"]
        XCTAssertTrue(secret.waitForExistence(timeout: 15), "Added, it never said the webhook's secret")
        let done = app.buttons["loop.secret.done"]
        XCTAssertTrue(done.exists, "No Done once the secret was said")
        // As the sheet stands, nothing scrolled: each whole on the screen, where a thumb can press them.
        XCTAssertTrue(done.isHittable && app.frame.contains(done.frame), "Done is out of view, at \(done.frame)")
        XCTAssertTrue(secret.isHittable && app.frame.contains(secret.frame), "The secret is out of view, at \(secret.frame)")
        // (No picture: it would keep the secret.)
        done.tap()
        let gone = Date().addingTimeInterval(10)
        while secret.exists, Date() < gone { settle(0.2) }
        XCTAssertFalse(secret.exists, "Done, the sheet stayed")
        XCTAssertFalse(row.exists, "Added, the drafted loop stayed in Needs you")
    }
}
