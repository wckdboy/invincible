import Foundation

/*
 * An orb as a sphere of glyphs round a bright nucleus (the PWA's lib/orb-sphere.ts, held to it by the vectors; your
 * words, 25 November 2026: "custom/procedurally generated colored particle orbs", "use glyph and randomness on the orbs,
 * like Jarvis/Ultron in the movies, and my other project Phren", "slow and calming movement"). Its points are spread
 * evenly over a sphere turning slowly about an axis that leans towards you; each is a monospace glyph from a ladder of
 * brightness, as Phren's field is (`.` at the back to `@` at the front), the nearer ones larger, lighter and more opaque.
 * Each glyph changes, now and then, on a slow beat of its own, fading a little as it does; and once in a while a few
 * become data (a hex digit), more often while it works. Its handle makes it its own: how far it leans, which way it
 * turns, where it starts, which points are its second colour, and which glyphs it shows when. Its colours are
 * AgentOrb.colors for an agent, and its state's for Invincible (Orb.palette). Pure: everything in the orb's square, 200
 * wide and centred on its middle (y down). Worked in the PWA's own order, step for step, so the two compute the same.
 */
extension Orb {
    /// An orb's own way of being a sphere, from its handle: how far its axis leans towards you (12 to 32 degrees), which
    /// way it turns (1: the near side to the right), where it starts (0 to 360 degrees), and how many of its points are
    /// its second colour (18 % to 34 %).
    struct Sphere: Equatable, Sendable {
        let seed: UInt32
        let tilt: Double
        let spin: Double
        let phase: Double
        let share: Double
    }

    static func sphere(_ handle: String) -> Sphere {
        let seed = Orb.seed(handle)
        return Sphere(seed: seed, tilt: 12 + 20 * rand(seed, 0, 21), spin: rand(seed, 0, 22) < 0.5 ? -1 : 1, phase: 360 * rand(seed, 0, 23), share: 0.18 + 0.16 * rand(seed, 0, 24))
    }

    /// How a sphere looks at a size: how many glyphs, the size of its nearest (in the square's units), its radius, and its
    /// nucleus's. Few and large where it is small, many and fine where it is large.
    struct SphereLook: Equatable, Sendable {
        let count: Int
        let glyph: Double
        let r: Double
        let nucleus: Double
    }

    /// An agent's face's sphere, at each size (lib/orb-sphere.ts' AGENT_SPHERE).
    static let agentSphere: [Level: SphereLook] = [
        .badge: SphereLook(count: 30, glyph: 32, r: 74, nucleus: 24),
        .seat: SphereLook(count: 72, glyph: 24, r: 72, nucleus: 20),
        .full: SphereLook(count: 150, glyph: 16, r: 68, nucleus: 17),
    ]

    /// How much further a sphere turns than its ring (the clock's `ring`, in degrees): a whole number, so the turn goes on
    /// smoothly where the ring's comes round to 0 again.
    static let sphereTurn: Double = 3

    /// The glyphs, by brightness: six levels, three of each (Phren's ladder), the farthest first.
    static let glyphLadder: [[String]] = [
        [".", "·", "'"],
        ["·", ":", "-"],
        ["+", ":", "="],
        ["o", "+", "x"],
        ["*", "o", "0"],
        ["#", "*", "@"],
    ]
    /// What a glyph becomes when it is data for a moment.
    static let dataGlyphs = "0123456789ABCDEF".map(String.init)

    /// How often, in each mood, a glyph is data for its beat (at work it reads more), as a share of its beats. Never while
    /// paused or failed.
    static let sphereFlash: [Mood: Double] = [.idle: 0.008, .working: 0.03, .waiting: 0.015, .queued: 0.01, .paused: 0, .done: 0.01, .failed: 0]

    /// A point on the unit sphere (x right, y down, z towards you), whether it is the second colour, and its size (0.7 to
    /// 1 of its orb's largest).
    struct SpherePoint: Equatable, Sendable {
        let x: Double
        let y: Double
        let z: Double
        let second: Bool
        let size: Double
    }

    /// `count` points spread evenly over the sphere (a Fibonacci lattice: each a golden angle round from the last, from the
    /// top to the bottom in even steps).
    static func spherePoints(_ sphere: Sphere, _ count: Int) -> [SpherePoint] {
        let golden = Double.pi * (3 - 5.0.squareRoot())
        return (0..<max(0, count)).map { i in
            let y = 1 - (2 * (Double(i) + 0.5)) / Double(count)
            let r = (1 - y * y).squareRoot()
            let a = Double(i) * golden
            return SpherePoint(x: r * cos(a), y: y, z: r * sin(a), second: rand(sphere.seed, i, 25) < sphere.share, size: 0.7 + 0.3 * rand(sphere.seed, i, 26))
        }
    }

    /// A glyph's character at a moment, whether it is data, and how far it is lit through its beat.
    struct Glyph: Equatable, Sendable {
        let char: String
        let data: Bool
        let fade: Double
    }

    /// Glyph `i`'s character at `t` seconds, by its brightness `level` (0 to 5): it keeps one for a slow beat of its own (2
    /// to 6 seconds), then another of its level, at random; for `flash` of its beats it is data instead. `fade` is how far
    /// it is lit through its beat (0.7 at its ends, where it changes, to 1 in its middle), so a change is soft.
    static func sphereGlyph(_ seed: UInt32, _ i: Int, _ level: Int, _ t: Double, _ flash: Double) -> Glyph {
        let beat = 2 + 4 * rand(seed, i, 30)
        let at = t / beat + rand(seed, i, 31)
        let slot = at.rounded(.down)
        let pick = rand(lot(seed, slot, 0x9e37_79b1), i, 32)
        let data = flash > 0 && rand(lot(seed, slot, 0x85eb_ca77), i, 33) < flash
        let fade = 0.7 + 0.3 * sin(Double.pi * (at - slot))
        let ladder = glyphLadder[max(0, min(5, level))]
        return Glyph(char: data ? dataGlyphs[Int((16 * pick).rounded(.down))] : ladder[Int((3 * pick).rounded(.down))], data: data, fade: fade)
    }

    /// A glyph as it is seen: where it is in the square, how near (0 at the back, 1 at the front), its size (its height,
    /// in the square's units), how opaque, which of its colour's six shades it takes (0 the farthest), whether that colour
    /// is its second, and its character (data or not).
    struct ShownGlyph: Equatable, Sendable {
        let x: Double
        let y: Double
        let near: Double
        let size: Double
        let alpha: Double
        let shade: Int
        let second: Bool
        let char: String
        let data: Bool
    }

    /// The sphere's glyphs at a moment, the farthest first (where two are as near, the one listed first): turned `angle`
    /// degrees about its axis, then its axis leant `tilt` towards you; `radius` in the square's units, `scale` its breath
    /// (the frame's), `glyph` its nearest glyph's size, `t` the time its glyphs change by, and `mood` how often they are
    /// data and whether its lower glyphs sag (failed). `paper`: drawn on a light page, where the near glyphs are the
    /// deeper and the far ones fade to the page, so it is opaque further back.
    static func sphereFrame(_ sphere: Sphere, _ points: [SpherePoint], angle: Double, radius: Double, scale: Double, glyph: Double, t: Double, mood: Mood, paper: Bool = false) -> [ShownGlyph] {
        let a = (sphere.phase + sphere.spin * angle) * Double.pi / 180
        let tilt = sphere.tilt * Double.pi / 180
        let (ca, sa, ct, st) = (cos(a), sin(a), cos(tilt), sin(tilt))
        let reach = radius * scale
        let flash = sphereFlash[mood] ?? 0
        let sag = mood == .failed ? 0.17 * reach : 0
        var shown: [(i: Int, depth: Double, glyph: ShownGlyph)] = []
        shown.reserveCapacity(points.count)
        for (i, p) in points.enumerated() {
            let x = p.x * ca - p.z * sa
            let z = p.x * sa + p.z * ca
            let y = p.y * ct - z * st
            let depth = p.y * st + z * ct
            let near = (depth + 1) / 2
            let shade = min(5, Int((near * 6).rounded(.down)))
            let lit = sphereGlyph(sphere.seed, i, shade, t, flash)
            let alpha = (paper ? 0.45 + 0.55 * near : 0.25 + 0.75 * near) * lit.fade
            shown.append((i, depth, ShownGlyph(
                x: x * reach, y: y * reach + (y > 0 ? sag * y * y : 0), near: near, size: glyph * p.size * (0.6 + 0.55 * near),
                alpha: alpha, shade: shade, second: p.second, char: lit.char, data: lit.data
            )))
        }
        shown.sort { $0.depth != $1.depth ? $0.depth < $1.depth : $0.i < $1.i }
        return shown.map(\.glyph)
    }

    /// A colour's six shades for a dark page, farthest to nearest: from its shadow two thirds of the way to it, then it,
    /// then 30 % and 60 % of the way to its light.
    static func sphereShades(ink: String, light: String, deep: String) -> [String] {
        [deep, AgentOrb.blend(deep, ink, 1.0 / 3), AgentOrb.blend(deep, ink, 2.0 / 3), ink, AgentOrb.blend(ink, light, 0.3), AgentOrb.blend(ink, light, 0.6)]
    }

    /// The same for a light page (Phren's ink on paper): the far side fades towards white, the near side deepens.
    static func paperShades(ink: String, deep: String) -> [String] {
        [AgentOrb.blend(ink, "#ffffff", 0.6), AgentOrb.blend(ink, "#ffffff", 0.4), AgentOrb.blend(ink, "#ffffff", 0.18), ink, AgentOrb.blend(ink, deep, 0.3), AgentOrb.blend(ink, deep, 0.55)]
    }

    /// One of an agent's own arcs round its face (Jarvis's rings, each agent's its own): its radius and width, where it
    /// starts and how long it is (degrees), and how fast it turns against its ring's turning (-1.4 to 1.4 times).
    struct AgentArc: Equatable, Sendable {
        let r: Double
        let width: Double
        let from: Double
        let length: Double
        let speed: Double
    }

    /// An agent's arcs at a size: one or two, of lengths and paces its handle gives it; none on a small face.
    static func agentArcs(_ sphere: Sphere, _ level: Level) -> [AgentArc] {
        guard level != .badge else { return [] }
        let count = 1 + Int((2 * rand(sphere.seed, 0, 40)).rounded(.down))
        return (0..<count).map { k in
            AgentArc(
                r: 95 - 5 * Double(k),
                width: k != 0 ? 1.1 : 1.8,
                from: 360 * rand(sphere.seed, k, 41),
                length: 50 + 130 * rand(sphere.seed, k, 42),
                speed: (rand(sphere.seed, k, 43) < 0.5 ? -1 : 1) * (1 + (2 * rand(sphere.seed, k, 44)).rounded(.down))
            )
        }
    }

    /// One place of the primary's data ring at `t`: whether it is lit (about `share` of them are, by its handle), its hex digit,
    /// changing on a slow beat of its own (2.5 to 7 seconds), and how bright it is (0.45 to 0.85). Nil: unlit.
    static func dataGlyph(_ seed: UInt32, _ k: Int, _ t: Double, _ share: Double) -> (char: String, alpha: Double)? {
        guard rand(seed, k, 50) < share else { return nil }
        let beat = 2.5 + 4.5 * rand(seed, k, 51)
        let slot = (t / beat + rand(seed, k, 52)).rounded(.down)
        let lot = lot(seed, slot, 0x9e37_79b1)
        return (dataGlyphs[Int((16 * rand(lot, k, 53)).rounded(.down))], 0.45 + 0.4 * rand(lot, k, 54))
    }

    /// The seed of a glyph's beat: `(seed + Math.imul(slot, by)) >>> 0`, as the PWA works it (the beat's number as a 32-bit
    /// integer, times `by`, wrapping, added to the seed, wrapping).
    private static func lot(_ seed: UInt32, _ slot: Double, _ by: UInt32) -> UInt32 {
        seed &+ (int32Bits(slot) &* by)
    }

    /// A whole number's 32 bits, as JavaScript's ToInt32 takes them (modulo 2^32; none where it isn't finite).
    private static func int32Bits(_ x: Double) -> UInt32 {
        guard x.isFinite else { return 0 }
        let wrapped = x.rounded(.towardZero).truncatingRemainder(dividingBy: 4_294_967_296)
        return UInt32(wrapped < 0 ? wrapped + 4_294_967_296 : wrapped)
    }
}
