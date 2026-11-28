import XCTest

/*
 * Every UI test starts from Home, where the app opens, whatever the test before it left on the screen (26
 * November 2026: PerfTests.testLaunchToUsable, run after NavTests had left Settings open, waited out a minute for Home
 * and failed with "Neither Home nor the Join screen came"). Against the dev node.
 */
final class StartTests: XCTestCase {
    @MainActor
    func testHomeWhateverTheTestBeforeLeftOnScreen() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.terminate()
        try app.openApp(node)
        // Left as NavTests leaves it: Settings open, a tap in.
        let settings = app.homeRow("home.settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "No Settings on Home")
        settings.tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 10), "Settings never came")
        // The next test's start: Home, without a minute's wait.
        let started = Date()
        try app.openApp(node, timeout: 20)
        XCTAssertTrue(app.opened, "Home isn't on the screen")
        XCTAssertLessThan(Date().timeIntervalSince(started), 20, "Home took the whole wait")
    }
}
