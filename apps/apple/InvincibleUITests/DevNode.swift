import Foundation
import XCTest

/// The dev node the UI tests run against (scripts/dev-node.ts, started with --heavy --auto-approve): its front's address,
/// given as INVINCIBLE_DEV_NODE (xcodebuild passes TEST_RUNNER_INVINCIBLE_DEV_NODE on as that). Its /__dev/ controls are
/// the dev node's own, never a node's.
struct DevNode {
    let front: URL

    /// The dev node named in the environment, or the test is skipped, saying why: a skipped test proves nothing.
    static func named() throws -> DevNode {
        guard let named = ProcessInfo.processInfo.environment["INVINCIBLE_DEV_NODE"], let front = URL(string: named), front.scheme == "http" else {
            throw XCTSkip("Unverified: no dev node. Start one with `bun apps/apple/scripts/dev-node.ts --heavy --auto-approve`, then run with TEST_RUNNER_INVINCIBLE_DEV_NODE=<its front.txt>.")
        }
        return DevNode(front: front)
    }

    struct Request: Decodable {
        let at: Double
        let method: String
        let path: String
        let status: Int
        let ms: Double
    }

    struct Requests: Decodable {
        let now: Double
        let requests: [Request]
    }

    struct Poked: Decodable {
        let label: String
        let at: Double
    }

    func invite() throws -> String { try String(decoding: fetch("invite"), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The app's /api requests since `since` (the dev node's clock, ms), and the dev node's clock now.
    func requests(since: Double = 0) throws -> Requests {
        try JSONDecoder().decode(Requests.self, from: fetch("requests?since=\(Int(since))"))
    }

    /// The dev node's clock, ms.
    func now() throws -> Double { try requests(since: 4e15).now }

    /// A dead link while on: nothing goes through either way. Returns when it began or ended (the dev node's clock, ms).
    @discardableResult func blackhole(_ on: Bool) throws -> Double {
        struct Said: Decodable { let at: Double }
        return try JSONDecoder().decode(Said.self, from: fetch("blackhole?on=\(on ? 1 : 0)", method: "POST")).at
    }

    /// Something that needs you, at once: a device asking to join, by the label it returns.
    func poke() throws -> Poked { try JSONDecoder().decode(Poked.self, from: fetch("poke", method: "POST")) }

    /// The fixture's tasks by what they show: one at work (it never ends), one that failed, one proven (--heavy's).
    struct Tasks: Decodable {
        let working: String
        let failed: String
        let proven: String?
    }

    func tasks() throws -> Tasks { try JSONDecoder().decode(Tasks.self, from: fetch("tasks")) }

    struct Demo: Decodable { let task: String }

    /// A task to step through (the Live Activity's pictures): held at its start and at its review until `demoUntil`.
    func demo() throws -> Demo { try JSONDecoder().decode(Demo.self, from: fetch("demo", method: "POST")) }

    /// A task whose second gate fails at the end, however often it's worked: held at its start until `demoUntil`.
    func demoFailing() throws -> Demo { try JSONDecoder().decode(Demo.self, from: fetch("demo/fail", method: "POST")) }

    /// A demo task let go step by step until it is `state`: running, review (its reviewer held, reading it), done or
    /// failed. Returns once it is; throws when it wasn't within the dev node's four minutes.
    func demoUntil(_ task: String, _ state: String) throws {
        _ = try fetch("demo/until?task=\(task)&state=\(state)", method: "POST", timeout: 270)
    }

    private func fetch(_ control: String, method: String = "GET", timeout: TimeInterval = 20) throws -> Data {
        var request = URLRequest(url: URL(string: "/__dev/\(control)", relativeTo: front)!.absoluteURL, timeoutInterval: timeout)
        request.httpMethod = method
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: Result<Data, any Error> = .failure(URLError(.timedOut))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) } else if let data, (response as? HTTPURLResponse)?.statusCode == 200 { result = .success(data) } else { result = .failure(URLError(.badServerResponse)) }
            done.signal()
        }.resume()
        done.wait()
        return try result.get()
    }
}

@MainActor
extension XCUIApplication {
    /// What says the link to the node is down: "link.down" where the app marks it, else the words it says it in.
    var linkDown: XCUIElement {
        descendants(matching: .any).matching(NSPredicate(format: "identifier == 'link.down' OR label == 'No connection to your node'")).firstMatch
    }

    /// The header's line on Home: "Invincible: 4 need you · 3 at work" (its accessibility label), Home's own mark.
    var glance: XCUIElement {
        let marked = buttons["home.glance"]
        return marked.exists ? marked : buttons.matching(NSPredicate(format: "label BEGINSWITH 'Invincible:'")).firstMatch
    }

    /// How many things need you, as Home's header says (nil: it says no number).
    var needsCount: Int? {
        guard glance.exists else { return nil }
        let label = glance.label
        guard let range = label.range(of: #"(\d+) (?:needs?|things? need) you"#, options: .regularExpression) else { return label.contains("need") ? nil : 0 }
        return Int(label[range].prefix { $0.isNumber })
    }

    /// Paired with the dev node, on Home: joined through the app's own Join screen the first time (the dev node lets the
    /// app's request in by itself), Home's header at once every time after.
    func openHome(_ node: DevNode, timeout: TimeInterval = 60) throws {
        if state != .runningForeground { launch() }
        // (A field of several lines: a text view to the tests.)
        let field = descendants(matching: .any)["invite-link"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if glance.exists { return }
            if field.exists {
                field.tap()
                field.typeText(try node.invite())
                let ask = buttons["ask-to-join"]
                if ask.waitForExistence(timeout: 5) { ask.tap() }
                XCTAssertTrue(glance.waitForExistence(timeout: timeout), "Home never came after asking to join")
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTFail("Neither Home nor the Join screen came")
    }
}

/// The value at a share of the way along (0.5 the median, 0.95 the 95th percentile), nearest rank.
func percentile(_ values: [Double], _ share: Double) -> Double {
    guard !values.isEmpty else { return .nan }
    let sorted = values.sorted()
    return sorted[min(sorted.count - 1, max(0, Int((share * Double(sorted.count)).rounded(.up)) - 1))]
}
