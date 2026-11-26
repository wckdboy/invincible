import Foundation
import Testing
@testable import Invincible

/*
 * The node's live stream as the app keeps it (Node/LiveLink.swift), held to the web app's lib/live-link.test.ts case by
 * case: open while the app is in front, opened again when it ends (at once after a long one, backing off after failures,
 * never on a timer once the node refused it), taken for dead when it says nothing for three of the node's beats, opened
 * afresh at once when the network changes, each opened from where the last left off; and what the app reads, run once
 * when it comes up (resumed: only what changed since, never read, or owed), then only for what changed, polled only
 * while it is down.
 */

/// A clock in hand: `advance` runs what comes due, in order.
@MainActor
final class HeldClock {
    final class State: @unchecked Sendable {
        var now: Double = 0
        var timers: [Timer] = []
    }
    final class Timer: @unchecked Sendable {
        let at: Double
        let run: @MainActor () -> Void
        var off = false
        init(at: Double, run: @escaping @MainActor () -> Void) { self.at = at; self.run = run }
    }

    let state = State()

    var clock: LiveClock {
        let state = self.state
        return LiveClock(
            after: { ms, run in
                let timer = Timer(at: state.now + ms, run: run)
                state.timers.append(timer)
                return { timer.off = true }
            },
            now: { state.now }
        )
    }

    var now: Double { state.now }

    func flush() async {
        for _ in 0..<40 { await Task.yield() }
    }

    func advance(_ ms: Double) async {
        let end = state.now + ms
        while true {
            await flush()
            guard let due = state.timers.filter({ !$0.off && $0.at <= end }).min(by: { $0.at < $1.at }) else { break }
            due.off = true
            state.now = due.at
            due.run()
        }
        state.now = end
        await flush()
    }

    var pending: [Double] { state.timers.filter { !$0.off }.map { $0.at - state.now } }
}

/// Streams the test opens and feeds: each `open` is one, with its events pushed and its end or failure said.
@MainActor
final class HeldStreams {
    final class Opened: @unchecked Sendable {
        let continuation: AsyncThrowingStream<LiveEvent, any Error>.Continuation
        let alive: @MainActor @Sendable () -> Void
        /// The cursor it was opened from (nil: afresh).
        let since: String?
        /// The link closed it (it went quiet, it was stopped or renewed).
        var aborted = false
        init(_ continuation: AsyncThrowingStream<LiveEvent, any Error>.Continuation, since: String?, alive: @escaping @MainActor @Sendable () -> Void) {
            self.continuation = continuation
            self.since = since
            self.alive = alive
        }
        @MainActor func push(_ event: LiveEvent) { alive(); continuation.yield(event) }
        @MainActor func beat() { alive() }
        func end() { continuation.finish() }
        func fail(_ error: any Error) { continuation.finish(throwing: error) }
    }

    var opened: [Opened] = []
    var refuseWith: (any Error)?

    func open(since: String?, alive: @escaping @MainActor @Sendable () -> Void) -> AsyncThrowingStream<LiveEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<LiveEvent, any Error>.makeStream()
        let one = Opened(continuation, since: since, alive: alive)
        continuation.onTermination = { end in if case .cancelled = end { one.aborted = true } }
        if let refuseWith { continuation.finish(throwing: refuseWith) }
        opened.append(one)
        return stream
    }

    var last: Opened { opened[opened.count - 1] }
}

struct Refused: Error {}
struct Unreachable: Error {}

@MainActor
private func link() -> (clock: HeldClock, streams: HeldStreams, told: () -> [String], link: LiveLink) {
    let clock = HeldClock()
    let streams = HeldStreams()
    final class Told: @unchecked Sendable { var lines: [String] = [] }
    let told = Told()
    let link = LiveLink(open: { since, alive in streams.open(since: since, alive: alive) }, refused: { $0 is Refused }, clock: clock.clock)
    link.attach(.init(
        up: { topics, _, changed in told.lines.append("up \(topics.joined(separator: ","))" + (changed.map { " changed:\($0.joined(separator: ","))" } ?? "")) },
        changed: { topics in told.lines.append("changed \(topics.joined(separator: ","))") },
        down: { told.lines.append("down") }
    ))
    return (clock, streams, { told.lines }, link)
}

private func hello(_ topics: String..., beat: Double? = 1_500) -> LiveEvent { .hello(topics: topics, beat: beat) }
private func changed(_ topics: String...) -> LiveEvent { .changed(topics) }
/// A node's of today: where things stand with each, and with a hello opened from a cursor, what changed since.
private func helloAt(_ at: String, _ topics: [String], changed: [String]? = nil) -> LiveEvent { .hello(topics: topics, beat: 1_500, at: at, changed: changed) }
private func changedAt(_ at: String, _ topics: String...) -> LiveEvent { .changed(topics, at: at) }

@MainActor
@Suite struct LiveLinkTests {
    @Test func itsHelloSaysWhatItTellsOfAndEachChangeAfterIsPassedOn() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("actions", "team"))
        streams.last.push(changed("actions"))
        await clock.flush()
        #expect(told() == ["up actions,team", "changed actions"])
        #expect(link.up)
    }

    @Test func oneThatCantBeOpenedIsDownAtOnceAndTriedAgainASecondLaterThenTwiceAsLongUpToHalfAMinute() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.fail(Unreachable())
        await clock.flush()
        #expect(told() == ["down"])
        var gaps: [Double] = []
        for _ in 0..<7 {
            gaps.append(clock.pending.min() ?? -1)
            let before = streams.opened.count
            await clock.advance(gaps.last!)
            #expect(streams.opened.count == before + 1)
            streams.last.fail(Unreachable())
            await clock.flush()
        }
        #expect(gaps == [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
        // Down was said once, not at every failure.
        #expect(told() == ["down"])
    }

    @Test func oneOpenAWhileIsOpenedAgainAtOnceWhenItEndsAndIsntDownIfItsBackSoon() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("fleet"))
        // Open a while, beating as a node does (three silent beats and it would be gone).
        var at: Double = 0
        while at < LiveLink.steady {
            await clock.advance(1_500)
            streams.last.beat()
            at += 1_500
        }
        streams.last.push(.bye("stopping"))
        await clock.advance(0)
        #expect(streams.opened.count == 2)
        await clock.advance(LiveLink.helloWait - 1)
        streams.last.push(hello("fleet"))
        await clock.flush()
        #expect(told() == ["up fleet", "up fleet"])
    }

    @Test func oneThatEndsSoonAfterItOpenedWaitsASecondAndIsDownIfItIsntBackInTime() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("fleet"))
        await clock.flush()
        streams.last.end()
        await clock.flush()
        #expect(streams.opened.count == 1)
        await clock.advance(LiveLink.retryFirst)
        #expect(streams.opened.count == 2)
        await clock.advance(LiveLink.helloWait)
        #expect(told() == ["up fleet", "down"])
    }

    @Test func oneTheNodeRefusesIsDownAndNotTriedAgainOnATimer() async {
        let (clock, streams, told, link) = link()
        streams.refuseWith = Refused()
        link.start()
        await clock.flush()
        #expect(told() == ["down"])
        #expect(clock.pending.isEmpty)
        await clock.advance(10 * 60_000)
        #expect(streams.opened.count == 1)
        // Back in front, or the network back: tried again then.
        streams.refuseWith = nil
        link.retry()
        streams.last.push(hello("notices"))
        await clock.flush()
        #expect(told() == ["down", "up notices"])
    }

    @Test func oneSilentForThreeOfItsNodesBeatsIsTakenForDeadAndOpenedAgainItsBeatsKeepItAlive() async {
        let (clock, streams, _, link) = link()
        link.start()
        streams.last.push(hello("fleet", beat: 1_500))
        await clock.flush()
        #expect(link.silent == 4_500)
        for _ in 0..<5 {
            await clock.advance(link.silent - 1)
            streams.last.beat()
        }
        #expect(streams.opened.count == 1)
        await clock.advance(link.silent)
        #expect(streams.opened[0].aborted)
        await clock.advance(LiveLink.retryFirst)
        #expect(streams.opened.count == 2)
    }

    @Test func anOlderNodesStreamWhoseHelloSaysNoBeatIsGivenItsOld15sBeat() async {
        let (clock, streams, _, link) = link()
        link.start()
        streams.last.push(hello("fleet", beat: nil))
        await clock.flush()
        #expect(link.silent == 45_000)
        await clock.advance(44_999)
        #expect(!streams.opened[0].aborted)
        await clock.advance(1)
        #expect(streams.opened[0].aborted)
    }

    @Test func oneOpenButSayingNoHelloIsDownAfterAWhileAndStaysOpenMeanwhile() async {
        let (clock, streams, told, link) = link()
        link.start()
        await clock.advance(LiveLink.helloWait)
        #expect(told() == ["down"])
        #expect(!streams.last.aborted)
        streams.last.push(hello("turns"))
        await clock.flush()
        #expect(told() == ["down", "up turns"])
    }

    @Test func stoppedItIsClosedAndOpenedNoMoreUntilStarted() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("fleet"))
        await clock.flush()
        link.stop()
        await clock.advance(10 * 60_000)
        #expect(streams.opened.count == 1)
        #expect(streams.opened[0].aborted)
        #expect(told() == ["up fleet"])
        link.start()
        #expect(streams.opened.count == 2)
    }

    @Test func whoAttachesLaterIsToldAtOnceWhereItStands() async {
        let (clock, streams, _, link) = link()
        link.start()
        streams.last.push(hello("pairings"))
        await clock.flush()
        final class Late: @unchecked Sendable { var lines: [String] = [] }
        let late = Late()
        link.attach(.init(up: { topics, _, _ in late.lines.append("up \(topics.joined(separator: ","))") }, changed: { _ in }, down: { late.lines.append("down") }))
        #expect(late.lines == ["up pairings"])
    }

    @Test func renewedAfterTheNetworkChangedAFreshOneIsOpenedAtOnceAndTheOldClosedWithoutSayingDown() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("fleet"))
        await clock.flush()
        link.renew()
        #expect(streams.opened.count == 2)
        await clock.flush()
        #expect(streams.opened[0].aborted)
        await clock.advance(LiveLink.helloWait - 1)
        streams.last.push(hello("fleet"))
        await clock.flush()
        #expect(told() == ["up fleet", "up fleet"])
        // And one that doesn't come back in time is down, then retried as any failure is.
        link.renew()
        await clock.advance(LiveLink.helloWait)
        #expect(told() == ["up fleet", "up fleet", "down"])
    }

    @Test func itIsOpenedAgainFromTheLastCursorItsNodeGaveAHellosOrAChangesThatHelloSaysOnlyWhatChangedSince() async {
        let (clock, streams, told, link) = link()
        link.start()
        #expect(streams.last.since == nil)
        streams.last.push(helloAt("b00t.4", ["actions", "notices"]))
        streams.last.push(changedAt("b00t.5", "actions"))
        await clock.flush()
        streams.last.end()
        await clock.advance(LiveLink.retryFirst)
        #expect(streams.last.since == "b00t.5")
        streams.last.push(helloAt("b00t.7", ["actions", "notices"], changed: ["notices"]))
        await clock.flush()
        // Nothing changed since: nothing to read but the stream.
        streams.last.end()
        await clock.advance(2 * LiveLink.retryFirst)
        #expect(streams.last.since == "b00t.7")
        streams.last.push(helloAt("b00t.7", ["actions", "notices"], changed: []))
        await clock.flush()
        #expect(told() == ["up actions,notices", "changed actions", "up actions,notices changed:notices", "up actions,notices changed:"])
    }

    @Test func inTheBackgroundAndInFrontAgainItOpensFromWhereItLeftOffRenewedToo() async {
        let (clock, streams, _, link) = link()
        link.start()
        streams.last.push(helloAt("b00t.3", ["fleet"]))
        await clock.flush()
        link.stop()
        link.start()
        #expect(streams.last.since == "b00t.3")
        streams.last.push(helloAt("b00t.3", ["fleet"], changed: []))
        await clock.flush()
        // The network changed: a fresh one at once, from where it left off; and one silent too long, from there again.
        link.renew()
        #expect(streams.last.since == "b00t.3")
        await clock.advance(link.silent)
        await clock.advance(LiveLink.retryFirst)
        #expect(streams.opened.count == 4)
        #expect(streams.last.since == "b00t.3")
    }

    @Test func withNoCursorFromItsNodeOrOneThatIsntOneItOpensAfreshAndAStreamOpenedAfreshIsReadAsFresh() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(hello("fleet"))
        await clock.flush()
        // Each ends soon after it opened, and is opened again after its wait (a second, then twice as long each time).
        var wait = LiveLink.retryFirst
        func again() async {
            streams.last.end()
            await clock.advance(wait)
            wait = min(wait * 2, LiveLink.retryMax)
        }
        await again()
        #expect(streams.last.since == nil)
        for notOne in ["a b", "", "b00t.1?x=1", String(repeating: "x", count: 65)] {
            streams.last.push(helloAt(notOne, ["fleet"]))
            await clock.flush()
            await again()
            #expect(streams.last.since == nil, "\(notOne)")
        }
        // (What a hello says changed means nothing from a stream not opened from a cursor.)
        streams.last.push(helloAt("b00t.2", ["fleet"], changed: []))
        await clock.flush()
        #expect(told().last == "up fleet")
    }

    @Test func aHelloThatTellsOfOtherTopicsThanTheStreamBeforeItIsReadAsAFreshOne() async {
        let (clock, streams, told, link) = link()
        link.start()
        streams.last.push(helloAt("b00t.1", ["actions", "secretRequests"]))
        await clock.flush()
        streams.last.end()
        await clock.advance(LiveLink.retryFirst)
        #expect(streams.last.since == "b00t.1")
        streams.last.push(helloAt("b00t.2", ["actions"], changed: []))
        // And what one says changed is held to what it tells of.
        streams.last.end()
        await clock.advance(2 * LiveLink.retryFirst)
        streams.last.push(helloAt("b00t.3", ["actions"], changed: ["actions", "pairings"]))
        await clock.flush()
        #expect(told() == ["up actions,secretRequests", "up actions", "up actions changed:actions"])
    }

    @Test func aCursorIsKeptAndSentOnlyWhenItIsOneAsCoreSays() {
        let cursors = Vectors.shared.live.cursors
        #expect(!cursors.isEmpty)
        for one in cursors {
            #expect(LiveLink.isCursor(one.cursor) == one.kept, "\(one.cursor)")
            #expect(NodeClient.livePath(since: one.cursor) == one.path, "\(one.cursor)")
        }
        #expect(NodeClient.livePath(since: nil) == "/api/live")
    }

    @Test func itsTimingIsTheWebApps() {
        let live = Vectors.shared.live
        #expect(LiveLink.helloWait == live.helloWaitMs)
        #expect(LiveLink.retryFirst == live.retryFirstMs)
        #expect(LiveLink.retryMax == live.retryMaxMs)
        #expect(LiveLink.steady == live.steadyMs)
        #expect(Followers.gap == live.gapMs)
        // A node of today beats every LIVE_BEAT_MS and says so: three silent are gone within five seconds.
        #expect(3 * live.beatMs == live.silentMs)
        #expect(live.silentMs <= 5_000)
    }

    @Test func theStreamsEventsAreReadAsCoreWritesThem() {
        #expect(LiveEvent(json: #"{"type":"hello","topics":["team","actions"],"beat":1500}"#) == .hello(topics: ["team", "actions"], beat: 1_500))
        #expect(LiveEvent(json: #"{"type":"hello","topics":["team"]}"#) == .hello(topics: ["team"], beat: nil))
        // A beat no node would say is no beat.
        #expect(LiveEvent(json: #"{"type":"hello","topics":[],"beat":5}"#) == .hello(topics: [], beat: nil))
        #expect(LiveEvent(json: #"{"type":"changed","topics":["turns"]}"#) == .changed(["turns"]))
        // Where things stand, and opened from a cursor, what changed since (a node of today's).
        #expect(LiveEvent(json: #"{"type":"hello","topics":["team","turns"],"beat":1500,"at":"b00t.4","changed":["turns"]}"#) == .hello(topics: ["team", "turns"], beat: 1_500, at: "b00t.4", changed: ["turns"]))
        #expect(LiveEvent(json: #"{"type":"hello","topics":["team"],"beat":1500,"at":"b00t.4"}"#) == .hello(topics: ["team"], beat: 1_500, at: "b00t.4", changed: nil))
        #expect(LiveEvent(json: #"{"type":"changed","topics":["turns"],"at":"b00t.5"}"#) == .changed(["turns"], at: "b00t.5"))
        #expect(LiveEvent(json: #"{"type":"bye","reason":"revoked"}"#) == .bye("revoked"))
        #expect(LiveEvent(json: #"{"type":"later"}"#) == nil)
    }
}

@MainActor
@Suite struct FollowersTests {
    @MainActor final class Runs: @unchecked Sendable { var lines: [String] = [] }

    private func followers() -> (clock: HeldClock, followers: Followers, runs: Runs, follow: (String, [String], Double?, Followers.FirstRead, Double) -> @MainActor () -> Void) {
        let clock = HeldClock()
        let followers = Followers(clock: clock.clock)
        let runs = Runs()
        let follow = { (name: String, topics: [String], every: Double?, first: Followers.FirstRead, gap: Double) in
            followers.follow(topics, every: every, gap: gap, first: first) { changed in
                runs.lines.append(changed.map { "\(name) \($0.joined(separator: ","))" } ?? name)
            }
        }
        return (clock, followers, runs, follow)
    }

    @Test func whenTheStreamComesUpWhatWasReadBeforeItsHelloIsReadOnceAndAtRestNothingForAMinute() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("inbox", ["actions", "notices"], 15_000, .later, Followers.gap)
        _ = follow("fleet", ["fleet"], 15_000, .owner, Followers.gap)
        await clock.advance(200)
        _ = follow("team", ["team"], 2_000, .owner, Followers.gap)
        followers.up(at: 100)
        await clock.advance(Followers.gap)
        #expect(runs.lines == ["inbox", "fleet"])
        await clock.advance(60_000)
        #expect(runs.lines.count == 2)
        followers.changed(["notices", "team"])
        await clock.advance(Followers.gap)
        #expect(runs.lines.sorted() == ["fleet", "inbox", "inbox notices", "team team"])
    }

    @Test func oneItsOwnerJustReadWaitsItsGapBeforeAChangeRunsItAgain() async {
        let (clock, followers, runs, follow) = followers()
        followers.up(at: 0)
        await clock.advance(1_000)
        _ = follow("team", ["team"], 2_000, .owner, 2_000)
        followers.changed(["team"])
        await clock.advance(1_999)
        #expect(runs.lines.isEmpty)
        await clock.advance(1)
        #expect(runs.lines == ["team team"])
    }

    @Test func whileTheStreamIsDownEachRunsAtOnceAndThenAtItsOwnPaceUpAgainThePollingStops() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("fleet", ["fleet"], 15_000, .owner, Followers.gap)
        _ = follow("room", ["team"], 2_000, .owner, Followers.gap)
        followers.down()
        await clock.advance(15_000)
        #expect(runs.lines.filter { $0 == "fleet" }.count == 2)
        #expect(runs.lines.filter { $0 == "room" }.count == 8)
        runs.lines.removeAll()
        await clock.advance(500)
        followers.up(at: clock.now)
        await clock.advance(60_000)
        #expect(runs.lines.sorted() == ["fleet", "room"])
    }

    @Test func changesWhileOneRunsAreMergedIntoOneMoreRunAfterItNoCloserThanItsGap() async {
        let clock = HeldClock()
        let followers = Followers(clock: clock.clock)
        final class Held: @unchecked Sendable {
            var runs: [[String]?] = []
            var finish: CheckedContinuation<Void, Never>?
        }
        let held = Held()
        _ = followers.follow(["actions", "notices", "questions"], every: nil, gap: 1_000, first: .later) { changed in
            held.runs.append(changed)
            await withCheckedContinuation { held.finish = $0 }
        }
        followers.up(at: clock.now)
        await clock.flush()
        followers.changed(["actions"])
        followers.changed(["notices"])
        followers.changed(["actions"])
        await clock.advance(5_000)
        #expect(held.runs.count == 1)
        #expect(held.runs[0] == nil)
        held.finish?.resume()
        held.finish = nil
        await clock.advance(999)
        #expect(held.runs.count == 2)
        #expect(held.runs[1] == ["actions", "notices"])
        held.finish?.resume()
    }

    @Test func oneThatKeepsItsOwnTimeWhileTheStreamIsDownRunsOnceThenAndIsntPolled() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("underway", ["team", "turns"], nil, .owner, Followers.gap)
        followers.down()
        await clock.advance(60_000)
        #expect(runs.lines == ["underway"])
    }

    @Test func resumedOnlyWhatChangedSinceRunsWithWhatNeverReadAndWhatNothingChangedOfRunsNotAtAll() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("inbox", ["actions", "notices"], 15_000, .owner, Followers.gap)
        _ = follow("fleet", ["fleet"], 15_000, .owner, Followers.gap)
        _ = follow("team", ["team"], 2_000, .later, Followers.gap)
        await clock.advance(1_000)
        followers.up(at: clock.now, changed: ["notices", "pairings"])
        await clock.advance(Followers.gap)
        #expect(runs.lines.sorted() == ["inbox notices", "team"])
        runs.lines.removeAll()
        followers.up(at: clock.now, changed: [])
        await clock.advance(60_000)
        #expect(runs.lines.isEmpty)
    }

    @Test func whatGoingToTheBackgroundCalledOffIsOwedAndRunsOnceTheStreamIsUpAgainResumedOrNot() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("inbox", ["actions"], 15_000, .owner, 2_000)
        _ = follow("fleet", ["fleet"], 15_000, .owner, 2_000)
        followers.up(at: clock.now)
        await clock.advance(100)
        // Told of a change it waits its gap to read, and the app gone to the background before it did.
        followers.changed(["actions"])
        followers.off()
        await clock.advance(10_000)
        #expect(runs.lines.isEmpty)
        followers.up(at: clock.now, changed: [])
        await clock.advance(Followers.gap)
        #expect(runs.lines == ["inbox actions"])
    }

    @Test func toldOfAChangeWhileInTheBackgroundItIsOwedAndRunsOnceTheStreamIsUpAgain() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("notices", ["notices"], 15_000, .owner, Followers.gap)
        followers.off()
        followers.changed(["notices"])
        await clock.advance(60_000)
        #expect(runs.lines.isEmpty)
        followers.up(at: clock.now, changed: [])
        await clock.advance(Followers.gap)
        #expect(runs.lines == ["notices notices"])
    }

    @Test func aRunThatFailedIsOwedNeverTriedAgainByItselfRunAgainOnceTheStreamIsUpAgainWithWhatChangesMeanwhile() async {
        let clock = HeldClock()
        let followers = Followers(clock: clock.clock)
        final class Held: @unchecked Sendable {
            var runs: [[String]?] = []
            var failing = true
        }
        struct Away: Error {}
        let held = Held()
        _ = followers.follow(["actions", "notices"], every: 15_000, gap: Followers.gap, first: .owner) { changed in
            held.runs.append(changed)
            if held.failing { throw Away() }
        }
        followers.up(at: clock.now)
        await clock.advance(Followers.gap)
        followers.changed(["actions"])
        await clock.advance(60_000)
        #expect(held.runs == [["actions"]])
        held.failing = false
        followers.up(at: clock.now, changed: [])
        await clock.advance(Followers.gap)
        #expect(held.runs == [["actions"], ["actions"]])
        // Paid: nothing owed now.
        followers.up(at: clock.now, changed: [])
        await clock.advance(60_000)
        #expect(held.runs.count == 2)
        // Owed and told of another change: both in the one run.
        held.failing = true
        followers.changed(["actions"])
        await clock.advance(Followers.gap)
        held.failing = false
        followers.changed(["notices"])
        await clock.advance(Followers.gap)
        #expect(held.runs.last == ["actions", "notices"])
    }

    @Test func aRunUnderWayWhenTheStreamComesUpAgainThatThenFailsRunsOnceMoreAtOnce() async {
        let clock = HeldClock()
        let followers = Followers(clock: clock.clock)
        final class Held: @unchecked Sendable {
            var runs: [[String]?] = []
            var finish: CheckedContinuation<Bool, Never>?
        }
        struct NetworkWent: Error {}
        let held = Held()
        _ = followers.follow(["actions"], every: 15_000, gap: Followers.gap, first: .owner) { changed in
            held.runs.append(changed)
            let answered = await withCheckedContinuation { held.finish = $0 }
            if !answered { throw NetworkWent() }
        }
        followers.up(at: clock.now)
        await clock.advance(Followers.gap)
        followers.changed(["actions"])
        await clock.flush()
        // Its read hangs on the network that went; the stream renewed meanwhile says nothing changed since (it told this).
        await clock.advance(1_000)
        followers.up(at: clock.now, changed: [])
        await clock.flush()
        #expect(held.runs == [["actions"]])
        held.finish?.resume(returning: false)
        held.finish = nil
        await clock.advance(Followers.gap)
        #expect(held.runs == [["actions"], ["actions"]])
        // Once: one that fails again is owed, as any is.
        held.finish?.resume(returning: false)
        held.finish = nil
        await clock.advance(60_000)
        #expect(held.runs.count == 2)
    }

    @Test func offNothingRunsWhateverChangesAndOneThatStoppedFollowingIsNeverRun() async {
        let (clock, followers, runs, follow) = followers()
        let stop = follow("gone", ["fleet"], 1_000, .owner, Followers.gap)
        _ = follow("inbox", ["actions"], 1_000, .owner, Followers.gap)
        stop()
        followers.down()
        await clock.advance(1_500)
        followers.off()
        runs.lines.removeAll()
        followers.changed(["actions"])
        await clock.advance(60_000)
        #expect(runs.lines.isEmpty)
    }

    @Test func aChangeOfYoursIsReadAtOnceWhateverTheStreamSays() async {
        let (clock, followers, runs, follow) = followers()
        _ = follow("inbox", ["actions", "pairings"], 15_000, .later, Followers.gap)
        followers.now(["pairings"])
        await clock.flush()
        #expect(runs.lines == ["inbox pairings"])
    }
}
