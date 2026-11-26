import Foundation
import Testing
@testable import Invincible

/// How the orb moves, as the PWA moves it (`lib/orb-motion.ts`; your word, 24 November 2026: "pulsing/moving when doing a
/// task, sitting idle, waiting, done"): each mood's motion, each state's mood, and its clock and frames at given moments,
/// checked against the PWA's own output to within a billionth.
struct OrbMotionTests {
    let motion = Vectors.shared.orb.motion
    static let within = 1e-9

    @Test func eachMoodMovesAsThePWAs() {
        #expect(Set(Orb.Mood.allCases.map(\.rawValue)) == Set(motion.moods.keys))
        for mood in Orb.Mood.allCases {
            let theirs = motion.moods[mood.rawValue]!
            let given = Orb.Motion(
                breath: theirs.breath, swell: theirs.swell,
                turn: .init(ring: theirs.turn.ring, ticks: theirs.turn.ticks, segments: theirs.turn.segments),
                comet: theirs.comet.map { .init(speed: $0.speed, tail: $0.tail) }, ripple: theirs.ripple,
                motes: .init(count: theirs.motes.count, speed: theirs.motes.speed, sway: theirs.motes.sway, flow: Orb.Motion.Flow(rawValue: theirs.motes.flow) ?? .orbit),
                aura: theirs.aura
            )
            #expect(Orb.motion(mood) == given, "\(mood)")
            #expect(Orb.motion(mood).motes.flow.rawValue == theirs.motes.flow, "\(mood)")
        }
    }

    @Test func whatAnAgentIsDoingIsItsOrbsMoodAsThePWAs() {
        let faces = Vectors.shared.faces
        #expect(!faces.moods.isEmpty)
        for item in faces.moods { #expect(Orb.Mood(expression: item.expression).rawValue == item.mood, "\(item.expression)") }
        // One it doesn't know, or none, is at rest.
        #expect(Orb.Mood(expression: "dancing") == .idle)
        #expect(Orb.Mood(expression: nil) == .idle)
    }

    @Test func everyMoodIsSlowAndCalm() {
        // (Your word, 25 November 2026: "slow and calming movement": a breath of 4 to 12 seconds, rings a few degrees a
        // second, a mood arriving over more than a second.)
        for mood in Orb.Mood.allCases {
            let m = Orb.motion(mood)
            #expect(m.breath >= 4 && m.breath <= 12, "\(mood)")
            #expect(abs(m.turn.ring) <= 10 && abs(m.turn.segments) <= 15, "\(mood)")
        }
        #expect(Orb.arrive > 1)
    }

    @Test func eachStateHasThePWAsMood() {
        for item in motion.states { #expect(Orb.Mood(state: item.state).rawValue == item.mood, "\(item.state)") }
        // Where someone stands among the agents are the same as the state the node names.
        for item in motion.states {
            if let standing = Standing(rawValue: item.state) { #expect(Orb.Mood(standing).rawValue == item.mood, "\(item.state)") }
        }
    }

    @Test func itsTimesAreThePWAs() {
        #expect(Orb.arrive == motion.arrive)
        #expect(Orb.burstLength == motion.burst)
        #expect(Orb.burstMotes == motion.burstMotes)
        #expect(Orb.ease == motion.ease)
        #expect(Orb.longestStep == motion.longestStep)
    }

    @Test func eachStageIsThePWAs() {
        #expect(Set(Orb.stages.keys) == Set(motion.stages.keys))
        for (name, theirs) in motion.stages {
            let given = Orb.Stage(
                reach: theirs.reach, band: .init(from: theirs.band[0], to: theirs.band[1]), mote: theirs.mote, share: theirs.share,
                waves: .init(from: theirs.waves[0], to: theirs.waves[1]), wave: theirs.wave, comet: theirs.comet.map { .init(r: $0.r, width: $0.width) }
            )
            #expect(Orb.stages[name] == given, "\(name)")
        }
        #expect(Orb.stage(.full) == Orb.stages["full"])
        #expect(Orb.ringStage == Orb.stages["ring"])
    }

    @Test func aFrameMovesThePartsThePWAsDoes() {
        #expect(Orb.Moves.ring == motion.moves.ring)
        #expect(Orb.Moves.ticks == motion.moves.ticks)
        #expect(Orb.Moves.segments == motion.moves.segments)
        #expect(Orb.Moves.swell == motion.moves.swell)
        #expect(Orb.Moves.glow == motion.moves.glow)
        #expect(Orb.Moves.lightsBefore == motion.moves.lightsBefore)
        // Every part it names is one of the orb's own.
        let names = Set([Orb.Level.badge, .seat, .full].flatMap { level in Orb.parts(level == .badge ? 28 : level == .seat ? 64 : 168).map(\.name) })
        for name in Orb.Moves.ring + Orb.Moves.ticks + Orb.Moves.segments + Orb.Moves.swell + Orb.Moves.glow + [Orb.Moves.lightsBefore] { #expect(names.contains(name), "\(name)") }
    }

    @Test func itBurstsWhereThePWAs() {
        #expect(motion.bursts.count == Orb.Mood.allCases.count * (Orb.Mood.allCases.count + 1))
        for item in motion.bursts {
            let from = item.from.map { Orb.Mood(rawValue: $0)! }
            #expect(Orb.bursts(from: from, to: Orb.Mood(rawValue: item.to)!) == item.bursts, "\(item.from ?? "nil") → \(item.to)")
        }
    }

    @Test func itsSeedsAndRandomNumbersAreThePWAsToTheBit() {
        for item in motion.seeds { #expect(Orb.seed(item.name) == item.seed, "\(item.name)") }
        for item in motion.rands { #expect(Orb.rand(item.seed, item.i, item.k) == item.value, "\(item.seed) \(item.i) \(item.k)") }
    }

    @Test func itsClockIsThePWAsFirstSeenAndStepByStep() {
        for item in motion.clocks {
            Self.expectClose(Orb.clock(Orb.Mood(rawValue: item.mood)!, seed: item.seed), item.clock, "\(item.mood) \(item.seed)")
        }
        var clock = Orb.clock(.idle, seed: 5)
        Self.expectClose(clock, motion.start, "start")
        for (n, item) in motion.steps.enumerated() {
            clock = Orb.step(clock, Orb.Mood(rawValue: item.mood)!, item.dt)
            Self.expectClose(clock, item.clock, "step \(n): \(item.mood) \(item.dt)")
            // On from the PWA's own clock, so one step's drift never hides the next's.
            clock = Self.clock(item.clock)
        }
    }

    @Test func itsFramesAreThePWAs() {
        #expect(!motion.frames.isEmpty)
        for item in motion.frames {
            let mood = Orb.Mood(rawValue: item.mood)!
            let from = item.from.map { Orb.Mood(rawValue: $0)! }
            #expect(Orb.bursts(from: from, to: mood) == item.burst)
            let frame = Orb.frame(mood, Self.clock(item.clock), item.t, seed: item.seed, since: item.since, from: from, burst: item.burst)
            let what = "\(item.mood) from \(item.from ?? "nil") at \(item.t), \(item.since.map { "\($0)" } ?? "settled")"
            let theirs = item.frame
            for (mine, given, name) in [(frame.scale, theirs.scale, "scale"), (frame.glow, theirs.glow, "glow"), (frame.aura, theirs.aura, "aura")] {
                #expect(abs(mine - given) <= Self.within, "\(what): \(name) \(mine) ≠ \(given)")
            }
            for (mine, given, name) in [(frame.ring, theirs.ring, "ring"), (frame.ticks, theirs.ticks, "ticks"), (frame.segments, theirs.segments, "segments")] {
                #expect(Self.apart(mine, given) <= Self.within, "\(what): \(name) \(mine) ≠ \(given)")
            }
            #expect((frame.comet == nil) == (theirs.comet == nil), "\(what): comet")
            if let mine = frame.comet, let given = theirs.comet {
                #expect(Self.apart(mine.head, given.head) <= Self.within && abs(mine.tail - given.tail) <= Self.within && abs(mine.alpha - given.alpha) <= Self.within, "\(what): comet \(mine) ≠ \(given)")
            }
            #expect(frame.ripples.count == theirs.ripples.count, "\(what): ripples")
            for (mine, given) in zip(frame.ripples, theirs.ripples) { #expect(abs(mine - given) <= Self.within, "\(what): ripple \(mine) ≠ \(given)") }
            Self.expectClose(frame.motes, theirs.motes, "\(what): motes")
            Self.expectClose(frame.leaving, theirs.leaving, "\(what): leaving")
            Self.expectClose(frame.sparks, theirs.sparks, "\(what): sparks")
        }
    }

    @Test func eachOrbIsDrawnOnlyAsOftenAsItsMoodNeeds() {
        // An agent's seat's lights (nil): its light running round at work, a slow breath at rest; a seat's and a badge's
        // orb the same, and lively only while a mood arrives.
        #expect(Orb.fps(.working, nil, since: nil) == 30)
        #expect(Orb.fps(.idle, nil, since: nil) == 15)
        #expect(Orb.fps(.waiting, .seat, since: nil) == 15)
        #expect(Orb.fps(.done, .badge, since: 0.4) == 30)
        // A burst is soft and slow now (your word, 25 November 2026: "slow and calming movement"): lively for its 2.6 s.
        #expect(Orb.fps(.done, .badge, since: 1.6) == 30)
        #expect(Orb.fps(.done, .badge, since: Orb.burstLength) == 15)
        // Its welcome's orb, the largest, at twice these.
        #expect(Orb.fps(.working, .full, since: nil) == 60)
        #expect(Orb.fps(.idle, .full, since: nil) == 30)
        #expect(Orb.fps(.failed, .full, since: 1) == 60)
    }

    @Test func anOrbsPaceIsItsCoursesSettledOnFirstSightLivelyWhileAMoodArrives() {
        let courses = OrbCourses.shared
        let key = "test:pace:\(UUID().uuidString)"
        #expect(courses.pace(key: key, mood: .idle, level: nil, at: 10) == 15)
        _ = courses.frame(key: key, mood: .idle, seed: 0, at: 10)
        #expect(courses.pace(key: key, mood: .idle, level: nil, at: 11) == 15)
        // A mood it hasn't drawn yet arrives now; once drawn, it is lively until the arrival is over.
        #expect(courses.pace(key: key, mood: .done, level: nil, at: 11) == 30)
        _ = courses.frame(key: key, mood: .done, seed: 0, at: 11)
        #expect(courses.pace(key: key, mood: .done, level: nil, at: 11.8) == 30)
        #expect(courses.pace(key: key, mood: .done, level: nil, at: 12.61) == 30)
        // (A moment past it: 13.6 − 11 is a hair under 2.6 in binary floating point.)
        #expect(courses.pace(key: key, mood: .done, level: nil, at: 13.61) == 15)
        #expect(courses.pace(key: key, mood: .done, level: .full, at: 14) == 30)
    }

    @Test func stillIsTheOrbAsItsPartsDrawIt() {
        #expect(Orb.still == Orb.Frame(scale: 1, glow: 1, aura: 0, ring: 0, ticks: 0, segments: 0, comet: nil, ripples: [], motes: [], leaving: [], sparks: []))
    }

    @Test func aStageShowsItsShareOfTheMotesAndEverySpark() {
        let frame = Orb.frame(.done, Orb.clock(.working), 30, since: 0.4, from: .working, burst: true)
        #expect(Orb.shownMotes(frame, Orb.stage(.badge)).isEmpty)
        #expect(Orb.shownMotes(frame, Orb.stage(.full)).count == frame.motes.count + frame.leaving.count + frame.sparks.count)
        // An agent's seat: about a third of each mood's own (8 → 3, 16 → 6), and all twelve sparks.
        #expect(Orb.shownMotes(frame, Orb.ringStage).count == 3 + 6 + Orb.burstMotes)
    }

    // ---- within a billionth ----

    /// How far apart two angles are, the short way round.
    private static func apart(_ a: Double, _ b: Double) -> Double { min(abs(a - b), 360 - abs(a - b)) }

    private static func clock(_ given: Vectors.OrbCases.Motion.Clock) -> Orb.Clock {
        Orb.Clock(ring: given.ring, ticks: given.ticks, segments: given.segments, head: given.head, ringSpeed: given.ringSpeed, ticksSpeed: given.ticksSpeed, segmentsSpeed: given.segmentsSpeed, headSpeed: given.headSpeed, tail: given.tail, breath: given.breath, swell: given.swell, light: given.light, aura: given.aura)
    }

    private static func expectClose(_ mine: Orb.Clock, _ given: Vectors.OrbCases.Motion.Clock, _ what: String) {
        for (a, b, name) in [(mine.ring, given.ring, "ring"), (mine.ticks, given.ticks, "ticks"), (mine.segments, given.segments, "segments"), (mine.head, given.head, "head")] {
            #expect(apart(a, b) <= within, "\(what): \(name) \(a) ≠ \(b)")
        }
        for (a, b, name) in [(mine.ringSpeed, given.ringSpeed, "ringSpeed"), (mine.ticksSpeed, given.ticksSpeed, "ticksSpeed"), (mine.segmentsSpeed, given.segmentsSpeed, "segmentsSpeed"), (mine.headSpeed, given.headSpeed, "headSpeed"), (mine.tail, given.tail, "tail"), (mine.breath, given.breath, "breath"), (mine.swell, given.swell, "swell"), (mine.light, given.light, "light"), (mine.aura, given.aura, "aura")] {
            #expect(abs(a - b) <= within, "\(what): \(name) \(a) ≠ \(b)")
        }
    }

    private static func expectClose(_ mine: [Orb.Mote], _ given: [Vectors.OrbCases.Motion.Mote], _ what: String) {
        #expect(mine.count == given.count, "\(what): \(mine.count) ≠ \(given.count)")
        for (n, (a, b)) in zip(mine, given).enumerated() {
            #expect(apart(a.angle, b.angle) <= within && abs(a.u - b.u) <= within && abs(a.size - b.size) <= within && abs(a.alpha - b.alpha) <= within, "\(what) \(n): \(a) ≠ \(b)")
        }
    }
}
