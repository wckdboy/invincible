import XCTest

/*
 * The primary's chat while it answers (the owner, 26 November 2026: "i should be able to steer, queue messages, etc.";
 * 28 November: "super simple chat like interface"): the message box stays open, with Stop until there are words, then one
 * Send that steers, and Queue a long press on it. Against the dev node, whose stand-in never answers a message with
 * "Take your time" in it, so the turn is under way for as long as the test needs.
 */
final class ChatComposerTests: XCTestCase {
    @MainActor
    func testSteerAndQueueWhileItAnswers() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.terminate()
        try app.openApp(node)
        // A new chat with your agent (Home's +), which it answers for as long as it likes.
        app.newChat()
        let chat = app.descendants(matching: .any)["chat.screen"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "The chat never came")
        let bar = chat.descendants(matching: .any)["composer"]
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "The chat has no message box")
        bar.tap()
        bar.typeText("Take your time: what's next for the importer?")
        app.buttons["send"].tap()
        // While it answers, the box stays open, with Stop while it is empty.
        let stop = chat.buttons["composer.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 20), "No Stop while it answers")
        let box = chat.descendants(matching: .any)["composer"]
        // Steered by the one Send (the node cuts the model call it is in when a steer comes, packages/models' chat, so it
        // reaches it at once here); the thread shows it as yours, and it goes on working.
        box.tap()
        box.typeText("Look at the dates first.")
        let send = chat.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "No Send for words while it answers")
        XCTAssertEqual(send.label, "Steer", "While it answers, Send steers unless Settings says queue")
        send.tap()
        let steered = chat.staticTexts["Look at the dates first."]
        XCTAssertTrue(steered.waitForExistence(timeout: 10), "Steered, it never reached the thread")
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "Steered, it stopped answering")
        // Queued, a long press on Send away: kept on the node behind the chat, said at the chat's foot in the PWA's words.
        box.tap()
        box.typeText("And after that, the CLI's help.")
        send.press(forDuration: 1.2)
        // (A context menu's item, found by its words: its identifier doesn't always reach XCUITest.)
        let queue = app.buttons["Queue it: send when it's done"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5), "A long press on Send offers no Queue in a kept chat")
        queue.tap()
        let head = chat.descendants(matching: .any)["queue.head"]
        XCTAssertTrue(head.waitForExistence(timeout: 10), "Queued, it never showed at the chat's foot")
        XCTAssertTrue(head.label.contains("1 message queued: sent in order when it's done with this turn."), "The queue said: \(head.label)")
        XCTAssertTrue(chat.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'queue.send.'")).firstMatch.exists, "A queued message has no Send now")
        XCTAssertTrue(chat.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'queue.edit.'")).firstMatch.exists, "A queued message has no Edit")
        // Stopped: what was queued behind it is held, saying why, with Resume and Discard.
        stop.tap()
        let held = chat.descendants(matching: .any)["queue.held"]
        XCTAssertTrue(held.waitForExistence(timeout: 20), "Stopped with a message queued, the queue never said it was held")
        XCTAssertTrue(held.label.contains("1 message held: you stopped it. Nothing is sent until you resume."), "Held, it said: \(held.label)")
        XCTAssertTrue(chat.buttons["queue.resume"].exists, "A held queue has no Resume")
        // Discarded: nothing is left behind the chat, and it is no longer answering.
        chat.buttons["queue.discard"].tap()
        let gone = Date().addingTimeInterval(10)
        while held.exists, Date() < gone { settle(0.2) }
        XCTAssertFalse(held.exists, "Discarded, the held queue stayed")
        XCTAssertFalse(stop.exists, "Stopped, it still offered Stop")
    }
}
