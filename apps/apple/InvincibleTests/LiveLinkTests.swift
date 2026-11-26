import Foundation
import Testing
@testable import Invincible

/*
 * The node's live stream as the app keeps it (Node/LiveLink.swift), held to the web app's lib/live-link.test.ts case by
 * case: open while the app is in front, opened again when it ends (at once after a long one, backing off after failures,
 * never on a timer once the node refused it), taken for dead when it says nothing for three of the node's beats, opened
 * afresh at once when the network changes; and what the app reads, run once when it comes up, then only for what
 * changed, polled only while it is down.
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
        /// The link closed it (it went quiet, it was stopped or renewed).
        var aborted = false
        init(_ continuation: AsyncThrowingStream<LiveEvent, any Error>.Continuation, alive: @escaping @MainActor @Sendable () -> Void) {
            self.continuation = continuation
            self.alive = alive
        }
        @MainActor func push(_ event: LiveEvent) { alive(); continuation.yield(event) }
        @MainActor func beat() { alive() }
        func end() { continuation.finish() }
        func fail(_ error: any Error) { continuation.finish(throwing: error) }
    }

    var opened: [Opened] = []
    var refuseWith: (any Error)?

    func open(alive: @escaping @MainActor @Sendable () -> Void) -> AsyncThrowingStream<LiveEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<LiveEvent, any Error>.makeStream()
        let one = Opened(continuation, alive: alive)
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
    let link = LiveLink(open: { alive in streams.open(alive: alive) }, refused: { $0 is Refused }, clock: clock.clock)
    link.attach(.init(
        up: { topics, _ in told.lines.append("up \(topics.joined(separator: ","))") },
        changed: { topics in told.lines.append("changed \(topics.joined(separator: ","))") },
        down: { told.lines.append("down") }
    ))
    return (clock, streams, { told.lines }, link)
}

private func hello(_ topics: String..., beat: Double? = 1_500) -> LiveEvent { .hello(topics: topics, beat: beat) }
private func changed(_ topics: String...) -> LiveEvent { .changed(topics) }

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
        link.attach(.init(up: { topics, _ in late.lines.append("up \(topics.joined(separator: ","))") }, changed: { _ in }, down: { late.lines.append("down") }))
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
