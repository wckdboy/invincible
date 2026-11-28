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
        /// What a dead link holds at the front now (blackhole on): each request as it came.
        let waiting: [Waiting]?
    }

    struct Waiting: Decodable {
        let at: Double
        let method: String
        let path: String
    }

    /// The live stream's own requests (`/api/live`, opened afresh or again from a cursor): open all the while.
    static func isStream(_ path: String) -> Bool { path == "/api/live" || path.hasPrefix("/api/live?") }

    /// Until the app's opening is answered and it has asked nothing more for `quiet` seconds, its open stream aside, from
    /// what it sent since `since` (the dev node's clock, ms, taken before it was launched): the dev node's clock then, to
    /// count from. Fails, saying what it saw, if the app isn't quiet within `within` seconds.
    func quiet(since: Double, for quiet: TimeInterval = 3, within: TimeInterval = 90) throws -> Double {
        let deadline = Date().addingTimeInterval(within)
        var seen = try requests(since: since)
        while true {
            let asked = seen.requests.filter { !Self.isStream($0.path) }
            let streaming = seen.requests.contains { Self.isStream($0.path) && $0.status == 200 }
            if streaming, !asked.isEmpty, asked.allSatisfy({ $0.status != 0 }), let last = asked.map(\.at).max(), seen.now - last >= quiet * 1000 { return seen.now }
            guard Date() < deadline else { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            seen = try requests(since: since)
        }
        let said = seen.requests.map { "+\(Int($0.at - since)) ms \($0.method) \($0.path) \($0.status)" }
        XCTFail("The app wasn't quiet for \(Int(quiet)) s within \(Int(within)) s of opening (its stream open, all it asked answered); it asked: \(said)")
        throw NotQuiet()
    }

    struct NotQuiet: Error {}

    /// Until the dead link holds a request of the app's for `path` (its query aside): whether one came within `within` s.
    func held(_ path: String, within: TimeInterval) throws -> Bool {
        let deadline = Date().addingTimeInterval(within)
        while Date() < deadline {
            if try requests(since: 4e15).waiting?.contains(where: { $0.path == path || $0.path.hasPrefix(path + "?") }) == true { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return false
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

    struct Drafted: Decodable { let draft: String }

    /// A loop drafted for you, woken by a webhook: adding it says the webhook's secret, this once.
    func loop() throws -> Drafted { try JSONDecoder().decode(Drafted.self, from: fetch("loop", method: "POST")) }

    /// The fixture's tasks by what they show: one at work (it never ends), one that failed, one proven (--heavy's).
    struct Tasks: Decodable {
        let working: String
        let failed: String
        let proven: String?
    }

    func tasks() throws -> Tasks { try JSONDecoder().decode(Tasks.self, from: fetch("tasks")) }

    /// The approvals held for you (the release bot's outward posts, no agent's), oldest first.
    func approvals() throws -> [String] {
        struct Held: Decodable { let ids: [String] }
        return try JSONDecoder().decode(Held.self, from: fetch("approvals")).ids
    }

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

    /// What says how many things need you where the app opens: your agent's row on Home (its value "4 things need you"),
    /// what waits in its chat: a device asking to join, a key it asked for, an approval no agent stands for.
    var needsSaid: XCUIElement { descendants(matching: .any)["home.primary"] }

    /// The app is where it opens: Home's list (an iPad's sidebar), your agent first.
    var opened: Bool { descendants(matching: .any)["home.primary"].exists }

    /// How many things need you in your agent's chat, as its row on Home says it (nil: not said yet).
    var needsCount: Int? {
        let said = needsSaid
        guard said.exists else { return nil }
        let words = [said.value as? String, said.label].compactMap { $0 }.joined(separator: " ")
        guard let range = words.range(of: #"(\d+) (?:needs?|things? need) you"#, options: .regularExpression) else { return 0 }
        return Int(words[range].filter(\.isNumber))
    }

    /// Home's list, from wherever an iPhone's screen is in it: back to its root (an iPad's sidebar is always there).
    func home() {
        let primary = descendants(matching: .any)["home.primary"]
        var tries = 0
        while !(primary.exists && primary.isHittable), tries < 4 {
            let back = navigationBars.buttons.element(boundBy: 0)
            guard back.exists else { break }
            back.tap()
            tries += 1
            _ = primary.waitForExistence(timeout: 2)
        }
    }

    /// Your agent's chat, from Home.
    func openPrimary() {
        home()
        homeRow("home.primary").tap()
        _ = descendants(matching: .any)["chat.screen"].waitForExistence(timeout: 10)
    }

    /// A new chat with your agent: Home's + menu, New chat.
    func newChat() {
        home()
        let plus = buttons["home.new"]
        guard plus.waitForExistence(timeout: 5) else { return }
        plus.tap()
        let new = buttons["home.new.chat"]
        if new.waitForExistence(timeout: 5) { new.tap() }
        _ = descendants(matching: .any)["chat.screen"].waitForExistence(timeout: 10)
    }

    /// Every ask at once: your agent's chat, then its ••• and "Everything that waits on you" (no Needs you screen on a
    /// phone; each ask waits in its own chat).
    func openNeeds() {
        openPrimary()
        let more = buttons["chat.more"]
        guard more.waitForExistence(timeout: 10) else { return }
        more.tap()
        // (A menu's item, found by its words: its identifier doesn't always reach XCUITest.)
        let asks = buttons.matching(NSPredicate(format: "label BEGINSWITH 'Everything that waits on you'")).firstMatch
        if asks.waitForExistence(timeout: 5) { asks.tap() }
    }

    /// One of Home's rows (`home.primary`, `home.agent.<id>`, `home.room.<id>`, `home.chat.<id>`) or its bar's buttons
    /// (`home.settings`, `home.new`).
    func homeRow(_ id: String) -> XCUIElement { descendants(matching: .any)[id].firstMatch }

    /// Paired with the dev node, on Home (where the app opens), the app started afresh: joined through the app's own Join
    /// screen the first time (the dev node lets the app's request in by itself), Home at once every time after.
    func openApp(_ node: DevNode, timeout: TimeInterval = 60) throws {
        // Afresh whatever ran before (launch ends a running app first): one left on another screen by the test before is
        // neither Home nor the Join screen, and was waited on for the whole timeout (26 November 2026: PerfTests,
        // after the Settings NavTests left open). StartTests holds it.
        launch()
        // (A field of several lines: a text view to the tests.)
        let field = descendants(matching: .any)["invite-link"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if opened { return }
            if field.exists {
                field.tap()
                field.typeText(try node.invite())
                let ask = buttons["ask-to-join"]
                if ask.waitForExistence(timeout: 5) { ask.tap() }
                let joined = Date().addingTimeInterval(timeout)
                while !opened, Date() < joined { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
                XCTAssertTrue(opened, "Home never came after asking to join")
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
