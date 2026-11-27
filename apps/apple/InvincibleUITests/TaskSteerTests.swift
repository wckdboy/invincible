import XCTest

/*
 * Steering an agent's running task from its thread (I13; the owner, 26 November 2026: "i should be able to steer, queue
 * messages, etc."): while it runs, its box offers Steer this task and Queue for after it, in the web's words. Against the
 * dev node's demo task (Writer's), held at its first step until the test lets it go: a steer sent then is said on its way
 * to it, and once its run has gone on to its review, the trail says it as yours where it was taken.
 */
final class TaskSteerTests: XCTestCase {
    @MainActor
    func testSteerARunningTaskFromItsThread() throws {
        let node = try DevNode.named()
        let demo = try node.demo()
        let app = XCUIApplication()
        app.terminate()
        try app.openApp(node)
        app.open(try XCTUnwrap(URL(string: "invincible://task/\(demo.task)")))
        let thread = app.descendants(matching: .any)["task.screen"]
        XCTAssertTrue(thread.waitForExistence(timeout: 15), "The task's thread never opened")
        // While it runs, the box steers it or queues for after it: the web's words, each its own button.
        let steer = thread.buttons["task.steer"]
        let queue = thread.buttons["task.queue"]
        XCTAssertTrue(steer.waitForExistence(timeout: 30), "No Steer this task while it runs")
        XCTAssertEqual(steer.label, "Steer this task")
        XCTAssertTrue(queue.exists, "No Queue for after it while it runs")
        XCTAssertEqual(queue.label, "Queue for after it")
        XCTAssertFalse(steer.isEnabled, "Steer was offered with nothing written")
        let box = thread.descendants(matching: .any)["task.composer"]
        box.tap()
        box.typeText("Use the new schema.")
        XCTAssertTrue(steer.isEnabled, "Written, Steer stayed off")
        steer.tap()
        // The node has it: on its way, at the run's next safe point, as yours.
        let onItsWay = thread.descendants(matching: .any)["task.steering"]
        XCTAssertTrue(onItsWay.waitForExistence(timeout: 10), "Steered, it never said it was on its way")
        XCTAssertTrue(onItsWay.label.contains("On its way to Writer, at its next safe point"), "On its way, it said: \(onItsWay.label)")
        XCTAssertTrue(onItsWay.label.contains("You: Use the new schema."), "On its way, it said: \(onItsWay.label)")
        let sent = XCTAttachment(screenshot: app.screenshot())
        sent.name = "A running task steered from its thread: on its way"
        sent.lifetime = .keepAlways
        add(sent)
        // Its run goes on: it takes them at its next safe point, and its trail says them as yours, where it took them.
        try node.demoUntil(demo.task, "review")
        let taken = thread.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "You: Use the new schema.")).firstMatch
        XCTAssertTrue(taken.waitForExistence(timeout: 30), "Taken, the trail never said it")
        let gone = Date().addingTimeInterval(10)
        while onItsWay.exists, Date() < gone { settle(0.2) }
        XCTAssertFalse(onItsWay.exists, "Taken, it still said it was on its way")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "A running task steered from its thread: taken"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
