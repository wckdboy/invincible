import Foundation

/*
 * The orbs as fields (the PWA's lib/field-orb.ts, held to it by the vectors; 26 November 2026): the primary's field
 * (Field.swift) is every orb, its in gold with its beam of light through it, each agent's in its own colours. The
 * owner's words: the glyph spheres "still look a little strange/not cool enough, and almost like nipples", and "i dont
 * want them to be too visually distractin"; then, of the heads-up ring it had worn round its field, "remove the old mark
 * around primary. make the primary agent distinct in some other cool way". So a field has no bright middle (its core
 * stays dark), no regular lattice of dots, and no ring round it, its or an agent's; it is still where it is one of many,
 * and moves slowly where it is the one you are looking at. Pure: whose field an orb is, how it is drawn at a size, its
 * beam, how it moves in each mood, its embers, and its ink on a light page. FieldOrbView draws it.
 */

/// Whose field an orb is: its seed (its lines' longitudes and widths), its lean (Field.model's tilt), how many lines, and
/// its colours.
struct FieldIdentity: Equatable, Hashable, Sendable, Decodable {
    let seed: Int
    let tilt: [Double]
    let lines: Int
    let colours: FieldColours
}

enum FieldOrb {
    /// The primary's: the icon's own field, in gold.
    static let primary = FieldIdentity(seed: 11, tilt: [0.42, 0.3, -0.18], lines: 46, colours: Field.aurum)

    /// An agent's: its colours are core's agentColors (the one you chose for it, or its handle's): its key light its tint
    /// lit and its tint, its rim its second colour. Its handle gives the rest: 12 to 20 lines (fewer than its 46, so it
    /// reads at 14 points), their longitudes and widths (its seed), and its lean: its axis turned up to about 40 degrees
    /// either way in the picture, and leaning towards you by 0.25 to 0.5, so it is always seen from the side.
    static func agent(_ id: String, profile: JSONValue? = nil) -> FieldIdentity {
        let colours = AgentOrb.colors(id: id, profile: profile)
        let seed = Orb.seed(id)
        let ay = -0.5 + Orb.rand(seed, 0, 61)
        let az = -0.65 + 1.3 * Orb.rand(seed, 0, 62)
        let towards = 0.25 + 0.25 * Orb.rand(seed, 0, 60)
        // The axis (y, before the lean) ends up with z = cos(az)·sin(ax) + sin(az)·sin(ay)·cos(ax) = R·sin(ax + δ): the
        // lean about x that gives it `towards`.
        let a = cos(az), b = sin(az) * sin(ay)
        let ax = asin(towards / hypot(a, b)) - atan2(b, a)
        return FieldIdentity(
            seed: 1 + Int(seed % 2_147_483_646), tilt: [ax, ay, az], lines: 12 + Int((9 * Orb.rand(seed, 0, 63)).rounded(.down)),
            colours: FieldColours(key: [colours.light, colours.tint], rim: colours.second)
        )
    }

    /// How a field is drawn at a size (points): how many of its lines, points along each, how bold (Field.model's weight),
    /// and how far it reaches in its square (at 1 its widest point is 0.44 to 0.47 of its width from the middle).
    struct Look: Equatable, Hashable, Sendable, Decodable {
        let lines: Int
        let steps: Int
        let weight: Double
        let zoom: Double
    }

    /// A field at a size. Its (`primary`) keeps fewer of its 46 lines where it is small, so it reads at 18 points; every
    /// field fills its square alike (its no longer drawn in, clear of a ring). The larger, the more points along a line, and
    /// the smaller, the bolder.
    static func look(_ identity: FieldIdentity, size: Double, primary: Bool) -> Look {
        let s = size.isFinite ? max(8, size) : 36
        let lines = primary ? min(identity.lines, s < 30 ? 26 : s < 56 ? 34 : 46) : identity.lines
        return Look(lines: lines, steps: Int(jsRound(max(20, min(96, s * 0.55)))), weight: s <= 24 ? 1.5 : s <= 48 ? 1.25 : 1, zoom: 0.94)
    }

    /// Its beam: what marks it out, now its heads-up ring has gone (the owner's word, 26 November 2026: "make the primary
    /// agent distinct in some other cool way"). A blade of light along its field's own axis, out of both its poles, as a
    /// pulsar's jets go: no agent has one. Each half runs from `from` to `to` of the field's units out of its middle (so the
    /// core, r < 0.32, stays dark), `width` of the orb's width across at its root (never under a pixel), narrowing to
    /// nothing at its tip, its light fading as it goes (`beamAt`). On a dark page its light is added as the field's is,
    /// with a close glow `glowWidth` times as wide and `glowAlpha` as strong (no fog); on a light page it is ink,
    /// `inkWidth` times as wide and `inkAlpha` times as strong as its light (ink on white reads thinner than light on
    /// black), its root never under `inkLeast` points each side (so at 34 points it holds as a blade, not a needle), its
    /// ink fading slower than its light does (`beamAt`'s light to the power `inkFade`), over a close tint of its ink
    /// (`inkGlowWidth` times as wide, `inkGlowAlpha` as strong). Its outline is taken at `steps` steps along it. The field
    /// turns about it; it shines as the field does, never past its light at rest (breathing while something waits, dimmer
    /// while queued or paused, its tip red-brown when its work failed).
    enum Beam {
        static let from = 0.36
        static let to = 1.72
        static let width = 1.0 / 40
        static let steps = 16
        static let glowWidth = 3.2
        static let glowAlpha = 0.2
        static let inkWidth = 1.6
        static let inkAlpha = 1.5
        static let inkLeast = 0.85
        static let inkFade = 0.6
        static let inkGlowWidth = 3.2
        static let inkGlowAlpha = 0.24
    }

    /// A half of its beam in an orb's square (its middle 0, its edge 1; x right, y down, as an ember's): its root, out of
    /// its core, and its tip.
    struct Blade: Equatable, Sendable {
        let root: [Double]
        let tip: [Double]
    }

    /// A direction in the field's own space turned as its lean turns its points (Field.at: Rx·Ry·Rz).
    static func leaned(_ v: [Double], _ tilt: [Double]) -> [Double] {
        let (cx, sx, cy, sy, cz, sz) = (cos(tilt[0]), sin(tilt[0]), cos(tilt[1]), sin(tilt[1]), cos(tilt[2]), sin(tilt[2]))
        var x = v[0] * cz - v[1] * sz, y = v[0] * sz + v[1] * cz, z = v[2]
        let x2 = x * cy + z * sy, z2 = -x * sy + z * cy
        x = x2
        z = z2
        let y3 = y * cx - z * sx, z3 = y * sx + z * cx
        y = y3
        z = z3
        return [x, y, z]
    }

    /// Its beam in an orb's square at a zoom: each half's root and tip, along its axis (Field.project's camera, as its
    /// points are seen), the upper half first.
    static func beamLine(_ identity: FieldIdentity, zoom: Double) -> [Blade] {
        let axis = leaned([0, 1, 0], identity.tilt)
        func seen(_ k: Double) -> [Double] {
            // (Placed as a point is: Field.at's points are its units times 1.05.)
            let q = Field.project(x: axis[0] * k * 1.05, y: axis[1] * k * 1.05, z: axis[2] * k * 1.05, size: 0, picture: 2, zoom: zoom)
            return [q.x - 1, q.y - 1]
        }
        let halves = [1.0, -1.0].map { dir in Blade(root: seen(dir * Beam.from), tip: seen(dir * Beam.to)) }
        return halves[0].tip[1] <= halves[1].tip[1] ? halves : [halves[1], halves[0]]
    }

    /// Along a half of its beam, `u` of the way from its root (0) to its tip (1): its width as a share of the root's (it
    /// narrows to a point), how much of its light is left, and how far its colour has gone from its key's lit gold (0)
    /// through its gold (0.5) to its rim's copper (1).
    static func beamAt(_ u: Double) -> (width: Double, light: Double, hue: Double) {
        let t = max(0, min(1, u))
        return (pow(1 - t, 0.55), pow(1 - t, 1.1), t)
    }

    // MARK: How it moves

    /// A mood's motion, slow and calm (your word, 25 November 2026: "slow and calming movement"): radians a second it turns
    /// about its own axis; how bright it is (1 as at rest); a slow breath of brightness (its seconds and its depth), or
    /// none; whether a few embers drift off its rim (its alone); how far its rim has dimmed towards red-brown, 0 to 1.
    struct Motion: Equatable, Sendable {
        struct Breath: Equatable, Sendable, Decodable { let period: Double; let depth: Double }
        let turn: Double
        let glow: Double
        let breath: Breath?
        let embers: Bool
        let rim: Double
    }

    /// The primary's moods: only while something is going on does it move (your word, 26 November 2026: "nothing animating at
    /// rest"): at work it turns, embers drifting off its rim; waiting on you it breathes, turning slowly. At rest (idle),
    /// done (it settles), queued, paused and failed it comes to rest, still, in its mood's light: dimmer while queued or
    /// paused, its rim red-brown when its work failed. (Until 26 November 2026 it turned at rest too, a turn a minute.)
    static let motions: [Orb.Mood: Motion] = [
        .idle: Motion(turn: 0, glow: 1, breath: nil, embers: false, rim: 0),
        .working: Motion(turn: 0.2, glow: 1.08, breath: nil, embers: true, rim: 0),
        .waiting: Motion(turn: 0.08, glow: 1, breath: .init(period: 5.2, depth: 0.2), embers: false, rim: 0),
        .queued: Motion(turn: 0, glow: 0.85, breath: nil, embers: false, rim: 0),
        .paused: Motion(turn: 0, glow: 0.7, breath: nil, embers: false, rim: 0),
        .done: Motion(turn: 0, glow: 1, breath: nil, embers: false, rim: 0),
        .failed: Motion(turn: 0, glow: 0.88, breath: nil, embers: false, rim: 1),
    ]

    /// A mood's motion, its or an agent's. An agent's moves only while it works (your word, 26 November 2026: still in
    /// rows, moving only in its own thread's header while it works), turning as its does at work, with no embers; in every
    /// other mood it comes to rest, in that mood's light.
    static func motion(_ mood: Orb.Mood, agent: Bool) -> Motion {
        let m = motions[mood] ?? motions[.idle]!
        guard agent else { return m }
        return mood == .working ? Motion(turn: m.turn, glow: m.glow, breath: m.breath, embers: false, rim: m.rim) : Motion(turn: 0, glow: m.glow, breath: nil, embers: false, rim: m.rim)
    }

    /// Seconds a speed, a light or a tint takes to ease most of the way (63 %) to a new mood's.
    static let ease = 0.6

    /// What a field carries from one frame to the next, so a change of mood speeds or slows its turning, brightens or dims
    /// it, with no jump: radians it has turned (0 to 2π) and radians a second now; its brightness and its rim's dimming now;
    /// its breath's depth now, how far through a breath it is (0 to 1) and a breath's seconds; how much of its embers show.
    struct Clock: Equatable, Sendable, Decodable {
        var turn: Double
        var speed: Double
        var glow: Double
        var rim: Double
        var depth: Double
        var breath: Double
        var period: Double
        var embers: Double
    }

    /// A field as it is first seen: settled in its motion, at its rest (turned 0, a breath not begun).
    static func clock(_ motion: Motion) -> Clock {
        Clock(turn: 0, speed: motion.turn, glow: motion.glow, rim: motion.rim, depth: motion.breath?.depth ?? 0, breath: 0, period: motion.breath?.period ?? 6, embers: motion.embers ? 1 : 0)
    }

    /// The clock `dt` seconds on, in a motion: each speed and light eased towards the motion's, then turned on. A step longer
    /// than a frame takes (the app coming back) turns nothing a long way at once.
    static func step(_ clock: Clock, _ motion: Motion, _ dt: Double) -> Clock {
        let d = min(Orb.longestStep, max(0, dt))
        let eased = 1 - exp(-d / ease)
        func toward(_ value: Double, _ target: Double) -> Double { value + (target - value) * eased }
        let speed = toward(clock.speed, motion.turn)
        let period = motion.breath?.period ?? clock.period
        return Clock(
            turn: turned(clock.turn + speed * d), speed: speed, glow: toward(clock.glow, motion.glow), rim: toward(clock.rim, motion.rim),
            depth: toward(clock.depth, motion.breath?.depth ?? 0), breath: fract(clock.breath + d / period), period: period,
            embers: toward(clock.embers, motion.embers ? 1 : 0)
        )
    }

    /// Whether a clock has come to its motion: nothing left to ease.
    static func settled(_ clock: Clock, _ motion: Motion) -> Bool {
        func near(_ a: Double, _ b: Double, _ by: Double = 0.002) -> Bool { abs(a - b) <= by }
        return near(clock.speed, motion.turn, 0.0005) && near(clock.glow, motion.glow) && near(clock.rim, motion.rim) && near(clock.depth, motion.breath?.depth ?? 0) && near(clock.embers, motion.embers ? 1 : 0, 0.005)
    }

    /// How many frames a second a field needs now: as few as look smooth (each frame costs a battery). While it eases to a
    /// mood, 30; while its embers drift (slowly: a frame moves one a third of a point at 168 points) or it breathes, 20;
    /// only turning, 15; and none once it has come to rest.
    static func fps(_ clock: Clock, _ motion: Motion) -> Double {
        if !settled(clock, motion) { return 30 }
        if clock.embers > 0.01 || clock.depth > 0.002 { return 20 }
        return clock.speed > 0.0005 ? 15 : 0
    }

    /// An ember: where it is in the orb's square (its middle 0, its edge 1; x right, y down), its radius there, and how
    /// opaque.
    struct Ember: Equatable, Sendable, Decodable {
        let x: Double
        let y: Double
        let r: Double
        let alpha: Double
    }

    /// A moment of a field: how far it is turned, how bright, how far its rim has dimmed, and its embers.
    struct Frame: Equatable, Sendable {
        let turn: Double
        let glow: Double
        let rim: Double
        let embers: [Ember]
    }

    /// Its embers, refined (26 November 2026: few, small and slow, so they say it works without pulling the eye): how
    /// many; each lives 3.6 to 5.6 seconds (then another sets out); where they set out (a share of the way from the middle
    /// to the edge of the orb's square) and how far each drifts; how much they rise as they go; how far round from the
    /// rim's burning side they may set out (degrees either way); their radius; and how long each takes to come into sight
    /// (a share of its life). Always inside its square. Drawn soft (a light that falls away from its middle), never a
    /// hard dot.
    enum Embers {
        static let count = 5
        static let life = (3.6, 5.6)
        static let from = (0.58, 0.64)
        static let drift = (0.08, 0.15)
        static let rise = 0.05
        static let spread = 60.0
        static let size = (0.012, 0.022)
        static let fadeIn = 0.25
    }

    /// Where the rim burns, in degrees clockwise from the top (Field's rim light, seen from the front: lower right).
    static let rimAngle = (atan2(Field.rimLight[0], Field.rimLight[1]) * 180) / Double.pi

    /// A field at `t` seconds, as its clock stands: its breath in its brightness, and (with `embers`) its embers, seeded by
    /// `seed` so two never drift as one.
    static func frame(_ clock: Clock, at t: Double, seed: UInt32 = 0, embers: Bool = false) -> Frame {
        let glow = clock.glow * (1 + clock.depth * sin(2 * Double.pi * clock.breath))
        return Frame(turn: clock.turn, glow: glow, rim: clock.rim, embers: embers && clock.embers > 0.01 ? embersAt(seed, t, clock.embers) : [])
    }

    /// A field still: at its rest (turned 0), in its mood's light (dimmed, or its rim red-brown), with no breath and no
    /// embers. What a row shows, a conversation's history, and every orb when motion is reduced.
    static func still(_ motion: Motion) -> Frame { Frame(turn: 0, glow: motion.glow, rim: motion.rim, embers: []) }

    private static func embersAt(_ seed: UInt32, _ t: Double, _ share: Double) -> [Ember] {
        (0..<Embers.count).map { i in
            let life = Embers.life.0 + (Embers.life.1 - Embers.life.0) * Orb.rand(seed, i, 70)
            let at = t / life + Orb.rand(seed, i, 71)
            let round = at.rounded(.down)
            let u = at - round
            // Each time it sets out, from somewhere else.
            let lot = seed &+ (UInt32(truncatingIfNeeded: Int64(round)) &* 0x9e37_79b1)
            let angle = ((rimAngle + Embers.spread * (2 * Orb.rand(lot, i, 72) - 1)) * Double.pi) / 180
            let reach = Embers.from.0 + (Embers.from.1 - Embers.from.0) * Orb.rand(lot, i, 73) + (Embers.drift.0 + (Embers.drift.1 - Embers.drift.0) * Orb.rand(lot, i, 74)) * u
            let fadeIn = min(1, u / Embers.fadeIn)
            return Ember(
                x: reach * sin(angle),
                y: -reach * cos(angle) - Embers.rise * u,
                r: (Embers.size.0 + (Embers.size.1 - Embers.size.0) * Orb.rand(lot, i, 75)) * (1 - 0.4 * u),
                alpha: share * fadeIn * fadeIn * (3 - 2 * fadeIn) * (1 - u) * (1 - u)
            )
        }
    }

    // MARK: Its colours

    /// Where a failed field's rim dims to: a red-brown, an ember going out.
    static let rimDim = "#5a2416"

    /// A field's colours in a moment: its rim dimmed `rim` of the way (0.7 at most) towards red-brown.
    static func colours(_ colours: FieldColours, rim: Double) -> FieldColours {
        rim > 0.001 ? FieldColours(key: colours.key, rim: AgentOrb.blend(colours.rim, rimDim, 0.7 * min(1, rim))) : colours
    }

    /// How a point's light is shown on a dark page, as the icon shows it: three.js' ACES filmic tone mapping (r160) at the
    /// icon's exposure, to sRGB, 0 to 1 a channel. Bright light goes towards white and the faintest towards black, as on
    /// film: the lit face pale gold, the rim copper, the far lines all but gone.
    static let exposure = 1.12

    static func tone(_ r: Double, _ g: Double, _ b: Double, exposure: Double = exposure) -> (Double, Double, Double) {
        let e = exposure / 0.6
        let x = r * e, y = g * e, z = b * e
        func fit(_ v: Double) -> Double { (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081) }
        let f0 = fit(0.59719 * x + 0.35458 * y + 0.04823 * z), f1 = fit(0.076 * x + 0.90834 * y + 0.01566 * z), f2 = fit(0.0284 * x + 0.13383 * y + 0.83777 * z)
        func srgb(_ v: Double) -> Double {
            let c = max(0, min(1, v))
            return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055
        }
        return (srgb(1.60475 * f0 - 0.53108 * f1 - 0.07367 * f2), srgb(-0.10208 * f0 + 1.10813 * f1 - 0.00605 * f2), srgb(-0.00327 * f0 - 0.07276 * f1 + 1.07602 * f2))
    }

    /// How a field's lines are drawn, from point to point along each (points): a line's width, from `least` where it is
    /// faintest to `least + more` where brightest, times its look's weight; under each line on a dark page, its light again
    /// `glowWidth` times as wide and `glowAlpha` as strong (close, so no fog: "less fog, so it reads clearer"); a line's
    /// width on a light page, `ink` of its width on a dark one at its largest, the same at every size (a look's weight, its
    /// boldness where small, is for light, which spreads): wider, as ink on paper has no glow to carry it (until 26
    /// November 2026, 0.85 of the dark page's at each size: the agents read as thin scribbles there), and never narrower
    /// than `inkLeast` points, so a 14-point face keeps its lines (no glow under them there); and how much of its points'
    /// light a line shows on a dark page, less again where it is smaller than `full`.
    enum Stroke {
        static let least = 0.42
        static let more = 0.5
        static let glowWidth = 3.2
        static let glowAlpha = 0.12
        static let ink = 1.35
        static let inkLeast = 0.55
        static let light = 0.22
        static let full = 96.0
    }

    /// How much of its points' light a field `size` wide shows on a dark page.
    static func strokeLight(_ size: Double) -> Double { Stroke.light * min(1, size / Stroke.full) }

    /// A field's ink on a light page (26 November 2026: it read as "flat line art" there, the agents' above all, which the
    /// icon rounds had turned down): each colour as a saturated ink rather than darkened towards black (which made gold
    /// brown and every tint muddy):
    /// - `key`, `rim`: how far its key's ink and its rim's stand from the page (#fafafa) where fully lit, as a contrast
    ///   ratio (3:1 is a graphic's floor; the key, nearer you, stronger);
    /// - `chroma`: how much more saturated each ink is than its colour, as far as sRGB allows at its lightness;
    /// - sheen: where the key light strikes hardest (past `sheenFrom` of its light), its ink goes up to `sheenMost` of the
    ///   way to its lit colour as an ink `sheenContrast` to 1 from the page: the light page's white-hot, so it reads as
    ///   lit, not drawn;
    /// - `floor`, `curve`: how opaque a line is by its light, from `floor` where the lights leave it to whole where it is
    ///   fully lit, along `curve` (under 1, it gains sooner): the far lines faint but there, so the field keeps its volume.
    enum Ink {
        static let key = 3.4
        static let rim = 3.1
        static let sheenContrast = 2.2
        static let sheenFrom = 0.55
        static let sheenMost = 0.7
        static let chroma = 1.2
        static let floor = 0.22
        static let curve = 0.9
    }

    /// A field's inks on a light page, as sRGB (0 to 255 each): where its key light falls, its key's deep colour as ink, and
    /// where its rim burns, its rim's (`Ink`).
    struct Inks: Equatable, Sendable {
        let key: [Double]
        let rim: [Double]
        /// Where the key light strikes hardest, its lit colour as a lighter ink: the sheen that says it is lit.
        let sheen: [Double]
    }

    /// (A few hundred steps: FieldPainter works them out once for each field's colours, as a frame on a light page reads
    /// them.)
    static func inks(_ colours: FieldColours) -> Inks {
        Inks(key: inkOf(colours.key[1], Ink.key), rim: inkOf(colours.rim, Ink.rim), sheen: inkOf(colours.key[0], Ink.sheenContrast))
    }

    /// A point's ink on a light page, from the key's light on it and the rim's: between its two inks by their shares, and
    /// as opaque as it is lit (`Ink`'s floor and curve), so the field keeps its depth on paper and its far lines don't
    /// vanish.
    static func ink(_ inks: Inks, lit: Double, rim: Double) -> (rgb: [Double], alpha: Double) {
        let total = lit + rim
        let share = total > 0 ? rim / total : 0
        // Where the key strikes hardest (past `sheenFrom` of its light), its sheen: up to `sheenMost` of the way to it.
        let sheen = Ink.sheenMost * max(0, min(1, (lit - Ink.sheenFrom) / (1 - Ink.sheenFrom))) * (1 - share)
        let rgb = (0..<3).map { at in
            let ink = inks.key[at] + (inks.rim[at] - inks.key[at]) * share
            return ink + (inks.sheen[at] - ink) * sheen
        }
        let light = min(1, max(0, lit, rim))
        return (rgb, Ink.floor + (1 - Ink.floor) * pow(light, Ink.curve))
    }

    /// `ink` for each point of each frame on a light page, making nothing: its colour (0 to 255 a channel) and its opacity,
    /// read from `Ink`'s curve taken in 1024 steps (within a thousandth of `ink`'s; a stroke is drawn in sixteen steps of it
    /// anyway).
    static func inkInto(_ inks: Inks, lit: Double, rim: Double) -> (r: Double, g: Double, b: Double, alpha: Double) {
        let total = lit + rim
        let share = total > 0 ? rim / total : 0
        let sheen = Ink.sheenMost * max(0, min(1, (lit - Ink.sheenFrom) / (1 - Ink.sheenFrom))) * (1 - share)
        func channel(_ c: Int) -> Double {
            let ink = inks.key[c] + (inks.rim[c] - inks.key[c]) * share
            return ink + (inks.sheen[c] - ink) * sheen
        }
        return (channel(0), channel(1), channel(2), inkAlpha[Int(jsRound(min(1, max(0, lit, rim)) * 1023))])
    }

    private static let inkAlpha: [Double] = (0..<1024).map { Ink.floor + (1 - Ink.floor) * pow(Double($0) / 1023, Ink.curve) }

    /// A colour as an ink on the light page: its hue kept, its chroma `Ink.chroma` times its own (as far as sRGB goes), and
    /// as light as it can be while it stands `contrast` to 1 from the page (or as it is, where it is darker already).
    static func inkOf(_ hex: String, _ contrast: Double) -> [Double] {
        let (l0, a0, b0) = oklab(Field.linear(hex))
        let c0 = hypot(a0, b0) * Ink.chroma, h = atan2(b0, a0)
        let ch = cos(h), sh = sin(h)
        // The most chroma up to c0 that sRGB holds at a lightness (bisected: 16 steps, under a ten-thousandth of the range,
        // finer than a byte of sRGB can tell).
        func held(_ l: Double) -> Field.Rgb {
            var lo = 0.0, hi = c0
            if inGamut(fromOklab(l, c0 * ch, c0 * sh)) {
                lo = c0
            } else {
                for _ in 0..<16 {
                    let mid = (lo + hi) / 2
                    if inGamut(fromOklab(l, mid * ch, mid * sh)) { lo = mid } else { hi = mid }
                }
            }
            return fromOklab(l, lo * ch, lo * sh)
        }
        let most = (pageLuminance + 0.05) / contrast - 0.05
        var shown = held(l0)
        if relativeLuminance(shown) > most {
            // As light as it may be: the lightness that stands `contrast` from the page (bisected, 16 steps).
            var lo = 0.0, hi = l0
            for _ in 0..<16 {
                let mid = (lo + hi) / 2
                if relativeLuminance(held(mid)) > most { hi = mid } else { lo = mid }
            }
            shown = held(lo)
        }
        return [srgb8(shown.r), srgb8(shown.g), srgb8(shown.b)]
    }

    // (Colour in OKLab, Björn Ottosson's: a lightness and two axes of hue, so an ink keeps its hue as it darkens.)
    /// The light page's own luminance (#fafafa).
    private static let pageLuminance = pow((250.0 / 255 + 0.055) / 1.055, 2.4)

    private static func oklab(_ c: Field.Rgb) -> (Double, Double, Double) {
        let l = cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b)
        let m = cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b)
        let s = cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b)
        return (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
    }

    private static func fromOklab(_ lightness: Double, _ a: Double, _ b: Double) -> Field.Rgb {
        let l = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(lightness - 0.0894841775 * a - 1.291485548 * b, 3)
        return Field.Rgb(r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    }

    private static func inGamut(_ c: Field.Rgb) -> Bool { [c.r, c.g, c.b].allSatisfy { $0 >= -1e-9 && $0 <= 1 + 1e-9 } }

    private static func relativeLuminance(_ c: Field.Rgb) -> Double { 0.2126 * max(0, c.r) + 0.7152 * max(0, c.g) + 0.0722 * max(0, c.b) }

    /// Linear light to an sRGB byte.
    private static func srgb8(_ v: Double) -> Double {
        let c = max(0, min(1, v))
        return jsRound(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055))
    }

    /// JavaScript's Math.round: the nearest whole number, a half towards +∞.
    static func jsRound(_ x: Double) -> Double {
        let down = x.rounded(.down)
        return x - down >= 0.5 ? down + 1 : down
    }

    private static func fract(_ x: Double) -> Double { x - x.rounded(.down) }

    /// An angle as 0 up to 2π radians.
    private static func turned(_ radians: Double) -> Double {
        let r = radians.truncatingRemainder(dividingBy: 2 * Double.pi)
        return r < 0 ? r + 2 * Double.pi : r
    }
}
