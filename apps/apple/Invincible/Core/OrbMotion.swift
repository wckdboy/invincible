import Foundation

/*
 * How the primary's orb and an agent's seat move (the PWA's lib/orb-motion.ts, held to it by the vectors; your word, 24
 * November 2026: "cool orbs/particles, pulsing/moving when doing a task, sitting idle, waiting, done"), as data and one
 * pure function of time, so a mood moves the same on every device. Each state has a mood:
 * - idle: a slow breath, with a few motes drifting round.
 * - working: the display turns, a light runs round its inner ring, and motes stream in.
 * - waiting on you: an amber beat that sends out waves.
 * - queued: a slow grey light goes round.
 * - paused: nearly still.
 * - done: a burst, then green with a glint going round.
 * - failed: the turning stops and the motes run down its sides.
 *
 * All of it slow and calm (your word, 25 November 2026: "slow and calming movement"): a breath takes 4 to 12 seconds, a
 * ring turns a few degrees a second, and a mood arrives over more than a second. PrimaryOrb, AgentFace and SeatLights
 * draw a frame of it. Nothing moves where the device asks for reduced motion: the still orb
 * is drawn then, which is this function's frame with nothing under way. Nothing here comes from a name's meaning, a
 * profile or a model; an agent's handle only seeds where its motes start. Worked in the PWA's own order, step for step,
 * so the two compute the same numbers.
 */
extension Orb {
    enum Mood: String, CaseIterable, Sendable { case idle, working, waiting, queued, paused, done, failed }

    /// How a mood moves:
    /// - breath: seconds a breath takes, in and out.
    /// - swell: how much the sphere swells with each breath (0.02 is 2 % of its size); its glow swells ten times as much.
    /// - turn: degrees a second the display's rings turn (negative: the other way): the outer ring with its notches, the
    ///   ticks with their marks, and the segments.
    /// - comet: a light running round the inner ring (on an agent's seat, round its own ring): degrees a second, and the
    ///   length of its tail in degrees.
    /// - ripple: seconds between two waves sent out from its edge.
    /// - motes: how many; degrees a second they go round (each between half and one and a half times it); how far each
    ///   strays across its band (a share of it); and whether they go round, stream in, or run down its sides.
    /// - aura: how strongly an agent's ring glows round it, 0 to 1 (the primary's own glow is its orb's halo).
    struct Motion: Equatable, Sendable {
        struct Turn: Equatable, Sendable { let ring: Double; let ticks: Double; let segments: Double }
        struct Comet: Equatable, Sendable { let speed: Double; let tail: Double }
        enum Flow: String, Sendable { case orbit, inward, fall }
        struct Motes: Equatable, Sendable { let count: Int; let speed: Double; let sway: Double; let flow: Flow }

        let breath: Double
        let swell: Double
        let turn: Turn
        let comet: Comet?
        let ripple: Double?
        let motes: Motes
        let aura: Double
    }

    static let motions: [Mood: Motion] = [
        .idle: Motion(breath: 9, swell: 0.01, turn: .init(ring: 1.6, ticks: 0, segments: -2.4), comet: nil, ripple: nil, motes: .init(count: 10, speed: 3.5, sway: 0.2, flow: .orbit), aura: 0.1),
        .working: Motion(breath: 5.2, swell: 0.016, turn: .init(ring: 9, ticks: 2.2, segments: -14), comet: .init(speed: 55, tail: 110), ripple: nil, motes: .init(count: 16, speed: 9, sway: 0, flow: .inward), aura: 0.26),
        .waiting: Motion(breath: 4.2, swell: 0.024, turn: .init(ring: 2.5, ticks: 0, segments: -3.5), comet: nil, ripple: 4.2, motes: .init(count: 10, speed: 4, sway: 0.35, flow: .orbit), aura: 0.34),
        .queued: Motion(breath: 7, swell: 0.01, turn: .init(ring: 4, ticks: 0, segments: -4), comet: .init(speed: 18, tail: 60), ripple: nil, motes: .init(count: 6, speed: 5, sway: 0.12, flow: .orbit), aura: 0.14),
        .paused: Motion(breath: 12, swell: 0.005, turn: .init(ring: 0, ticks: 0, segments: 0), comet: nil, ripple: nil, motes: .init(count: 0, speed: 0, sway: 0, flow: .orbit), aura: 0.05),
        .done: Motion(breath: 8, swell: 0.012, turn: .init(ring: 1, ticks: 0, segments: -1.5), comet: .init(speed: 20, tail: 40), ripple: nil, motes: .init(count: 8, speed: 4, sway: 0.25, flow: .orbit), aura: 0.24),
        .failed: Motion(breath: 6, swell: 0.014, turn: .init(ring: 0, ticks: 0, segments: 0), comet: nil, ripple: nil, motes: .init(count: 6, speed: 0, sway: 0, flow: .fall), aura: 0.24),
    ]

    static func motion(_ mood: Mood) -> Motion { motions[mood]! }

    /// Seconds a new mood takes to arrive: its motes, its light and its waves fade in over them (slowly: your word, 25
    /// November 2026, "slow and calming movement").
    static let arrive: Double = 1.6
    /// Seconds a burst takes (done, and a task's end), and how many motes drift out in it: a soft one.
    static let burstLength: Double = 2.6
    static let burstMotes = 12
    /// Seconds a speed, the swell, the light and the aura take to ease most of the way (63 %) to a new mood's.
    static let ease: Double = 0.35
    /// The longest step a frame takes: one late by more (the app coming back) turns nothing a long way at once.
    static let longestStep: Double = 0.25

    /// Whether a change of mood bursts: arriving at done from any other mood, or at idle straight from work (a task's end
    /// you watched). Never on first sight (`from` nil): opening a page shows where things stand, settled.
    static func bursts(from: Mood?, to: Mood) -> Bool {
        guard let from, from != to else { return false }
        return to == .done || (to == .idle && from == .working)
    }

    /// A mote: degrees clockwise from the top; where it is across its band, from 0 at the inner edge to 1 at the outer;
    /// a share of the largest mote's size (0.5 to 1); and how opaque (0 to 1).
    struct Mote: Equatable, Sendable {
        let angle: Double
        let u: Double
        let size: Double
        let alpha: Double
    }

    /// What an orb carries from one frame to the next, so a change of mood turns or swells nothing with a jump: how far
    /// each turning ring has turned and where its light's head is (degrees); how fast each is turning now, easing to its
    /// mood's; its light's tail, kept while the light fades after a mood without one; how far through a breath it is
    /// (0 to 1); and its swell, its light's brightness and an agent's ring's glow, each easing to its mood's.
    struct Clock: Equatable, Sendable {
        var ring: Double
        var ticks: Double
        var segments: Double
        var head: Double
        var ringSpeed: Double
        var ticksSpeed: Double
        var segmentsSpeed: Double
        var headSpeed: Double
        var tail: Double
        var breath: Double
        var swell: Double
        var light: Double
        var aura: Double
    }

    /// An orb as it is first seen, settled in its mood: its light's head and its breath where its seed puts them, so a
    /// roster of seats never breathes or turns as one.
    static func clock(_ mood: Mood, seed: UInt32 = 0) -> Clock {
        let m = motion(mood)
        return Clock(
            ring: 0, ticks: 0, segments: 0, head: 360 * rand(seed, 0, 7),
            ringSpeed: m.turn.ring, ticksSpeed: m.turn.ticks, segmentsSpeed: m.turn.segments, headSpeed: m.comet?.speed ?? 0,
            tail: m.comet?.tail ?? 0, breath: rand(seed, 0, 8), swell: m.swell, light: m.comet == nil ? 0 : 1, aura: m.aura
        )
    }

    /// The clock `dt` seconds on, in a mood: each speed, the swell, the light and the aura eased towards the mood's, then
    /// each ring and the light's head turned on at its speed, and the breath further through.
    static func step(_ clock: Clock, _ mood: Mood, _ dt: Double) -> Clock {
        let m = motion(mood)
        let d = min(longestStep, max(0, dt))
        let eased = 1 - exp(-d / ease)
        let toward = { (value: Double, target: Double) in value + (target - value) * eased }
        let ringSpeed = toward(clock.ringSpeed, m.turn.ring)
        let ticksSpeed = toward(clock.ticksSpeed, m.turn.ticks)
        let segmentsSpeed = toward(clock.segmentsSpeed, m.turn.segments)
        // A light fading after its mood slows to a stop where it was going; one coming in picks up speed.
        let headSpeed = toward(clock.headSpeed, m.comet?.speed ?? 0)
        return Clock(
            ring: turned(clock.ring + ringSpeed * d),
            ticks: turned(clock.ticks + ticksSpeed * d),
            segments: turned(clock.segments + segmentsSpeed * d),
            head: turned(clock.head + headSpeed * d),
            ringSpeed: ringSpeed,
            ticksSpeed: ticksSpeed,
            segmentsSpeed: segmentsSpeed,
            headSpeed: headSpeed,
            tail: m.comet?.tail ?? clock.tail,
            breath: fract(clock.breath + d / m.breath),
            swell: toward(clock.swell, m.swell),
            light: toward(clock.light, m.comet == nil ? 0 : 1),
            aura: toward(clock.aura, m.aura)
        )
    }

    /// Its light at a moment: its head and its tail in degrees, and how bright it is.
    struct Light: Equatable, Sendable {
        let head: Double
        let tail: Double
        let alpha: Double
    }

    /// A moment of an orb: the sphere's size about its middle; its glow, as a share of the still one's; how strongly a
    /// agent's ring glows round it now; degrees each turning ring is turned; its light, none once it has faded; how far
    /// each wave under way has gone (0 at its edge to 1 at its reach, the newest first); the mood's own motes; while it
    /// arrives, the last mood's, fading; and a burst's sparks, flying out.
    struct Frame: Equatable, Sendable {
        let scale: Double
        let glow: Double
        let aura: Double
        let ring: Double
        let ticks: Double
        let segments: Double
        let comet: Light?
        let ripples: [Double]
        let motes: [Mote]
        let leaving: [Mote]
        let sparks: [Mote]
    }

    /// The still orb, as Orb's parts draw it: nothing turned, swollen or under way. What reduced motion shows.
    static let still = Frame(scale: 1, glow: 1, aura: 0, ring: 0, ticks: 0, segments: 0, comet: nil, ripples: [], motes: [], leaving: [], sparks: [])

    /// An orb in a mood at `t` seconds, measured from any fixed moment, with its clock as it stands then. Its motes and
    /// waves are a function of the time alone, seeded; the rest is the clock's. `since`: seconds since it arrived at this
    /// mood (nil: long ago, settled); `from`: the mood it arrived from, whose motes fade as this one's come in; `burst`:
    /// whether it arrived with one (bursts(from:to:)).
    static func frame(_ mood: Mood, _ clock: Clock, _ t: Double, seed: UInt32 = 0, since given: Double? = nil, from: Mood? = nil, burst: Bool = false) -> Frame {
        let m = motion(mood)
        let since = given.map { max(0, $0) } ?? .infinity
        let arrived = min(1, since / arrive)
        // A burst's motes fly out first; the mood's own come in over its second half.
        let settled = burst ? clamp01((since - burstLength / 2) / (burstLength / 2)) : arrived
        let leaving = if let from, from != mood, arrived < 1 { moodMotes(from, seed, t, 1 - arrived) } else { [Mote]() }
        var sparks: [Mote] = []
        if burst && since < burstLength {
            // Out from the edge to the band's reach and gone: fast, then slowing, as a spark does.
            let progress = since / burstLength
            let out = 1 - pow(1 - progress, 3)
            for i in 0..<burstMotes {
                let a = rand(seed, i, 5)
                let z = rand(seed, i, 6)
                sparks.append(Mote(angle: turned(360 * (Double(i) + a) / Double(burstMotes) + 25 * out), u: out, size: 0.6 + 0.4 * z, alpha: 1 - progress))
            }
        }

        // Each wave lasts one and a half times the time between two, so the next sets out before the last has gone; only
        // those set out since the mood arrived.
        var ripples: [Double] = []
        if let every = m.ripple {
            let life = 1.5 * every
            var k = (t / every).rounded(.down)
            while k * every > t - life {
                let gone = (t - k * every) / life
                if gone >= 0 && gone < 1 && t - k * every <= since { ripples.append(gone) }
                k -= 1
            }
        }

        let breath = sin(2 * .pi * clock.breath)
        let glow = 1 + min(0.4, 10 * clock.swell) * breath
        return Frame(
            scale: 1 + clock.swell * breath,
            glow: glow,
            aura: min(1, clock.aura * glow),
            ring: clock.ring,
            ticks: clock.ticks,
            segments: clock.segments,
            comet: clock.light > 0.01 ? Light(head: clock.head, tail: clock.tail, alpha: clock.light) : nil,
            ripples: ripples,
            motes: moodMotes(mood, seed, t, settled),
            leaving: leaving,
            sparks: sparks
        )
    }

    /// A mood's own motes at `t`, as opaque as `share` of their own.
    private static func moodMotes(_ mood: Mood, _ seed: UInt32, _ t: Double, _ share: Double) -> [Mote] {
        let m = motion(mood)
        var motes: [Mote] = []
        for i in 0..<m.motes.count {
            let a = rand(seed, i, 0), s = rand(seed, i, 1), u0 = rand(seed, i, 2), p = rand(seed, i, 3), z = rand(seed, i, 4)
            let speed = m.motes.speed * (0.5 + s)
            // Each twinkles on a slow breath of its own, between 3 and 7 seconds.
            let twinkle = 0.5 + 0.5 * sin(2 * .pi * (t / (3 + 4 * s) + p))
            let angle: Double, u: Double, alpha: Double
            switch m.motes.flow {
            case .inward:
                // From the band's outer edge to its inner one, turning as it comes, 4 to 7 seconds a pass, then again.
                let phase = fract(t / (4 + 3 * s) + p)
                angle = 360 * a + speed * t + 120 * phase
                u = 1 - phase
                alpha = sin(.pi * phase) * (0.55 + 0.45 * twinkle)
            case .fall:
                // Down one side, from high on it to the foot, faster as it goes, fading, 6 to 10 seconds a run.
                let phase = fract(t / (6 + 4 * s) + p)
                let side: Double = a < 0.5 ? -1 : 1
                let from = side * (20 + 70 * u0)
                angle = from + (side * 180 - from) * phase * phase
                u = clamp01(0.15 + 0.5 * u0 - 0.15 * phase)
                alpha = (1 - phase) * (0.45 + 0.55 * twinkle)
            case .orbit:
                angle = 360 * a + speed * t
                u = clamp01(u0 + m.motes.sway * 0.5 * sin(2 * .pi * (t / (1.7 * m.breath) + p)))
                alpha = 0.35 + 0.65 * twinkle
            }
            motes.append(Mote(angle: turned(angle), u: u, size: 0.5 + 0.5 * z, alpha: alpha * share))
        }
        return motes
    }

    /// Where a frame's moving parts are drawn, at each size of orb and round an agent's face, in the units of the orb's
    /// square (200 wide, centred on its middle; on an agent's seat, 100 is its ring's outer edge): how far from the middle
    /// anything is drawn (past 100 it draws outside its square, and nothing round it moves for that); where its motes go;
    /// the largest mote's radius; how many of a mood's motes it shows; where its waves set out and how far they reach, and
    /// how wide a wave's line is as it sets out (it thins as it goes); and the ring its light runs round, and how wide
    /// (none on an agent's seat, whose light runs round its own ring).
    struct Stage: Equatable, Sendable {
        struct Span: Equatable, Sendable { let from: Double; let to: Double }
        struct Track: Equatable, Sendable { let r: Double; let width: Double }
        let reach: Double
        let band: Span
        let mote: Double
        let share: Double
        let waves: Span
        let wave: Double
        let comet: Track?
    }

    /// Each stage, by the PWA's name: an orb's level (`badge`, `seat`, `full`), and `ring`, an agent's seat.
    static let stages: [String: Stage] = [
        "full": Stage(reach: 150, band: .init(from: 64, to: 134), mote: 3.4, share: 1, waves: .init(from: 60, to: 140), wave: 2.4, comet: .init(r: 70.5, width: 2.4)),
        "seat": Stage(reach: 124, band: .init(from: 70, to: 114), mote: 4.6, share: 0.6, waves: .init(from: 66, to: 120), wave: 4, comet: .init(r: 80, width: 4.5)),
        "badge": Stage(reach: 112, band: .init(from: 84, to: 104), mote: 7, share: 0, waves: .init(from: 78, to: 110), wave: 7, comet: .init(r: 94, width: 6)),
        "ring": Stage(reach: 124, band: .init(from: 88, to: 116), mote: 5.5, share: 0.35, waves: .init(from: 100, to: 122), wave: 5, comet: nil),
    ]

    static func stage(_ level: Level) -> Stage { stages[level.rawValue]! }
    /// Round an agent's face in its seat.
    static var ringStage: Stage { stages["ring"]! }

    /// How a frame moves the orb's parts (by their names), and where its lights are drawn among them: the outer ring and
    /// its notches turn with the frame's `ring`, the ticks and their marks with its `ticks`, the segments and the data
    /// ring with its `segments`; the sphere, its nucleus and the light it sits in swell with its `scale`, and its glows
    /// (the halo, the light round the sphere, the nucleus) brighten with its `glow`. The sphere turns with its `ring`,
    /// three times as far (Orb.sphereTurn). The waves are drawn after the halo (first, where there is none), under every
    /// ring; the light and the motes after the rings, just before the sphere's light, which they pass behind.
    enum Moves {
        static let ring = ["ring", "notches"]
        static let ticks = ["ticks", "marks"]
        static let segments = ["segments", "data"]
        static let swell = ["glow", "nucleus", "sphere"]
        static let glow = ["halo", "glow", "nucleus"]
        static let lightsBefore = "glow"
    }

    /// How many frames a second an orb is drawn at (lib/orb-motion.ts' orbFps): as few as look smooth, since every frame
    /// costs the device its battery. At work, or arriving at a mood (a burst, a fade), the light runs fast: 30. A slow
    /// breath and drifting motes look the same at 15. Its welcome's orb, the largest (`full`), at twice these. `level`
    /// nil is an agent's seat's lights; `since`, seconds since it arrived at its mood (nil: long ago, settled).
    static func fps(_ mood: Mood, _ level: Level?, since: Double?) -> Double {
        let lively = mood == .working || since.map { $0 < burstLength } == true
        return (lively ? 30 : 15) * (level == .full ? 2 : 1)
    }

    /// Which of a frame's motes a stage shows: its share of the mood's own and of the last mood's while they fade, and
    /// every spark; none on a stage too small for motes.
    static func shownMotes(_ frame: Frame, _ stage: Stage) -> [Mote] {
        guard stage.share != 0 else { return [] }
        // (Rounded as the PWA's Math.round is, half up: every count here is positive.)
        let share = { (motes: [Mote]) in Array(motes.prefix(Int((Double(motes.count) * stage.share).rounded(.toNearestOrAwayFromZero)))) }
        return share(frame.motes) + share(frame.leaving) + frame.sparks
    }

    /// A whole number for a name, for its seed: FNV-1a over its UTF-16 code units, as the PWA counts a string's.
    static func seed(_ name: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for unit in name.utf16 { hash = (hash ^ UInt32(unit)) &* 0x0100_0193 }
        return hash
    }

    /// The `k`th random number of mote `i` of an orb seeded `seed`, from 0 up to 1: the same for the same three in every
    /// app (a 32-bit integer hash, lowbias32, in wrapping arithmetic, so no platform's floating point can tell them apart).
    static func rand(_ seed: UInt32, _ i: Int, _ k: Int) -> Double {
        var n = seed ^ (UInt32(truncatingIfNeeded: i + 1) &* 0x9e37_79b1) ^ (UInt32(truncatingIfNeeded: k + 1) &* 0x85eb_ca77)
        n = (n ^ (n >> 16)) &* 0x7feb_352d
        n = (n ^ (n >> 15)) &* 0x846c_a68b
        return Double(n ^ (n >> 16)) / 4_294_967_296
    }

    private static func clamp01(_ x: Double) -> Double { min(1, max(0, x)) }
    private static func fract(_ x: Double) -> Double { x - x.rounded(.down) }
    /// An angle as 0 up to 360 degrees.
    private static func turned(_ degrees: Double) -> Double {
        let r = degrees.truncatingRemainder(dividingBy: 360)
        return r < 0 ? r + 360 : r
    }
}

extension Orb.Mood {
    /// Where someone stands among the agents, as its seat moves (lib/orb-motion.ts' orbMoodOfState): work is working,
    /// needing you is waiting, verified and new are done, failed, paused and queued are their own, at rest is idle.
    init(_ standing: Standing) {
        switch standing {
        case .working: self = .working
        case .needs: self = .waiting
        case .failed: self = .failed
        case .paused: self = .paused
        case .queued: self = .queued
        case .verified, .unread: self = .done
        case .resting: self = .idle
        }
    }

    /// A state as the node and the PWA name it; one it doesn't know is idle.
    init(state: String?) { self = Standing(rawValue: state ?? "").map(Orb.Mood.init) ?? .idle }

    /// What an agent is doing where only that is known (AgentOrb.expression), as its orb's mood (lib/orb-motion.ts'
    /// orbMoodOfExpression): thinking, at work, reading, browsing and checking are work; waiting is queued; asking your
    /// leave waits on you; pleased is done; concerned is failed; resting is paused; idle, and anything else, is idle.
    init(expression: String?) {
        switch expression {
        case "thinking", "working", "reading", "browsing", "checking": self = .working
        case "waiting": self = .queued
        case "asking": self = .waiting
        case "pleased": self = .done
        case "concerned": self = .failed
        case "resting": self = .paused
        default: self = .idle
        }
    }
}
