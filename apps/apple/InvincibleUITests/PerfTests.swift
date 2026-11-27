import XCTest

/*
 * The app as you use it, measured against a dev node with a busy fleet (scripts/dev-node.ts --heavy --auto-approve) and
 * held to Budgets.json. The app opens on your agent's chat (since 27 November 2026; Home before), so:
 *  - launch: from the process starting to the chat's first frame with what it shows, its latest chat or its welcome (the
 *    app's own probe, PerfProbe.swift: Apple's launch metric reports nothing on a simulator), the median of five;
 *  - at rest on the chat: what it asks the node in a minute, and its CPU and memory while nothing changes; and what it
 *    asks in a minute with a stall in it (the node silent long enough that the app takes its stream for dead);
 *  - live: from something needing you on the node to the chat's back arrow counting it, the first event after opening
 *    held on its own (it takes the path cold) and the ten after it together, each said with where its time went;
 *  - a dead link: how soon the app says it's reconnecting once the node goes silent (as a half-open connection does),
 *    and how soon it's back once the node can be reached again;
 *  - scrolling the work's long list (Home's, before): the frames that came late, in ms a second (Apple's hitch time
 *    ratio).
 * Each prints a PERF line and attaches its numbers, so a run's log and its result bundle say what was measured.
 */
final class PerfTests: XCTestCase {
    struct Budgets: Decodable {
        let appStartToUsableMs: Double
        let appStartToUsableTargetMs: Double
        let requestsAtRestPerMinute: Double
        let requestsThroughAStallPerMinute: Double
        let eventToScreenP95Ms: Double
        let eventToScreenFirstMs: Double
        let deadLinkNoticedMs: Double
        let deadLinkBackMs: Double
        let cpuAtRestPercent: Double
        let cpuAtRestTargetPercent: Double
        let memoryAtRestMB: Double
        let scrollLateMsPerSecond: Double
        let scrollLateTargetMsPerSecond: Double
    }

    /// X2's target where it isn't met yet: a miss is recorded in every run as an expected failure (it never passes in
    /// silence), and once a run meets it nothing is recorded; the limit beside it is what fails the test.
    private func target(_ met: Bool, _ what: @autoclosure () -> String) {
        guard !met else { return }
        XCTExpectFailure("X2's target, not met yet: \(what())", strict: false) { XCTFail(what()) }
    }

    private var budgets: Budgets {
        get throws {
            let url = try XCTUnwrap(Bundle(for: PerfTests.self).url(forResource: "Budgets", withExtension: "json"), "Budgets.json isn't in the suite's bundle")
            return try JSONDecoder().decode(Budgets.self, from: Data(contentsOf: url))
        }
    }

    /// What was measured, said in the log and kept with the result.
    private func report(_ name: String, _ values: [String: Double]) {
        let line = values.keys.sorted().map { "\($0)=\(values[$0].map { String(format: "%.1f", $0) } ?? "-")" }.joined(separator: " ")
        print("PERF \(name) \(line)")
        let attachment = XCTAttachment(string: line)
        attachment.name = "perf.\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testLaunchToUsable() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        try app.openApp(node)
        app.launchArguments = ["-InvincibleMeasure", "YES"]
        var took: [Double] = []
        var own: [Double] = []
        for _ in 0..<5 {
            app.terminate()
            settle(1)
            app.launch()
            let probe = app.probe
            XCTAssertTrue(probe.waitForExistence(timeout: 20), "The probe never came: the app wasn't launched to be measured")
            let deadline = Date().addingTimeInterval(20)
            var launch: Double?
            while launch == nil, Date() < deadline {
                launch = app.reading("launch")
                if launch == nil { settle(0.1) }
            }
            took.append(try XCTUnwrap(launch, "The chat never showed what it holds"))
            // (A build from before the probe kept its start says none: its whole launch is all there is.)
            own.append(launch! - (app.reading("start") ?? 0))
        }
        report("launch-to-usable", ["p50": percentile(took, 0.5), "max": took.max() ?? .nan, "appStartToUsableP50": percentile(own, 0.5)])
        print("PERF launch-to-usable each: \(took.map { Int($0) }), from the app's first line: \(own.map { Int($0) })")
        XCTAssertLessThanOrEqual(percentile(own, 0.5), try budgets.appStartToUsableMs, "From the app's first line to a usable chat took \(own.map { Int($0) }) ms (\(took.map { Int($0) }) from the process's start)")
        target(percentile(own, 0.5) <= (try budgets.appStartToUsableTargetMs), "launch to usable in \(Int(try! budgets.appStartToUsableTargetMs)) ms; the app's own part took \(own.map { Int($0) }) ms")
    }

    @MainActor
    func testRequestsAtRest() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        let launched = try node.now()
        try app.openApp(node)
        // Whatever opening asked for has been answered, and the app has asked nothing more for a while (its stream aside).
        let since = try node.quiet(since: launched)
        settle(60)
        let asked = try node.requests(since: since).requests
        let byPath = Self.byRoute(asked)
        report("requests-at-rest", ["perMinute": Double(asked.count)])
        print("PERF requests-at-rest by route: \(byPath.joined(separator: ", "))")
        XCTAssertLessThanOrEqual(Double(asked.count), try budgets.requestsAtRestPerMinute, "At rest the app asked the node \(asked.count) times in a minute: \(byPath)")
    }

    /// A minute at rest with a stall in it, as a busy Mac or a busy node makes one (26 November 2026: CI's Mac at a load
    /// of 480 failed testRequestsAtRest): the node silent until the app takes its stream for dead (three beats) and opens
    /// another, then reached again at once. The stream resumes, so the app asks nothing again but the stream; before, it
    /// read every route again (13 requests). The link is cut as soon as the app has opened its new stream, not after a
    /// fixed time: one cut longer could outlast the app's wait for the new stream's hello (HELLO_WAIT), which is the
    /// stream being down, and every route read on a timer is what down means.
    @MainActor
    func testRequestsThroughAStall() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        let launched = try node.now()
        try app.openApp(node)
        let since = try node.quiet(since: launched)
        let start = Date()
        defer { _ = try? node.blackhole(false) }
        settle(20)
        let stalled = try node.blackhole(true)
        let reopened = try node.held("/api/live", within: 30)
        let lifted = try node.blackhole(false)
        XCTAssertTrue(reopened, "The app didn't open its stream again within 30 s of a dead link")
        settle(max(0, 60 - Date().timeIntervalSince(start)))
        let asked = try node.requests(since: since).requests
        let byPath = Self.byRoute(asked)
        let load = Self.hostLoad()
        report("requests-through-a-stall", ["perMinute": Double(asked.count), "stallMs": lifted - stalled, "hostLoad": load.average, "hostCores": Double(load.cores)])
        print("PERF requests-through-a-stall by route: \(byPath.joined(separator: ", ")), stalled \(Int(lifted - stalled)) ms")
        XCTAssertLessThanOrEqual(Double(asked.count), try budgets.requestsThroughAStallPerMinute, "Through a stall of \(Int(lifted - stalled)) ms the app asked the node \(asked.count) times in a minute: \(byPath) (the Mac's load \(String(format: "%.1f", load.average)) on \(load.cores) cores)")
    }

    /// How many times each route was asked, its query aside.
    static func byRoute(_ asked: [DevNode.Request]) -> [String] {
        Dictionary(grouping: asked, by: { $0.path.components(separatedBy: "?")[0] }).map { "\($0.value.count) \($0.key)" }.sorted()
    }

    @MainActor
    func testAtRest() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.launchArguments = ["-InvincibleMeasure", "YES"]
        app.terminate()
        try app.openApp(node)
        settle(10)
        // Reading the probe costs the app something itself (XCUITest takes a picture of its whole accessibility tree to
        // find it): what one reading costs, from two back to back, is taken off what the rest between two cost.
        let a = try XCTUnwrap(app.reading("cpu"))
        let b = try XCTUnwrap(app.reading("cpu"))
        let perReading = max(0, b - a)
        let cpu0 = try XCTUnwrap(app.reading("cpu"))
        let start = Date()
        settle(20)
        let cpu1 = try XCTUnwrap(app.reading("cpu"))
        let seconds = Date().timeIntervalSince(start)
        let percent = max(0, cpu1 - cpu0 - perReading) / (seconds * 1000) * 100
        let memory = try XCTUnwrap(app.reading("mem"))
        report("at-rest", ["cpuPercent": percent, "memoryMB": memory, "readingCostMs": perReading])
        XCTAssertLessThanOrEqual(percent, try budgets.cpuAtRestPercent, "At rest on the chat the app used \(String(format: "%.1f", percent)) % of a core")
        target(percent <= (try budgets.cpuAtRestTargetPercent), "under \(try! budgets.cpuAtRestTargetPercent) % of a core at rest; it used \(String(format: "%.1f", percent)) %")
        XCTAssertLessThanOrEqual(memory, try budgets.memoryAtRestMB, "At rest on the chat the app held \(Int(memory)) MB")
    }

    @MainActor
    func testEventToScreen() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        try app.openApp(node)
        settle(5)
        // The first event after opening, on its own: it takes the path cold, and on CI's loaded Mac (27 November 2026, PR
        // #72) one such took 554 ms against 130-140 for the nine after it, which failed the steady limit, the 95th percentile
        // of ten being their largest. It is held to a limit of its own, so a first event that got slower still fails.
        let first = try event(app, node)
        settle(1)
        var each: [Event] = []
        for _ in 0..<10 {
            each.append(try event(app, node))
            settle(1)
        }
        let took = each.map(\.ms)
        report("event-to-screen", ["first": first.ms, "p50": percentile(took, 0.5), "p95": percentile(took, 0.95), "max": took.max() ?? .nan])
        print("PERF event-to-screen first: \(first.said)")
        print("PERF event-to-screen each: \(took.map { Int($0) })")
        for (n, one) in each.enumerated() { print("PERF event-to-screen \(n + 1): \(one.said)") }
        XCTAssertLessThanOrEqual(first.ms, try budgets.eventToScreenFirstMs, "The first event after opening took \(first.said)")
        XCTAssertLessThanOrEqual(percentile(took, 0.95), try budgets.eventToScreenP95Ms, "Something needing you took \(took.map { Int($0) }) ms to show: \(each.map(\.said).joined(separator: "; "))")
    }

    /// One event and how long the screen took to count it, with where the time went: when the app's reads reached the node
    /// after it answered the poke and how long the node took over each (its stream aside), then when the screen said it, all
    /// from the node's answer (the dev node's clock and this test's are the Mac's own).
    struct Event {
        let ms: Double
        let said: String
    }

    @MainActor
    private func event(_ app: XCUIApplication, _ node: DevNode) throws -> Event {
        let before = try XCTUnwrap(app.needsCount, "The chat's back arrow says no count")
        let poked = try node.poke()
        let start = Date()
        while (app.needsCount ?? before) <= before, Date().timeIntervalSince(start) < 20 { settle(0.02) }
        let ms = Date().timeIntervalSince(start) * 1000
        let shown = start.timeIntervalSince1970 * 1000 + ms - poked.at
        let reads = try node.requests(since: poked.at).requests.filter { !DevNode.isStream($0.path) && $0.at - poked.at <= shown }
        let read = reads.map { "\($0.method) \($0.path.components(separatedBy: "?")[0]) at +\(Int($0.at - poked.at)) ms, answered in \(Int($0.ms))" }
        return Event(ms: ms, said: "\(Int(ms)) ms (\(read.isEmpty ? "no read" : read.joined(separator: "; ")); on screen at +\(Int(shown)) ms)")
    }

    @MainActor
    func testDeadLink() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.launchArguments = ["-InvincibleMeasure", "YES"]
        app.terminate()
        try app.openApp(node)
        settle(5)
        defer { try? node.blackhole(false) }
        XCTAssertFalse(app.linkDown.exists, "The app said the link was down before it was")
        let dead = try node.blackhole(true)
        let deadHere = Date()
        while !app.linkDown.exists, Date().timeIntervalSince(deadHere) < 150 { settle(0.05) }
        // As the test saw it on screen (its own looks at the screen take a while), and as the app said it (its probe:
        // the moment it took the link for lost, by the same clock as the dev node's).
        let shown = Date().timeIntervalSince(deadHere) * 1000
        let noticed = (app.reading("lostAt") ?? .nan) - dead
        let alive = try node.blackhole(false)
        let aliveHere = Date()
        while app.linkDown.exists, Date().timeIntervalSince(aliveHere) < 60 { settle(0.05) }
        let shownBack = Date().timeIntervalSince(aliveHere) * 1000
        let back = (app.reading("backAt") ?? .nan) - alive
        report("dead-link", ["noticedMs": noticed, "shownMs": shown, "backMs": back, "shownBackMs": shownBack])
        XCTAssertLessThanOrEqual(noticed, try budgets.deadLinkNoticedMs, "A dead link took \(Int(noticed)) ms to notice (\(Int(shown)) ms to be seen on screen)")
        XCTAssertLessThanOrEqual(back, try budgets.deadLinkBackMs, "Back took \(Int(back)) ms once the node could be reached")
    }

    @MainActor
    func testScrollWork() throws {
        let node = try DevNode.named()
        let app = XCUIApplication()
        app.launchArguments = ["-InvincibleMeasure", "YES", "-InvincibleMeasureFrames", "YES"]
        app.terminate()
        try app.openApp(node)
        // The work, from the roster: Home's list as it was, a lazy one (a collection view).
        app.openRoster()
        let work = app.rosterRow("roster.work")
        XCTAssertTrue(work.waitForExistence(timeout: 10), "No Work in the roster")
        work.tap()
        let page = app.descendants(matching: .any)["work.screen"]
        XCTAssertTrue(page.waitForExistence(timeout: 10), "The work never came")
        settle(5)
        // (The page is its list: the lazy list carries the screen's name itself, so no list stands inside it.)
        let list = app.collectionViews["work.screen"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), "The work's list isn't a collection view by its name")
        // Three rounds of the same swipes, each measured on its own. Other work on the Mac only ever adds late frames
        // (26 November 2026: CI run 34 failed here while the runner's Mac also ran agents' builds at a load of 50 to
        // 100 on 18 cores; the same commit then passed there at 6.9 ms a second), so the limit holds the best round,
        // which is what the list itself costs, and X2's target the median. A list that got slower is slower in every round.
        var rounds: [(ratio: Double, seconds: Double)] = []
        for _ in 0..<3 {
            let late0 = try XCTUnwrap(app.reading("lateMs"))
            let start = Date()
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
            let seconds = Date().timeIntervalSince(start)
            let late1 = try XCTUnwrap(app.reading("lateMs"))
            rounds.append(((late1 - late0) / seconds, seconds))
        }
        let ratios = rounds.map(\.ratio).sorted()
        let best = ratios[0], median = ratios[1]
        let load = Self.hostLoad()
        let said = "rounds \(ratios.map { String(format: "%.1f", $0) }), the Mac's load \(String(format: "%.1f", load.average)) on \(load.cores) cores"
        report("scroll-work", ["lateMsPerSecond": best, "medianLateMsPerSecond": median, "seconds": rounds.map(\.seconds).reduce(0, +), "hostLoad": load.average, "hostCores": Double(load.cores)])
        XCTAssertLessThanOrEqual(best, try budgets.scrollLateMsPerSecond, "Scrolling the work, frames came \(String(format: "%.1f", best)) ms a second late at best (\(said))")
        target(median <= (try budgets.scrollLateTargetMsPerSecond), "under \(try! budgets.scrollLateTargetMsPerSecond) ms a second of late frames scrolling; the median round was \(String(format: "%.1f", median)) (\(said))")
    }

    /// The Mac's one-minute load and its cores, as a simulator's process sees them (it runs on the Mac's own kernel):
    /// said beside a measurement that other work could have disturbed.
    static func hostLoad() -> (average: Double, cores: Int) {
        var loads = [Double](repeating: 0, count: 3)
        return (getloadavg(&loads, 3) > 0 ? loads[0] : -1, ProcessInfo.processInfo.activeProcessorCount)
    }
}

@MainActor
extension XCUIApplication {
    /// The app's own probe (PerfProbe.swift), there when it was launched to be measured.
    var probe: XCUIElement { descendants(matching: .any)["perf.probe"] }

    /// One of the probe's readings, as it stands this moment (nil: not measured yet).
    func reading(_ name: String) -> Double? {
        guard probe.exists, let value = probe.value as? String else { return nil }
        for part in value.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            if pair.count == 2, pair[0] == name { return Double(pair[1]) }
        }
        return nil
    }
}

/// Lets the app and the clock run for a while (the test's own run loop: taps and queries still go through).
@MainActor
func settle(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}
