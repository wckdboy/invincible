import SwiftUI
import Synchronization

/// The primary as an orb (the PWA's ui/orb.ts): Orb's parts for its size, drawn in the colour of its state: the rings of its
/// heads-up display, its ring of data turning in them, and its sphere of glyphs round its bright nucleus (your words, 25
/// November 2026: "also update the primary's orb", "use glyph and randomness on the orbs, like Jarvis/Ultron in the movies,
/// and my other project Phren"). On a light page its glyphs are ink on paper and its heart is its deep tint. Where it is
/// doing something (`mood`), it moves as that mood does (Orb.Mood; your word, 24 November 2026: "pulsing/moving when doing
/// a task, sitting idle, waiting, done"), a frame at a time and only as often as the mood needs (Orb.fps), its motes and
/// waves reaching out past its square over what is round it, which they never move or take a touch from. Still, as an
/// answer in a conversation's history shows it, and wherever the device asks for reduced motion: one still frame of the
/// same parts. Decorative beside its name; named (`label`) where it stands alone.
///
/// (Since 26 November 2026 its orb is its field, FieldOrbView.swift's PrimaryOrb: this glyph orb is drawn nowhere and is
/// kept, with its vectors, until the Android app's port lands too, when it goes.)
struct GlyphOrb: View {
    var size: CGFloat = 36
    var tone: Orb.Tone = .neutral
    var label: String? = nil
    /// What it is doing: it moves as that mood does, unless motion is reduced. Nil: still.
    var mood: Orb.Mood? = nil
    /// Which orb it is, so one drawn again (a new state, its screen drawn anew) carries on where it was, and a change of
    /// mood fades or bursts rather than starting afresh. Its own when left out: all its orbs move as one.
    var key = "primary"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let paper = scheme == .light
        Group {
            if let mood, !reduceMotion {
                MovingOrb(size: size, tone: tone, mood: mood, key: key, paper: paper)
            } else {
                let orb = PreparedOrb.of(Orb.level(Double(size)), tone)
                Canvas { context, canvas in
                    context.translateBy(x: canvas.width / 2, y: canvas.height / 2)
                    context.scaleBy(x: canvas.width / 200, y: canvas.height / 200)
                    OrbPainter.paint(orb, Orb.still, stage: nil, moment: .still(paper: paper), in: context)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label ?? "")
        .accessibilityAddTraits(.isImage)
        .accessibilityHidden(label == nil)
    }
}

/// The orb moving: its stage's canvas (wider than its square, for its motes and waves) drawn on the animation's
/// timeline at its mood's pace, from its course (OrbCourses); its own square is all it takes of the layout.
private struct MovingOrb: View {
    let size: CGFloat
    let tone: Orb.Tone
    let mood: Orb.Mood
    let key: String
    let paper: Bool
    /// Read again once a mood has arrived, so its pace drops from an arrival's to its own (OrbPace).
    @State private var paced = 0

    var body: some View {
        let _ = paced
        let level = Orb.level(Double(size))
        let stage = Orb.stage(level)
        let orb = PreparedOrb.of(level, tone)
        let seed: UInt32 = key == "primary" ? 0 : Orb.seed(key)
        let reach = size * stage.reach / 100
        let fps = OrbCourses.shared.pace(key: key, mood: mood, level: level)
        TimelineView(.animation(minimumInterval: 1 / fps)) { timeline in
            let t = OrbCourses.seconds(timeline.date)
            Canvas { context, canvas in
                let frame = OrbCourses.shared.frame(key: key, mood: mood, seed: seed, at: t)
                context.translateBy(x: canvas.width / 2, y: canvas.height / 2)
                context.scaleBy(x: size / 200, y: size / 200)
                OrbPainter.paint(orb, frame, stage: stage, moment: OrbMoment(t: t, mood: mood, paper: paper), in: context)
            }
            .frame(width: reach, height: reach)
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .modifier(OrbPace(mood: mood, paced: $paced))
    }
}

/// An agent as an orb (the PWA's ui/orb.ts agentFace; your words, 25 November 2026: "drop the agent avatars, and just
/// use custom/procedurally generated colored particle orbs", "use glyph and randomness on the orbs", "slow and calming
/// movement"): its sphere of glyphs round a bright nucleus, in its own colours (AgentOrb.colors: one you chose, or its
/// handle's), in the light it sits in, with an arc or two of its own turning round it from a row's size up. Its sphere and
/// its arcs are its handle's (OrbSphere.swift): every agent's is its own, the same on every device. In a mood it turns
/// and breathes on its course (`key`; a seat's face shares its seat's lights' course, so its face and its ring move as
/// one); still, and wherever the device asks for reduced motion, it is one still frame. On a light page its glyphs are ink
/// on paper and its heart is its deep tint. It draws inside its square. Decorative beside its name; named (`label`) where
/// it stands alone.
///
/// (Since 26 November 2026 an agent's orb is its field, FieldOrbView.swift's AgentFace: this glyph face is drawn nowhere
/// and is kept, with its vectors, until the Android app's port lands too, when it goes.)
struct GlyphFace: View {
    /// Its handle.
    let id: String
    /// Its saved avatar: a colour you chose for it (core's OrbProfile); anything else is its handle's colour.
    var profile: JSONValue? = nil
    var size: CGFloat = 40
    /// What it is doing, as its orb's mood; nil: still (a speaker in a conversation's history).
    var mood: Orb.Mood? = nil
    var label: String? = nil
    /// Which course it moves on: `face:<handle>` when left out; a seat's face takes its seat's, `seat:<handle>`.
    var key: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let face = PreparedFace.of(id: id, profile: profile, size: Double(size))
        let paper = scheme == .light
        Group {
            if let mood, !reduceMotion {
                MovingFace(face: face, size: size, mood: mood, key: key ?? "face:\(id)", paper: paper)
            } else {
                Canvas { context, canvas in
                    context.translateBy(x: canvas.width / 2, y: canvas.height / 2)
                    context.scaleBy(x: canvas.width / 200, y: canvas.height / 200)
                    OrbPainter.face(face, Orb.still, moment: .still(paper: paper), in: context)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label ?? "")
        .accessibilityAddTraits(.isImage)
        .accessibilityHidden(label == nil)
    }
}

/// An agent's face moving: drawn on the animation's timeline at its mood's pace, from its course (OrbCourses).
private struct MovingFace: View {
    let face: PreparedFace
    let size: CGFloat
    let mood: Orb.Mood
    let key: String
    let paper: Bool
    @State private var paced = 0

    var body: some View {
        let _ = paced
        let fps = OrbCourses.shared.pace(key: key, mood: mood, level: face.level)
        TimelineView(.animation(minimumInterval: 1 / fps)) { timeline in
            let t = OrbCourses.seconds(timeline.date)
            Canvas { context, canvas in
                let frame = OrbCourses.shared.frame(key: key, mood: mood, seed: face.seed, at: t)
                context.translateBy(x: canvas.width / 2, y: canvas.height / 2)
                context.scaleBy(x: canvas.width / 200, y: canvas.height / 200)
                OrbPainter.face(face, frame, moment: OrbMoment(t: t, mood: mood, paper: paper), in: context)
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .modifier(OrbPace(mood: mood, paced: $paced))
    }
}

/// The lights round an agent's face in its seat (the PWA's ui/orb.ts seatLights): its ring's glow breathing, the light
/// running round it, its waves and its motes, in its state's colour, over the still ring StandingRing draws, reaching a
/// quarter past it, at its mood's pace. Its course is `seat:<key>`, the one its face in the seat moves on. `box` is the
/// seat's width and `ring` its ring's line, in points. Nothing where the device asks for reduced motion: the ring says it
/// still.
struct SeatLights: View {
    let box: CGFloat
    let ring: CGFloat
    let standing: Standing
    let key: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var paced = 0

    var body: some View {
        if !reduceMotion {
            let _ = paced
            let stage = Orb.ringStage
            let mood = Orb.Mood(standing)
            let lights = PreparedLights.of(Orb.Tone(standing))
            let seed = Orb.seed(key)
            let course = "seat:\(key)"
            // The ring in the units the stage is drawn in: 100 is its outer edge.
            let width = Double(ring * 200 / box)
            let reach = box * stage.reach / 100
            let fps = OrbCourses.shared.pace(key: course, mood: mood, level: nil)
            TimelineView(.animation(minimumInterval: 1 / fps)) { timeline in
                let t = OrbCourses.seconds(timeline.date)
                Canvas { context, canvas in
                    let frame = OrbCourses.shared.frame(key: course, mood: mood, seed: seed, at: t)
                    context.translateBy(x: canvas.width / 2, y: canvas.height / 2)
                    context.scaleBy(x: box / 200, y: box / 200)
                    OrbPainter.ringLights(frame, r: 100 - width / 2, width: width, stage: stage, lights, in: context)
                }
                .frame(width: reach, height: reach)
            }
            .frame(width: box, height: box)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .modifier(OrbPace(mood: mood, paced: $paced))
        }
    }
}

/// Reads an orb's pace again once its mood has arrived: an arrival (a burst, a fade) is drawn at its lively pace, and the
/// mood after it at its own, which the timeline only takes when its view is drawn anew.
private struct OrbPace: ViewModifier {
    let mood: Orb.Mood
    @Binding var paced: Int

    func body(content: Content) -> some View {
        content.task(id: mood) {
            try? await Task.sleep(for: .seconds(Orb.burstLength + 0.1))
            paced &+= 1
        }
    }
}

/// Each orb's own course, by its key (the PWA's keep and advance): its mood, the one before it, when it changed, whether
/// it burst, its clock, and the moment that was last stepped to. Begun settled on first sight; on a new mood the change
/// starts then. Its clock steps once a moment however many of its orbs are drawn. Behind a lock: a Canvas draws wherever
/// SwiftUI has it draw.
final class OrbCourses: Sendable {
    static let shared = OrbCourses()

    private struct Course {
        var mood: Orb.Mood
        var from: Orb.Mood?
        /// When it arrived at its mood, in seconds; never (minus infinity), on first sight.
        var at: Double
        var burst: Bool
        var clock: Orb.Clock
        var last: Double
    }

    private let courses = Mutex<[String: Course]>([:])
    /// The moment every orb's time is measured from: the app's start, so the numbers stay small.
    private static let epoch = Date()

    static func seconds(_ date: Date) -> Double { date.timeIntervalSince(epoch) }

    /// The orb `key`'s frame at `t`, in `mood`: its course kept, and its clock stepped on to `t` first.
    func frame(key: String, mood: Orb.Mood, seed: UInt32, at t: Double) -> Orb.Frame {
        courses.withLock { all in
            var course = all[key] ?? Course(mood: mood, from: nil, at: -.infinity, burst: false, clock: Orb.clock(mood, seed: seed), last: t)
            if course.mood != mood {
                course.from = course.mood
                course.burst = Orb.bursts(from: course.mood, to: mood)
                course.mood = mood
                course.at = t
            }
            if t > course.last {
                course.clock = Orb.step(course.clock, mood, t - course.last)
                course.last = t
            }
            all[key] = course
            return Orb.frame(mood, course.clock, t, seed: seed, since: course.at.isFinite ? t - course.at : nil, from: course.from, burst: course.burst)
        }
    }

    /// How many frames a second the orb `key` is drawn at now, in `mood` (Orb.fps): settled on first sight, lively while a
    /// new mood arrives (one it hasn't drawn yet arrives now).
    func pace(key: String, mood: Orb.Mood, level: Orb.Level?, at t: Double = OrbCourses.seconds(.now)) -> Double {
        courses.withLock { all in
            guard let course = all[key] else { return Orb.fps(mood, level, since: nil) }
            if course.mood != mood { return Orb.fps(mood, level, since: 0) }
            return Orb.fps(mood, level, since: course.at.isFinite ? t - course.at : nil)
        }
    }
}

/// When a frame is drawn (the PWA's Moment): the time its glyphs change by, its mood (how often they are data, and
/// whether they sag), and whether the page is light, where its glyphs are ink on paper.
struct OrbMoment: Sendable {
    let t: Double
    let mood: Orb.Mood
    let paper: Bool

    /// A still orb's: no time gone, at rest.
    static func still(paper: Bool) -> OrbMoment { OrbMoment(t: 0, mood: .idle, paper: paper) }
}

/// A colour a glyph is drawn in: its six hex digits, which its resolved text is kept by (GlyphTexts), and the colour.
struct GlyphInk: Sendable {
    let hex: String
    let color: Color

    init(_ hex: String) {
        self.hex = hex
        color = Color(hex: hex)
    }
}

/// A sphere's colours: its tint's six shades and its second colour's, farthest to nearest (Orb.sphereShades on a dark
/// page, Orb.paperShades on a light one).
struct GlyphShades: Sendable {
    let tint: [GlyphInk]
    let second: [GlyphInk]

    init(tint: [String], second: [String]) {
        self.tint = tint.map(GlyphInk.init)
        self.second = second.map(GlyphInk.init)
    }
}

/// An orb's parts made ready to draw a frame at a time (the PWA's prepared parts): each one's path in the orb's units and
/// its paint, made once for its level and its tone, so a frame only turns, swells and fills them. What brightens with the
/// glow (the halo, the light round the sphere, the nucleus) keeps its stops, to be painted anew with each frame's glow.
/// What has its white has it twice: white on a dark page, its deep tint on a light one.
struct PreparedOrb: Sendable {
    enum Turn: Sendable { case none, ring, ticks, segments }

    /// A disc's stops, to paint with a frame's glow: their colours on a dark page and on a light one, where they are, and
    /// how opaque each is still.
    struct Stops: Sendable {
        let dark: [Color]
        let paper: [Color]
        let locations: [Double]
        let opacities: [Double]
    }

    enum Paint: Sendable {
        /// A radial gradient lit from `center`, reaching `radius`, on a dark page and on a light one; `glows`: its stops,
        /// where it glows.
        case radial(dark: Gradient, paper: Gradient, center: CGPoint, radius: Double, glows: Stops?)
        /// A stroke in one colour, its ends cut square.
        case stroke(Color, width: Double)
        /// Its data ring: `count` places round `r`, about `share` of them lit with a hex digit `size` high, upright to the
        /// ring, in its lit tint (its deep one on a light page).
        case data(r: Double, count: Int, size: Double, share: Double, dark: GlyphInk, paper: GlyphInk)
        /// Its sphere of glyphs (its own handle's), `r` from the middle, its nearest `glyph` high.
        case sphere(Orb.Sphere, [Orb.SpherePoint], r: Double, glyph: Double, dark: GlyphShades, paper: GlyphShades)
    }

    struct Part: Sendable {
        let name: String
        let path: Path
        let paint: Paint
        let turn: Turn
        let swells: Bool
    }

    let parts: [Part]
    let hasHalo: Bool
    let lights: PreparedLights

    private static let made: [Orb.Level: [Orb.Tone: PreparedOrb]] = {
        var made: [Orb.Level: [Orb.Tone: PreparedOrb]] = [:]
        for level in [Orb.Level.badge, .seat, .full] {
            let size: Double = level == .badge ? 28 : level == .seat ? 64 : 168
            for tone in Orb.Tone.allCases { made[level, default: [:]][tone] = PreparedOrb(Orb.parts(size), Orb.palette(tone), lights: PreparedLights.of(tone)) }
        }
        return made
    }()

    /// The orb of a level in a tone, made the first time it's asked for.
    static func of(_ level: Orb.Level, _ tone: Orb.Tone) -> PreparedOrb { made[level]![tone]! }

    /// Its seed, for its data ring (lib/orb.ts' `orbSeed("primary")`): its sphere's is its handle's too.
    static let primary = Orb.seed("primary")

    private init(_ parts: [Orb.Part], _ palette: Orb.Palette, lights: PreparedLights) {
        // (On a light page its white is its deep tint: a white heart there would be a hole in the paper.)
        let hex = { (ink: Orb.Ink, paper: Bool) -> String in
            switch ink {
            case .tint: palette.tint
            case .light: palette.light
            case .deep: palette.deep
            case .white: paper ? palette.deep : "#ffffff"
            }
        }
        let ink = { (ink: Orb.Ink, paper: Bool) in Color(hex: hex(ink, paper)) }
        self.parts = parts.map { part in
            let turn: Turn = Orb.Moves.ring.contains(part.name) ? .ring : Orb.Moves.ticks.contains(part.name) ? .ticks : Orb.Moves.segments.contains(part.name) ? .segments : .none
            let glows = Orb.Moves.glow.contains(part.name)
            let path: Path, paint: Paint
            switch part.kind {
            case let .disc(r, cx, cy, spread, stops):
                // As SVG's radial gradient in its box: lit from (cx, cy) of the box, reaching `spread` of its width.
                let gradient = { (paper: Bool) in Gradient(stops: stops.map { Gradient.Stop(color: ink($0.ink, paper).opacity($0.opacity), location: $0.at) }) }
                path = OrbPainter.circle(r)
                paint = .radial(
                    dark: gradient(false), paper: gradient(true), center: CGPoint(x: -r + cx * 2 * r, y: -r + cy * 2 * r), radius: spread * 2 * r,
                    glows: glows ? Stops(dark: stops.map { ink($0.ink, false) }, paper: stops.map { ink($0.ink, true) }, locations: stops.map(\.at), opacities: stops.map(\.opacity)) : nil
                )
            case let .ring(r, width, color, opacity, arcs):
                var arcked = Path()
                if let arcs {
                    for arc in arcs {
                        arcked.move(to: OrbPainter.point(r, arc.from))
                        // (Degrees from the top, clockwise: the context's own angles start at three o'clock, y down.)
                        arcked.addArc(center: .zero, radius: r, startAngle: .degrees(arc.from - 90), endAngle: .degrees(arc.to - 90), clockwise: false)
                    }
                } else {
                    arcked = OrbPainter.circle(r)
                }
                path = arcked
                paint = .stroke(ink(color, false).opacity(opacity), width: width)
            case let .ticks(r, count, offset, length, width, color, opacity):
                var ticked = Path()
                for i in 0..<count {
                    let angle = offset + 360 * Double(i) / Double(count)
                    ticked.move(to: OrbPainter.point(r - length / 2, angle))
                    ticked.addLine(to: OrbPainter.point(r + length / 2, angle))
                }
                path = ticked
                paint = .stroke(ink(color, false).opacity(opacity), width: width)
            case let .glyphs(r, count, size, share, color):
                path = Path()
                paint = .data(r: r, count: count, size: size, share: share, dark: GlyphInk(hex(color, false)), paper: GlyphInk(palette.deep))
            case let .sphere(r, count, glyph, second):
                // Its own sphere, its second colour white on a dark page; on a light one, its tint and its deep tint as ink.
                let sphere = Orb.sphere("primary")
                let white = hex(second, false)
                path = Path()
                paint = .sphere(
                    sphere, Orb.spherePoints(sphere, count), r: r, glyph: glyph,
                    dark: GlyphShades(tint: Orb.sphereShades(ink: palette.tint, light: palette.light, deep: palette.deep), second: Orb.sphereShades(ink: white, light: white, deep: palette.light)),
                    paper: GlyphShades(tint: Orb.paperShades(ink: palette.tint, deep: palette.deep), second: Orb.paperShades(ink: palette.deep, deep: AgentOrb.blend(palette.deep, "#000000", 0.4)))
                )
            }
            return Part(name: part.name, path: path, paint: paint, turn: turn, swells: Orb.Moves.swell.contains(part.name))
        }
        hasHalo = parts.contains { $0.name == "halo" }
        self.lights = lights
    }
}

/// An agent's face made ready to draw a frame at a time: its colours (AgentOrb.colors), its sphere at its size, its points
/// and its arcs, and its inks for a dark page and a light one (its line, its heart and its glyphs' shades), made once for
/// each agent, colour and size of face.
struct PreparedFace: Sendable {
    /// Its glyphs' shades, its arcs' line, and its nucleus's heart: on a dark page its lit tint and a warm white, on a
    /// light one its deep tint for both.
    struct Inks: Sendable {
        let shades: GlyphShades
        let line: Color
        let heart: Color
    }

    let seed: UInt32
    let level: Orb.Level
    let look: Orb.SphereLook
    let sphere: Orb.Sphere
    let points: [Orb.SpherePoint]
    let arcs: [Orb.AgentArc]
    let tint: Color
    /// The light it sits in, brightest at its middle.
    let light: Gradient
    let dark: Inks
    let paper: Inks

    @MainActor private static var made: [String: PreparedFace] = [:]

    /// An agent's face at a size, made the first time it's asked for.
    @MainActor static func of(id: String, profile: JSONValue?, size: Double) -> PreparedFace {
        let colors = AgentOrb.colors(id: id, profile: profile)
        let level = Orb.level(size)
        let key = "\(level.rawValue) \(colors.tint) \(id)"
        if let face = made[key] { return face }
        let face = PreparedFace(id: id, colors: colors, level: level)
        // (Few: a face for each agent at each of three sizes. Past these many, all are made again as they're drawn.)
        if made.count >= 512 { made.removeAll(keepingCapacity: true) }
        made[key] = face
        return face
    }

    private init(id: String, colors: AgentOrb.Colors, level: Orb.Level) {
        let look = Orb.agentSphere[level]!
        let sphere = Orb.sphere(id)
        let secondLight = AgentOrb.blend(colors.second, "#ffffff", 0.45)
        let secondDeep = AgentOrb.blend(colors.second, "#000000", 0.52)
        let tint = Color(hex: colors.tint)
        seed = Orb.seed(id)
        self.level = level
        self.look = look
        self.sphere = sphere
        points = Orb.spherePoints(sphere, look.count)
        arcs = Orb.agentArcs(sphere, level)
        self.tint = tint
        light = Gradient(stops: [.init(color: tint.opacity(0.42), location: 0), .init(color: tint.opacity(0.16), location: 0.55), .init(color: tint.opacity(0), location: 1)])
        dark = Inks(
            shades: GlyphShades(tint: Orb.sphereShades(ink: colors.tint, light: colors.light, deep: colors.deep), second: Orb.sphereShades(ink: colors.second, light: secondLight, deep: secondDeep)),
            line: Color(hex: colors.light), heart: Color(hex: "#fff8eb")
        )
        paper = Inks(
            shades: GlyphShades(tint: Orb.paperShades(ink: colors.tint, deep: colors.deep), second: Orb.paperShades(ink: colors.second, deep: secondDeep)),
            line: Color(hex: colors.deep), heart: Color(hex: colors.deep)
        )
    }
}

/// What a tone's lights are painted with (its waves, its light, its motes), made once for each tone: its tint, its lit
/// tint, and a point of light, white at its heart, its lit tint, then its glow fading to nothing.
struct PreparedLights: Sendable {
    let tint: Color
    let light: Color
    let spark: Gradient

    private static let made: [Orb.Tone: PreparedLights] = Dictionary(uniqueKeysWithValues: Orb.Tone.allCases.map { tone in
        let palette = Orb.palette(tone)
        return (tone, PreparedLights(
            tint: Color(hex: palette.tint),
            light: Color(hex: palette.light),
            spark: Gradient(stops: [
                .init(color: .white, location: 0),
                .init(color: Color(hex: palette.light).opacity(0.95), location: 0.18),
                .init(color: Color(hex: palette.tint).opacity(0.4), location: 0.45),
                .init(color: Color(hex: palette.tint).opacity(0), location: 1),
            ])
        ))
    })

    static func of(_ tone: Orb.Tone) -> PreparedLights { made[tone]! }
}

/// Glyphs as text resolved once and drawn again and again (the PWA stamps each from a sprite it draws once, as Phren draws
/// its field from an atlas), kept by glyph, colour and size bucket: the bucket a power of two, which each is drawn scaled
/// from to its own size. In the monospaced system font: medium, and semibold for data.
@MainActor enum GlyphTexts {
    private struct Key: Hashable {
        let char: String
        let bold: Bool
        let ink: String
        let bucket: Double
    }

    private static var kept: [Key: GraphicsContext.ResolvedText] = [:]
    /// Kept no more than this many; past it, all are let go, and resolved again as they're drawn.
    private static let most = 4096

    /// How many are kept now.
    static var count: Int { kept.count }

    /// `char` `size` high (in the context's units), its middle at `point`, in `ink`, as opaque as `opacity`.
    static func draw(_ char: String, bold: Bool, ink: GlyphInk, size: Double, at point: CGPoint, opacity: Double, in context: GraphicsContext) {
        guard size > 0.01, opacity > 0 else { return }
        let bucket = min(64, max(4, pow(2, log2(size).rounded())))
        let key = Key(char: char, bold: bold, ink: ink.hex, bucket: bucket)
        let text: GraphicsContext.ResolvedText
        if let resolved = kept[key] {
            text = resolved
        } else {
            if kept.count >= most { kept.removeAll(keepingCapacity: true) }
            text = context.resolve(Text(char).font(.system(size: bucket, weight: bold ? .semibold : .medium, design: .monospaced)).foregroundStyle(ink.color))
            kept[key] = text
        }
        var placed = context
        placed.opacity = opacity
        placed.translateBy(x: point.x, y: point.y)
        placed.scaleBy(x: size / bucket, y: size / bucket)
        placed.draw(text, at: .zero, anchor: .center)
    }
}

/// Drawing an orb's frame in a context already moved to its middle and scaled to its square's units (200 wide): the
/// parts as the frame moves them (Orb.Moves), and its lights among them, as the PWA's ui/orb.ts draws them; and an agent's
/// face the same way.
@MainActor enum OrbPainter {
    /// Steps a light's tail is drawn in, each brighter and wider than the one behind it.
    private static let tailSteps = 18

    /// The orb's parts as `frame` moves them, at `moment`; with a `stage`, its waves, its light and its motes too (none,
    /// still).
    static func paint(_ orb: PreparedOrb, _ frame: Orb.Frame, stage: Orb.Stage?, moment: OrbMoment, in context: GraphicsContext) {
        if let stage, !orb.hasHalo { waves(frame, stage, orb.lights, in: context) }
        for part in orb.parts {
            if let stage, part.name == Orb.Moves.lightsBefore {
                if let light = frame.comet, let track = stage.comet { comet(light, r: track.r, width: track.width, orb.lights, in: context) }
                motes(Orb.shownMotes(frame, stage), stage, orb.lights, in: context)
            }
            var moved = context
            let turn = switch part.turn {
            case .none: 0.0
            case .ring: frame.ring
            case .ticks: frame.ticks
            case .segments: frame.segments
            }
            if turn != 0 { moved.rotate(by: .degrees(turn)) }
            if part.swells && frame.scale != 1 { moved.scaleBy(x: frame.scale, y: frame.scale) }
            switch part.paint {
            case let .radial(dark, paper, center, radius, glows):
                // What glows is painted anew with this frame's glow (no stop past opaque); the rest as it was made.
                let painted = if let glows, frame.glow != 1 {
                    Gradient(stops: glows.locations.indices.map { n in
                        Gradient.Stop(color: (moment.paper ? glows.paper : glows.dark)[n].opacity(min(1, glows.opacities[n] * frame.glow)), location: glows.locations[n])
                    })
                } else { moment.paper ? paper : dark }
                moved.fill(part.path, with: .radialGradient(painted, center: center, startRadius: 0, endRadius: radius))
            case let .stroke(color, width):
                moved.stroke(part.path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .butt))
            case let .data(r, count, size, share, dark, paper):
                // Its data ring: hex digits in about `share` of its places, each changing on a slow beat of its own,
                // upright to the ring as a dial's numbers are.
                let ink = moment.paper ? paper : dark
                for k in 0..<count {
                    guard let lit = Orb.dataGlyph(PreparedOrb.primary, k, moment.t, share) else { continue }
                    let angle = 360 * Double(k) / Double(count)
                    var placed = moved
                    let at = point(r, angle)
                    placed.translateBy(x: at.x, y: at.y)
                    placed.rotate(by: .degrees(angle))
                    GlyphTexts.draw(lit.char, bold: true, ink: ink, size: size, at: .zero, opacity: lit.alpha, in: placed)
                }
            case let .sphere(sphere, points, r, glyph, dark, paper):
                // Its own sphere, turning as its ring does, three times as far.
                let shown = Orb.sphereFrame(sphere, points, angle: Orb.sphereTurn * frame.ring, radius: r, scale: 1, glyph: glyph, t: moment.t, mood: moment.mood, paper: moment.paper)
                glyphs(shown, moment.paper ? paper : dark, in: moved)
            }
            if let stage, part.name == "halo" { waves(frame, stage, orb.lights, in: context) }
        }
    }

    /// An agent's face as `frame` moves it, at `moment` (the PWA's agentFace): the light it sits in, as strong as its glow
    /// (less on a light page); its arcs, each turning at its own pace against its ring's turning; its nucleus, swelling and
    /// brightening with its breath; and its sphere of glyphs, turning three times as far as its ring.
    static func face(_ face: PreparedFace, _ frame: Orb.Frame, moment: OrbMoment, in context: GraphicsContext) {
        let inks = moment.paper ? face.paper : face.dark
        var lit = context
        lit.opacity = min(1, frame.glow) * (moment.paper ? 0.6 : 1)
        lit.fill(Path(CGRect(x: -100, y: -100, width: 200, height: 200)), with: .radialGradient(face.light, center: .zero, startRadius: 0, endRadius: 96))
        for arc in face.arcs {
            let from = arc.from + arc.speed * frame.ring
            var path = Path()
            path.addArc(center: .zero, radius: arc.r, startAngle: .degrees(from - 90), endAngle: .degrees(from + arc.length - 90), clockwise: false)
            context.stroke(path, with: .color(inks.line.opacity(0.5)), style: StrokeStyle(lineWidth: arc.width, lineCap: .round))
        }
        let heart = face.look.nucleus * 2.2 * frame.scale
        context.fill(circle(heart), with: .radialGradient(Gradient(stops: [
            .init(color: inks.heart.opacity(min(1, 0.95 * frame.glow)), location: 0),
            .init(color: face.tint.opacity(min(1, 0.65 * frame.glow)), location: 0.3),
            .init(color: face.tint.opacity(0), location: 1),
        ]), center: .zero, startRadius: 0, endRadius: heart))
        let shown = Orb.sphereFrame(face.sphere, face.points, angle: Orb.sphereTurn * frame.ring, radius: face.look.r, scale: frame.scale, glyph: face.look.glyph, t: moment.t, mood: moment.mood, paper: moment.paper)
        glyphs(shown, inks.shades, in: context)
    }

    /// A sphere's glyphs as a frame shows them, back to front, each in its colour's shade for how near it is (data in its
    /// second colour, as it reads). The faintest aren't drawn.
    static func glyphs(_ shown: [Orb.ShownGlyph], _ shades: GlyphShades, in context: GraphicsContext) {
        for glyph in shown where glyph.alpha >= 0.02 {
            // (A shade is 0 to 5; one a hair past either end, which no point should be, takes the nearest.)
            let shade = min(5, max(0, glyph.shade))
            let ink = glyph.data ? shades.second[max(3, shade)] : (glyph.second ? shades.second : shades.tint)[shade]
            GlyphTexts.draw(glyph.char, bold: glyph.data, ink: ink, size: glyph.size, at: CGPoint(x: glyph.x, y: glyph.y), opacity: min(1, glyph.alpha), in: context)
        }
    }

    /// An agent's ring's lights: a bloom and a closer glow (its ring's own light, swelling and fading with its breath),
    /// its waves, the light running round it, and its motes. `r` and `width` are its ring's, in the stage's units.
    static func ringLights(_ frame: Orb.Frame, r: Double, width: Double, stage: Orb.Stage, _ lights: PreparedLights, in context: GraphicsContext) {
        if frame.aura > 0.005 {
            let ring = circle(r)
            context.stroke(ring, with: .color(lights.tint.opacity(frame.aura * 0.28)), lineWidth: width * 6)
            context.stroke(ring, with: .color(lights.tint.opacity(frame.aura * 0.6)), lineWidth: width * 2.6)
        }
        waves(frame, stage, lights, in: context)
        if let light = frame.comet { comet(light, r: r, width: max(width * 1.6, 3), lights, in: context) }
        motes(Orb.shownMotes(frame, stage), stage, lights, in: context)
    }

    /// Its waves: rings of its light going out from its edge, thinning and fading as they go.
    private static func waves(_ frame: Orb.Frame, _ stage: Orb.Stage, _ lights: PreparedLights, in context: GraphicsContext) {
        for gone in frame.ripples {
            let r = stage.waves.from + gone * (stage.waves.to - stage.waves.from)
            context.stroke(circle(r), with: .color(lights.tint.opacity(0.6 * pow(1 - gone, 2))), lineWidth: stage.wave * (1 - 0.6 * gone))
        }
    }

    /// Its light: a head of white running round `r`, its tail in the lit tint, fading and thinning behind it.
    private static func comet(_ light: Orb.Light, r: Double, width: Double, _ lights: PreparedLights, in context: GraphicsContext) {
        let step = light.tail / Double(tailSteps)
        for j in 0..<tailSteps {
            let along = Double(j + 1) / Double(tailSteps)
            let from = light.head - light.tail + Double(j) * step
            var path = Path()
            path.addArc(center: .zero, radius: r, startAngle: .degrees(from - 90), endAngle: .degrees(from + step - 90), clockwise: false)
            context.stroke(path, with: .color(lights.light.opacity(light.alpha * pow(along, 1.6))), style: StrokeStyle(lineWidth: width * (0.35 + 0.65 * along), lineCap: .round))
        }
        var glowing = context
        glowing.opacity = light.alpha
        spark(at: point(r, light.head), radius: width * 2.2, lights.spark, in: glowing)
    }

    /// Its motes, each a point of light with a glow round it, where the frame puts them in the stage's band.
    private static func motes(_ shown: [Orb.Mote], _ stage: Orb.Stage, _ lights: PreparedLights, in context: GraphicsContext) {
        for mote in shown where mote.alpha > 0.01 {
            var faded = context
            faded.opacity = mote.alpha
            spark(at: point(stage.band.from + mote.u * (stage.band.to - stage.band.from), mote.angle), radius: stage.mote * mote.size * 2, lights.spark, in: faded)
        }
    }

    private static func spark(at center: CGPoint, radius: Double, _ gradient: Gradient, in context: GraphicsContext) {
        context.fill(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius)), with: .radialGradient(gradient, center: center, startRadius: 0, endRadius: radius))
    }

    nonisolated static func circle(_ r: Double) -> Path { Path(ellipseIn: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r)) }

    /// The point `r` from the middle at `angle` degrees clockwise from the top (y down).
    nonisolated static func point(_ r: Double, _ angle: Double) -> CGPoint {
        let radians = angle * .pi / 180
        return CGPoint(x: r * sin(radians), y: -r * cos(radians))
    }
}
