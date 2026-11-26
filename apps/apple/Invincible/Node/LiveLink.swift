import Foundation

/*
 * The node's live stream, kept open while the app is in front (core's live.ts, GET /api/live): it says which of what the
 * app shows changed, and only that is read again. A port of the web app's lib/live-link.ts, held to the same behaviour by
 * LiveLinkTests (its cases, with a clock in hand), so the iPhone asks the node nothing while nothing changes.
 *
 * LiveLink keeps the stream open. One that ends is opened again at once if it had been open a while, otherwise a second
 * later, then twice as long each time, up to half a minute. One the node refuses (an older node without it, a device that
 * may not read it, a revoked one) is opened again only when told to: the app in front again, the network back. One that
 * says nothing at all for three of the node's beats is taken for dead and opened again; the node says its beat in its
 * hello (an older node, which doesn't, beats every 15 s). `renew` opens a fresh one at once, whatever stands: the network
 * changed under it, so the one open may be dead without a word (Wi-Fi to cellular), and a link that comes back within
 * HELLO_WAIT is never said to have gone.
 *
 * Followers are what the app reads, each for its topics. When the stream comes up, each whose last read began before the
 * stream said hello runs once (what it shows may be from before the node was telling of changes); one read since can't
 * have missed anything. Then each runs only when one of its topics changes. While the stream is down (no hello within
 * HELLO_WAIT, or it can't be opened) each runs at once and then every so often, at its own interval. A follower runs one
 * at a time: what comes meanwhile is merged into one more run after it, and runs come no closer together than its gap.
 */

/// What the live stream says (core's LiveEvent): the topics it tells of, then what changed, and why it ended.
enum LiveEvent: Equatable, Sendable {
    /// The topics this stream tells of (read each now), and how often the node beats on it (ms; nil from an older node).
    case hello(topics: [String], beat: Double?)
    case changed([String])
    case bye(String)

    init?(json: String) {
        struct Frame: Decodable {
            let type: String
            let topics: [String]?
            let beat: Double?
            let reason: String?
        }
        guard let frame = try? JSONDecoder().decode(Frame.self, from: Data(json.utf8)) else { return nil }
        switch frame.type {
        case "hello": self = .hello(topics: frame.topics ?? [], beat: frame.beat.flatMap { $0 >= 250 && $0 <= 60_000 ? $0 : nil })
        case "changed": self = .changed(frame.topics ?? [])
        case "bye": self = .bye(frame.reason ?? "")
        default: return nil
        }
    }
}

/// The clock the link keeps time by: `after` runs a thing after so many milliseconds and returns how to call it off.
struct LiveClock: Sendable {
    let after: @MainActor @Sendable (_ ms: Double, _ run: @escaping @MainActor () -> Void) -> (@MainActor () -> Void)
    let now: @Sendable () -> Double

    /// The real one: the main actor's own sleep, and the wall clock in milliseconds.
    static let real = LiveClock(
        after: { ms, run in
            let timer = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(max(0, ms)))
                if !Task.isCancelled { run() }
            }
            return { timer.cancel() }
        },
        now: { Date().timeIntervalSince1970 * 1000 }
    )
}

@MainActor
final class LiveLink {
    /// A stream that hasn't said hello this long after it was opened is down: what the app shows is read on a timer meanwhile.
    nonisolated static let helloWait: Double = 3_000
    /// The node's beat when its hello doesn't say (core's LIVE_BEAT_MS before nodes said theirs).
    nonisolated static let olderBeat: Double = 15_000
    /// Opening it again after a failure: first after this long, then twice as long each time, up to retryMax.
    nonisolated static let retryFirst: Double = 1_000
    nonisolated static let retryMax: Double = 30_000
    /// A stream that was open at least this long is opened again at once when it ends (the node restarting).
    nonisolated static let steady: Double = 30_000

    /// Who hears where the stream stands.
    struct Handlers {
        /// It is open since `at` (when it said hello), telling of these topics: read now what was read before then.
        var up: @MainActor (_ topics: [String], _ at: Double) -> Void
        var changed: @MainActor (_ topics: [String]) -> Void
        /// It isn't open, and hasn't been for a while (or can't be): read what is shown on a timer until it is.
        var down: @MainActor () -> Void
        /// It was up and went silent for three beats: dead, whatever comes next (said at once, not after HELLO_WAIT).
        var lost: @MainActor () -> Void = {}
    }

    /// Opens the stream: its events as they come; `alive` is called on everything that arrives, its beats too.
    private let open: @MainActor (_ alive: @escaping @MainActor @Sendable () -> Void) -> AsyncThrowingStream<LiveEvent, any Error>
    /// A failure that is the node's refusal: not tried again on a timer.
    private let refused: (any Error) -> Bool
    private let clock: LiveClock

    private var handlers: Handlers?
    private var running = false
    /// The stream being opened or open, by its number; nil: none.
    private var current: Int?
    private var opened = 0
    private var reading: Task<Void, Never>?
    private(set) var up = false
    /// When the open stream said hello, and what it tells of.
    private var upAt: Double = 0
    private var topics: [String] = []
    /// The node's beat, as its last hello said: three of them silent and a stream is gone.
    private(set) var beat = LiveLink.olderBeat
    /// Down has been said since it was last up.
    private var saidDown = false
    private var delay = LiveLink.retryFirst
    private var retrying: (@MainActor () -> Void)?
    private var downing: (@MainActor () -> Void)?
    private var silence: (@MainActor () -> Void)?
    /// The stream that went silent, closed for it (its end says it was lost).
    private var quiet: Int?

    init(open: @escaping @MainActor (_ alive: @escaping @MainActor @Sendable () -> Void) -> AsyncThrowingStream<LiveEvent, any Error>, refused: @escaping (any Error) -> Bool, clock: LiveClock = .real) {
        self.open = open
        self.refused = refused
        self.clock = clock
    }

    /// Nothing at all on the stream for this long, its beats included: it is gone.
    var silent: Double { 3 * beat }

    /// Opens it, and keeps it open (the app is in front).
    func start() {
        guard !running else { return }
        running = true
        delay = Self.retryFirst
        connect()
    }

    /// Closes it, and opens it no more until started (the app gone to the background).
    func stop() {
        running = false
        current = nil
        reading?.cancel()
        reading = nil
        retrying = off(retrying)
        downing = off(downing)
        silence = off(silence)
        up = false
        saidDown = false
    }

    /// Opens it now if it isn't open, refused or not (the app in front again).
    func retry() {
        guard running, current == nil else { return }
        delay = Self.retryFirst
        connect()
    }

    /// Opens a fresh one at once, whatever stands: the network changed, and the one open may be dead without a word.
    /// Up a moment ago, it is said to be down only if the fresh one says no hello in time.
    func renew() {
        guard running else { return }
        let was = up
        current = nil
        reading?.cancel()
        reading = nil
        silence = off(silence)
        retrying = off(retrying)
        up = false
        if was { waitForHello() }
        delay = Self.retryFirst
        connect()
    }

    /// Who is told from now on; told at once where it stands, if it is up or down.
    func attach(_ next: Handlers) {
        handlers = next
        if up { next.up(topics, upAt) } else if saidDown { next.down() }
    }

    private func off(_ cancel: (@MainActor () -> Void)?) -> (@MainActor () -> Void)? {
        cancel?()
        return nil
    }

    private func goUp(_ told: [String], beat: Double?) {
        up = true
        upAt = clock.now()
        saidDown = false
        downing = off(downing)
        topics = told
        self.beat = beat ?? Self.olderBeat
        handlers?.up(told, upAt)
    }

    private func goDown() {
        downing = off(downing)
        guard !up, !saidDown, running else { return }
        saidDown = true
        handlers?.down()
    }

    private func waitForHello() {
        downing = off(downing)
        if !saidDown { downing = clock.after(Self.helloWait) { [weak self] in self?.goDown() } }
    }

    private func watch(_ stream: Int) {
        silence = off(silence)
        silence = clock.after(silent) { [weak self] in
            // Gone quiet: closed, and its end opens another.
            guard let self, self.current == stream else { return }
            self.quiet = stream
            self.reading?.cancel()
        }
    }

    private func connect() {
        retrying = off(retrying)
        opened += 1
        let stream = opened
        current = stream
        watch(stream)
        waitForHello()
        let events = open { [weak self] in
            guard let self, self.current == stream else { return }
            self.watch(stream)
        }
        reading = Task { @MainActor [weak self] in
            var failure: (any Error)?
            var helloAt: Double?
            do {
                for try await event in events {
                    guard let self, self.current == stream else { return }
                    switch event {
                    case .hello(let topics, let beat):
                        helloAt = self.clock.now()
                        self.goUp(topics, beat: beat)
                        // (The node's beat, now known: three of them silent and it is gone.)
                        self.watch(stream)
                    case .changed(let topics):
                        if self.up { self.handlers?.changed(topics) }
                    case .bye:
                        break
                    }
                    if case .bye = event { break }
                }
            } catch {
                failure = error
            }
            guard let self else { return }
            self.ended(stream, helloAt: helloAt, failure: failure)
        }
    }

    /// A stream ended (it was closed, it failed, or it went quiet): opened again as its kind of end says.
    private func ended(_ stream: Int, helloAt: Double?, failure: (any Error)?) {
        // Closed on purpose (stopped, renewed), or another opened since: nothing more of this one.
        guard current == stream else { return }
        current = nil
        reading = nil
        silence = off(silence)
        let was = up
        up = false
        if was, quiet == stream { handlers?.lost() }
        quiet = nil
        if let failure, !(failure is CancellationError), refused(failure) {
            goDown()
            return
        }
        let steady = helloAt.map { clock.now() - $0 >= Self.steady } ?? false
        let wait = steady ? 0 : delay
        delay = steady ? Self.retryFirst : min(delay * 2, Self.retryMax)
        // Up a moment ago: down only if it isn't up again soon. Never up: down now.
        if was { waitForHello() } else { goDown() }
        retrying = clock.after(wait) { [weak self] in self?.connect() }
    }
}

/// `run`, one at a time: what is asked for meanwhile is merged into one more run after it, never closer than `gap` to the
/// last (`last`: when it last ran before this, if it did). `changed` names the topics that changed, or is nil: everything.
@MainActor
final class Paced {
    private let run: @MainActor ([String]?) async -> Void
    private let gap: Double
    private let clock: LiveClock
    private var last: Double
    private var running = false
    /// nil: nothing wanted; `everything`: all of it; otherwise these topics.
    private var wanted: Set<String>?
    private var everything = false
    private var waiting: (@MainActor () -> Void)?

    init(gap: Double, clock: LiveClock, last: Double = -.infinity, run: @escaping @MainActor ([String]?) async -> Void) {
        self.run = run
        self.gap = gap
        self.clock = clock
        self.last = last
    }

    func want(_ topics: [String]?) {
        if topics == nil || everything { everything = true; wanted = [] } else { wanted = (wanted ?? []).union(topics ?? []) }
        go()
    }

    func cancel() {
        wanted = nil
        everything = false
        waiting?()
        waiting = nil
    }

    private func go() {
        guard !running, wanted != nil || everything, waiting == nil else { return }
        let wait = last + gap - clock.now()
        if wait > 0 {
            waiting = clock.after(wait) { [weak self] in
                self?.waiting = nil
                self?.go()
            }
            return
        }
        let changed: [String]? = everything ? nil : wanted.map { $0.sorted() }
        wanted = nil
        everything = false
        running = true
        last = clock.now()
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.run(changed)
            self.running = false
            self.go()
        }
    }
}

/// What the app reads, each for its topics, as the stream stands (above).
@MainActor
final class Followers {
    /// Runs of one follower come no closer together than this, unless it says otherwise.
    nonisolated static let gap: Double = 500

    private final class Follower {
        let topics: Set<String>
        var pace: Paced!
        /// nil: it keeps its own time while the stream is down.
        let every: Double?
        var timer: (@MainActor () -> Void)?
        /// When what it shows was last read (its owner's read, then each run's start); -infinity: never.
        var since: Double

        init(topics: Set<String>, every: Double?, since: Double) {
            self.topics = topics
            self.every = every
            self.since = since
        }
    }

    /// Who reads first: `owner`, whoever follows has just read what it shows; `later`, nothing is read yet, and the
    /// stream's coming up (or going down) reads it.
    enum FirstRead { case owner, later }

    private enum Mode { case off, up, down }

    private let clock: LiveClock
    private var all: [ObjectIdentifier: Follower] = [:]
    private var mode = Mode.off

    init(clock: LiveClock = .real) {
        self.clock = clock
    }

    /// `run` when one of these topics changes while the stream is up (and once when it comes up, if what it shows was read
    /// before); at once and then every `every` ms while it is down (nil: once, and it keeps its own time from there); never
    /// while the app is in the background. Returns how to stop following.
    func follow(_ topics: [String], every: Double?, gap: Double = Followers.gap, first: FirstRead = .owner, run: @escaping @MainActor ([String]?) async -> Void) -> @MainActor () -> Void {
        let read = first == .owner ? clock.now() : -.infinity
        let follower = Follower(topics: Set(topics), every: every, since: read)
        follower.pace = Paced(gap: gap, clock: clock, last: read) { [weak follower, clock] changed in
            follower?.since = clock.now()
            await run(changed)
        }
        let key = ObjectIdentifier(follower)
        all[key] = follower
        if mode == .down { poll(follower) }
        return { [weak self] in
            guard let self, let follower = self.all.removeValue(forKey: key) else { return }
            follower.timer?()
            follower.timer = nil
            follower.pace.cancel()
        }
    }

    /// The stream is up, since `at`: each that last read before then runs once now; then each runs when its topics change.
    func up(at: Double) {
        mode = .up
        for follower in all.values {
            follower.timer?()
            follower.timer = nil
            if follower.since < at { follower.pace.want(nil) }
        }
    }

    func changed(_ topics: [String]) {
        guard mode == .up else { return }
        for follower in all.values {
            let mine = topics.filter { follower.topics.contains($0) }
            if !mine.isEmpty { follower.pace.want(mine) }
        }
    }

    /// The stream is down: each runs now, then every so often.
    func down() {
        mode = .down
        for follower in all.values {
            follower.pace.want(nil)
            poll(follower)
        }
    }

    /// Nothing runs: the app is in the background.
    func off() {
        mode = .off
        for follower in all.values {
            follower.timer?()
            follower.timer = nil
            follower.pace.cancel()
        }
    }

    /// Everything each follower of these topics shows, read now (after a change of yours: it shows at once, before the
    /// stream says so), whatever the stream's state.
    func now(_ topics: [String]) {
        for follower in all.values where !follower.topics.isDisjoint(with: topics) { follower.pace.want(topics.filter { follower.topics.contains($0) }) }
    }

    private func poll(_ follower: Follower) {
        follower.timer?()
        follower.timer = nil
        guard let every = follower.every else { return }
        func tick() {
            follower.pace.want(nil)
            follower.timer = clock.after(every) { tick() }
        }
        follower.timer = clock.after(every) { tick() }
    }
}
