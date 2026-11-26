import CoreGraphics
import Foundation
import Testing
@testable import Invincible

extension Vectors {
    /// The orbs as fields (the PWA's own lib/field.ts and lib/field-orb.ts): the lights, whose field each is, a field's
    /// lines and points at given turns, where they fall on a picture, each size's look, its beam, how a field moves in each
    /// mood (its clock, its frames, its embers), its tints and its light and ink.
    struct FieldCases: Decodable {
        struct Lights: Decodable { let key: [Double]; let rim: [Double]; let exposure: Double }
        struct Agent: Decodable { let handle: String; let profile: JSONValue?; let field: FieldIdentity }
        struct Linear: Decodable { let hex: String; let rgb: [Double] }
        struct Shade: Decodable {
            struct Shown: Decodable { let rgb: [Double]; let k: Double; let lit: Double; let rim: Double }
            let n: [Double]
            let colours: FieldColours
            let shade: Shown
        }
        struct Model: Decodable { let lines: Int; let seed: Int; let phi: [Double]; let width: [Double] }
        struct Points: Decodable {
            struct Options: Decodable { let lines: Int; let steps: Int; let tilt: [Double]; let seed: Int; let colours: FieldColours; let weight: Double; let turn: Double }
            struct Point: Decodable { let at: Int; let x: Double; let y: Double; let z: Double; let rgb: [Double]; let size: Double; let lit: Double; let rim: Double }
            let who: String
            let size: Double
            let primary: Bool
            let turn: Double
            let rim: Double
            let options: Options
            let colours: FieldColours
            let points: [Point]
        }
        struct Projection: Decodable {
            struct Shown: Decodable { let x: Double; let y: Double; let d: Double; let visible: Bool }
            let who: String
            let size: Double
            let zoom: Double
            let shown: [Shown]
        }
        struct LookCase: Decodable { let who: String; let size: Double; let primary: Bool; let look: FieldOrb.Look }
        struct Beam: Decodable {
            struct Spread: Decodable { let width: Double; let alpha: Double }
            struct Ink: Decodable { let width: Double; let alpha: Double; let least: Double; let fade: Double; let glow: Spread }
            struct Half: Decodable { let root: [Double]; let tip: [Double] }
            struct Line: Decodable { let zoom: Double; let halves: [Half] }
            struct Along: Decodable { let u: Double; let width: Double; let light: Double; let hue: Double }
            let from: Double
            let to: Double
            let width: Double
            let steps: Int
            let glow: Spread
            let ink: Ink
            let lines: [Line]
            let along: [Along]
        }
        struct Stroke: Decodable {
            struct Glow: Decodable { let width: Double; let alpha: Double }
            struct Light: Decodable { let size: Double; let light: Double }
            let least: Double
            let more: Double
            let glow: Glow
            let ink: Double
            let inkLeast: Double
            let light: Double
            let full: Double
            let lights: [Light]
        }
        struct Motion: Decodable { let turn: Double; let glow: Double; let breath: FieldOrb.Motion.Breath?; let embers: Bool; let rim: Double }
        struct Embers: Decodable { let count: Int; let life: [Double]; let from: [Double]; let drift: [Double]; let rise: Double; let spread: Double; let size: [Double]; let fadeIn: Double; let rimAngle: Double }
        struct Frame: Decodable { let turn: Double; let glow: Double; let rim: Double; let embers: [FieldOrb.Ember] }
        struct ClockCase: Decodable { let mood: String; let clock: FieldOrb.Clock; let still: Frame }
        struct Step: Decodable { let agent: Bool; let mood: String; let dt: Double; let clock: FieldOrb.Clock; let fps: Double }
        struct FrameCase: Decodable { let clock: FieldOrb.Clock; let t: Double; let seed: UInt32; let embers: Bool; let frame: Frame }
        struct Tints: Decodable {
            struct Rim: Decodable { let rim: Double; let aurum: FieldColours; let coder: FieldColours }
            let dim: String
            let rims: [Rim]
        }
        struct Tone: Decodable { let rgb: [Double]; let exposure: Double; let shown: [Double] }
        struct InkCase: Decodable {
            struct Inks: Decodable { let key: [Double]; let rim: [Double]; let sheen: [Double] }
            struct Shown: Decodable { struct Ink: Decodable { let rgb: [Double]; let alpha: Double }; let lit: Double; let rim: Double; let ink: Ink }
            let colours: FieldColours
            let inks: Inks
            let keyRgb: [Double]
            let shown: [Shown]
        }
        /// The light page's ink (lib/field-orb.ts' FIELD_INK), and colours as inks at contrasts.
        struct InkModel: Decodable {
            struct Sheen: Decodable { let contrast: Double; let from: Double; let most: Double }
            struct Of: Decodable { let hex: String; let contrast: Double; let rgb: [Double] }
            let key: Double
            let rim: Double
            let sheen: Sheen
            let chroma: Double
            let floor: Double
            let curve: Double
            let of: [Of]
        }
        let lights: Lights
        let primary: FieldIdentity
        let agents: [Agent]
        let linear: [Linear]
        let shades: [Shade]
        let models: [Model]
        let points: [Points]
        let projections: [Projection]
        let looks: [LookCase]
        let beam: Beam
        let stroke: Stroke
        let motion: [String: Motion]
        let agentMotion: [String: Motion]
        let ease: Double
        let embers: Embers
        let clocks: [ClockCase]
        let steps: [Step]
        let frames: [FrameCase]
        let tints: Tints
        let tones: [Tone]
        let inks: [InkCase]
        let ink: InkModel
    }
}

/// Every orb as the primary's field, as the PWA draws it (lib/field.ts, lib/field-orb.ts; 26 November 2026): its lights,
/// whose field each is, its points at given turns, its looks, its beam, how it moves in each mood, its embers, tints,
/// light and ink, checked against the PWA's own output to within a billionth.
struct FieldTests {
    let field = Vectors.shared.field
    static let within = 1e-9

    private func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= Self.within * max(1, abs(a), abs(b)) }
    private func near(_ a: [Double], _ b: [Double]) -> Bool { a.count == b.count && zip(a, b).allSatisfy { near($0, $1) } }

    @Test func itsLightsAreThePWAs() {
        #expect(near(Field.key, field.lights.key))
        #expect(near(Field.rimLight, field.lights.rim))
        #expect(FieldOrb.exposure == field.lights.exposure)
        #expect(FieldOrb.primary == field.primary)
    }

    @Test func eachAgentsFieldIsThePWAs() {
        #expect(field.agents.count >= 5)
        for agent in field.agents {
            let mine = FieldOrb.agent(agent.handle, profile: agent.profile)
            #expect(mine.seed == agent.field.seed, "\(agent.handle)")
            #expect(mine.lines == agent.field.lines, "\(agent.handle)")
            #expect(near(mine.tilt, agent.field.tilt), "\(agent.handle)")
            #expect(mine.colours == agent.field.colours, "\(agent.handle)")
            // Seen from the side, never end on or flat; 12 to 20 lines.
            #expect((12...20).contains(mine.lines))
        }
    }

    @Test func coloursAreReadInLinearLightAsThePWAReadsThem() {
        for item in field.linear {
            let rgb = Field.linear(item.hex)
            #expect(near([rgb.r, rgb.g, rgb.b], item.rgb), "\(item.hex)")
        }
    }

    @Test func aPointIsShadedAsThePWAShadesIt() {
        for item in field.shades {
            let s = Field.shadeLit(item.n[0], item.n[1], item.n[2], Field.light(item.colours))
            #expect(near([s.rgb.r, s.rgb.g, s.rgb.b], item.shade.rgb), "\(item.n)")
            #expect(near(s.k, item.shade.k) && near(s.lit, item.shade.lit) && near(s.rim, item.shade.rim), "\(item.n)")
        }
    }

    @Test func aFieldsLinesAreItsSeeds() {
        for item in field.models {
            let model = Field.model(lines: item.lines, steps: 4, seed: item.seed)
            #expect(near(model.phi, item.phi), "\(item.seed)")
            #expect(near(model.width, item.width), "\(item.seed)")
        }
    }

    @Test func aFieldsPointsAreThePWAsAtEveryTurn() {
        #expect(field.points.count == 5)
        for item in field.points {
            let o = item.options
            let model = Field.model(lines: o.lines, steps: o.steps, tilt: o.tilt, weight: o.weight, colours: o.colours, seed: o.seed)
            #expect(FieldOrb.colours(o.colours, rim: item.rim) == item.colours, "\(item.who)")
            var buffer = Field.Buffer(model)
            let count = Field.at(model, turn: o.turn, into: &buffer, light: Field.light(item.colours))
            #expect(count == item.points.count, "\(item.who)")
            for (i, p) in item.points.prefix(count).enumerated() {
                #expect(buffer.at[i] == p.at, "\(item.who) \(i)")
                #expect(near([buffer.x[i], buffer.y[i], buffer.z[i]], [p.x, p.y, p.z]), "\(item.who) \(i)")
                #expect(near([buffer.r[i], buffer.g[i], buffer.b[i]], p.rgb), "\(item.who) \(i)")
                #expect(near(buffer.size[i], p.size) && near(buffer.lit[i], p.lit) && near(buffer.rim[i], p.rim), "\(item.who) \(i)")
            }
            // Its look at that size gives the same lines and weight as the vectors were made with.
            let identity = item.who.hasPrefix("primary") ? FieldOrb.primary : FieldOrb.agent(item.who.hasPrefix("ada") ? "ada" : item.who, profile: item.who == "ada, chosen" ? .object(["v": .number(2), "color": .string("#3ABEFF")]) : nil)
            let look = FieldOrb.look(identity, size: item.size, primary: item.primary)
            #expect(look.lines == o.lines && look.weight == o.weight, "\(item.who)")
        }
    }

    @Test func noPointIsInsideTheCoreAndNoneIsDark() {
        // The core stays dark: no line inside it, and nothing the lights leave dark is drawn (the "nipple" is gone).
        for identity in [FieldOrb.primary, FieldOrb.agent("ada"), FieldOrb.agent("coder")] {
            let model = Field.model(lines: identity.lines, steps: 60, tilt: identity.tilt, colours: identity.colours, seed: identity.seed)
            var buffer = Field.Buffer(model)
            let count = Field.at(model, turn: 0.7, into: &buffer)
            #expect(count > 0)
            for i in 0..<count {
                #expect(Field.hypot3(buffer.x[i], buffer.y[i], buffer.z[i]) >= 0.32 * 1.05 - 1e-12)
            }
        }
    }

    @Test func aPointFallsOnAPictureAsThePWAPlacesIt() {
        // (Three sizes for each of the first three sets of points, in order: two of those sets are the primary's.)
        #expect(field.projections.count == 9)
        for (i, item) in field.projections.enumerated() {
            let set = field.points[i / 3]
            #expect(set.who == item.who)
            for (p, shown) in zip(set.points.prefix(item.shown.count), item.shown) {
                let placed = Field.project(x: p.x, y: p.y, z: p.z, size: p.size, picture: item.size, zoom: item.zoom)
                #expect(near([placed.x, placed.y, placed.d], [shown.x, shown.y, shown.d]), "\(item.who) \(item.size)")
                #expect(placed.visible == shown.visible)
            }
        }
    }

    @Test func eachSizeLooksAsThePWAsDoes() {
        for item in field.looks {
            let identity = item.who == "primary" ? FieldOrb.primary : FieldOrb.agent(item.who)
            #expect(FieldOrb.look(identity, size: item.size, primary: item.primary) == item.look, "\(item.who) \(item.size)")
        }
    }

    @Test func hisBeamIsThePWAs() {
        let beam = field.beam
        #expect(FieldOrb.Beam.from == beam.from && FieldOrb.Beam.to == beam.to && FieldOrb.Beam.width == beam.width && FieldOrb.Beam.steps == beam.steps)
        #expect(FieldOrb.Beam.glowWidth == beam.glow.width && FieldOrb.Beam.glowAlpha == beam.glow.alpha)
        #expect(FieldOrb.Beam.inkWidth == beam.ink.width && FieldOrb.Beam.inkAlpha == beam.ink.alpha)
        #expect(FieldOrb.Beam.inkLeast == beam.ink.least && FieldOrb.Beam.inkFade == beam.ink.fade)
        #expect(FieldOrb.Beam.inkGlowWidth == beam.ink.glow.width && FieldOrb.Beam.inkGlowAlpha == beam.ink.glow.alpha)
        #expect(beam.lines.count == 3)
        for line in beam.lines {
            let mine = FieldOrb.beamLine(FieldOrb.primary, zoom: line.zoom)
            #expect(mine.count == 2 && line.halves.count == 2, "\(line.zoom)")
            for (blade, half) in zip(mine, line.halves) {
                #expect(near(blade.root, half.root) && near(blade.tip, half.tip), "\(line.zoom)")
            }
        }
        #expect(beam.along.count >= 5)
        for item in beam.along {
            let at = FieldOrb.beamAt(item.u)
            #expect(near([at.width, at.light, at.hue], [item.width, item.light, item.hue]), "\(item.u)")
        }
    }

    @Test func hisBeamIsDrawnAlongHisAxisAndNowhereElse() {
        // Its orb 100 points wide, still, drawn with and without its beam, on a dark page and on a light one: along each
        // half (a tenth to two thirds of the way out) the beam adds light, or ink; where neither half goes, it adds none.
        let size = 100, scale = 2
        func picture(beam: Bool, paper: Bool) -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: size * scale * size * scale * 4)
            bytes.withUnsafeMutableBytes { raw in
                let g = CGContext(data: raw.baseAddress, width: size * scale, height: size * scale, bitsPerComponent: 8, bytesPerRow: size * scale * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                // As FieldStills draws: points, from the top left, y down.
                g.translateBy(x: 0, y: CGFloat(size * scale))
                g.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
                FieldPainter.paint(g, size: CGFloat(size), identity: FieldOrb.primary, primary: true, beam: beam, frame: FieldOrb.still(FieldOrb.motion(.idle, agent: false)), paper: paper)
            }
            return bytes
        }
        // Its alpha at a point of the square (its middle 0, its edge 1; x right, y down), in the picture's rows from the top.
        func alpha(_ bytes: [UInt8], _ x: Double, _ y: Double) -> Int {
            let px = min(size * scale - 1, max(0, Int(((1 + x) / 2) * Double(size * scale))))
            let py = min(size * scale - 1, max(0, Int(((1 + y) / 2) * Double(size * scale))))
            return Int(bytes[(py * size * scale + px) * 4 + 3])
        }
        let blades = FieldOrb.beamLine(FieldOrb.primary, zoom: FieldOrb.look(FieldOrb.primary, size: Double(size), primary: true).zoom)
        for paper in [false, true] {
            let (with, without) = (picture(beam: true, paper: paper), picture(beam: false, paper: paper))
            for blade in blades {
                var added = 0
                for step in 1...12 {
                    let u = 0.1 + Double(step - 1) * 0.05
                    let x = blade.root[0] + (blade.tip[0] - blade.root[0]) * u, y = blade.root[1] + (blade.tip[1] - blade.root[1]) * u
                    #expect(alpha(with, x, y) >= alpha(without, x, y), "paper \(paper) at \(u)")
                    added += alpha(with, x, y) - alpha(without, x, y)
                }
                #expect(added > 12 * 40, "paper \(paper): the beam added \(added)")
            }
            // Square across its axis, near the edge (the beam runs top to bottom, leaning a little): nothing added.
            for (x, y) in [(-0.92, 0.0), (0.92, 0.0), (-0.9, -0.9), (0.9, 0.9)] {
                #expect(alpha(with, x, y) == alpha(without, x, y), "paper \(paper) at \(x), \(y)")
            }
        }
    }

    @Test func itsStrokesAreThePWAs() {
        let stroke = field.stroke
        #expect(FieldOrb.Stroke.least == stroke.least && FieldOrb.Stroke.more == stroke.more)
        #expect(FieldOrb.Stroke.glowWidth == stroke.glow.width && FieldOrb.Stroke.glowAlpha == stroke.glow.alpha)
        #expect(FieldOrb.Stroke.ink == stroke.ink && FieldOrb.Stroke.inkLeast == stroke.inkLeast)
        #expect(FieldOrb.Stroke.light == stroke.light && FieldOrb.Stroke.full == stroke.full)
        for item in stroke.lights { #expect(near(FieldOrb.strokeLight(item.size), item.light), "\(item.size)") }
    }

    @Test func eachMoodMovesAsThePWAsAndAnAgentOnlyAtWork() {
        #expect(Set(Orb.Mood.allCases.map(\.rawValue)) == Set(field.motion.keys))
        for mood in Orb.Mood.allCases {
            for (agent, theirs) in [(false, field.motion[mood.rawValue]!), (true, field.agentMotion[mood.rawValue]!)] {
                let mine = FieldOrb.motion(mood, agent: agent)
                #expect(mine.turn == theirs.turn && mine.glow == theirs.glow && mine.embers == theirs.embers && mine.rim == theirs.rim, "\(mood) \(agent)")
                #expect(mine.breath == theirs.breath, "\(mood) \(agent)")
            }
            // An agent is still in every mood but work; slow and calm in all of them.
            #expect((FieldOrb.motion(mood, agent: true).turn > 0) == (mood == .working))
            #expect(FieldOrb.motion(mood, agent: false).turn <= 0.2)
        }
        #expect(FieldOrb.ease == field.ease)
    }

    @Test func hisEmbersAreThePWAs() {
        let embers = field.embers
        #expect(FieldOrb.Embers.count == embers.count)
        #expect([FieldOrb.Embers.life.0, FieldOrb.Embers.life.1] == embers.life)
        #expect([FieldOrb.Embers.from.0, FieldOrb.Embers.from.1] == embers.from)
        #expect([FieldOrb.Embers.drift.0, FieldOrb.Embers.drift.1] == embers.drift)
        #expect([FieldOrb.Embers.size.0, FieldOrb.Embers.size.1] == embers.size)
        #expect(FieldOrb.Embers.rise == embers.rise && FieldOrb.Embers.spread == embers.spread && FieldOrb.Embers.fadeIn == embers.fadeIn)
        #expect(near(FieldOrb.rimAngle, embers.rimAngle))
    }

    @Test func aFieldIsFirstSeenAtRestAndStillAsThePWAs() {
        for item in field.clocks {
            let motion = FieldOrb.motions[Orb.Mood(rawValue: item.mood)!]!
            #expect(FieldOrb.clock(motion) == item.clock, "\(item.mood)")
            let still = FieldOrb.still(motion)
            #expect(still.turn == item.still.turn && still.glow == item.still.glow && still.rim == item.still.rim && still.embers.isEmpty && item.still.embers.isEmpty, "\(item.mood)")
        }
    }

    @Test func itsClockStepsAsThePWAsThroughEveryMood() {
        #expect(field.steps.count == 24)
        var clocks: [Bool: FieldOrb.Clock] = [false: FieldOrb.clock(FieldOrb.motion(.idle, agent: false)), true: FieldOrb.clock(FieldOrb.motion(.idle, agent: true))]
        for item in field.steps {
            let motion = FieldOrb.motion(Orb.Mood(rawValue: item.mood)!, agent: item.agent)
            let clock = FieldOrb.step(clocks[item.agent]!, motion, item.dt)
            let c = item.clock
            #expect(near([clock.turn, clock.speed, clock.glow, clock.rim, clock.depth, clock.breath, clock.period, clock.embers], [c.turn, c.speed, c.glow, c.rim, c.depth, c.breath, c.period, c.embers]), "\(item.mood) \(item.dt) \(item.agent)")
            #expect(FieldOrb.fps(clock, motion) == item.fps, "\(item.mood) \(item.dt) \(item.agent)")
            // Carried on from the PWA's own clock, so a last digit never builds up.
            clocks[item.agent] = c
        }
    }

    @Test func aFieldComesToRestAndThenDrawsNothing() {
        // Nothing redraws at rest: an agent not at work settles to no frames at all, and the primary too (your word, 26 November
        // 2026: "nothing animating at rest"; until then it settled to a slow turn, 15 frames a second).
        var clock = FieldOrb.clock(FieldOrb.motion(.working, agent: true))
        let resting = FieldOrb.motion(.idle, agent: true)
        for _ in 0..<600 { clock = FieldOrb.step(clock, resting, 1.0 / 30) }
        #expect(FieldOrb.fps(clock, resting) == 0)
        var its = FieldOrb.clock(FieldOrb.motion(.working, agent: false))
        let idle = FieldOrb.motion(.idle, agent: false)
        for _ in 0..<600 { its = FieldOrb.step(its, idle, 1.0 / 30) }
        #expect(FieldOrb.fps(its, idle) == 0)
    }

    @Test func nothingMovesAtRestAndWorkIsDrawnTwentyTimesASecond() {
        // Idle, done, queued, paused or failed: still, in its mood's light, asking for no frame.
        for mood in [Orb.Mood.idle, .done, .queued, .paused, .failed] {
            let motion = FieldOrb.motion(mood, agent: false)
            #expect(motion.turn == 0 && motion.breath == nil && !motion.moves, "\(mood)")
            #expect(FieldOrb.fps(FieldOrb.clock(motion), motion) == 0, "\(mood)")
        }
        #expect(FieldOrb.motion(.paused, agent: false).glow < FieldOrb.motion(.queued, agent: false).glow)
        // At work, its embers drifting, 20 a second; breathing, 20; only while a mood arrives, 30.
        let working = FieldOrb.motion(.working, agent: false), waiting = FieldOrb.motion(.waiting, agent: false), done = FieldOrb.motion(.done, agent: false)
        #expect(FieldOrb.fps(FieldOrb.clock(working), working) == 20)
        #expect(FieldOrb.fps(FieldOrb.clock(waiting), waiting) == 20)
        var settling = FieldOrb.clock(working)
        for _ in 0..<6 { settling = FieldOrb.step(settling, done, 1.0 / 30) }
        #expect(FieldOrb.fps(settling, done) == 30)
        for _ in 0..<600 { settling = FieldOrb.step(settling, done, 1.0 / 30) }
        #expect(FieldOrb.fps(settling, done) == 0)
    }

    @Test func hisEmbersAreFewSmallAndSlowAndNonePopsIntoSight() {
        #expect(FieldOrb.Embers.count <= 5 && FieldOrb.Embers.life.0 >= 3.5 && FieldOrb.Embers.size.1 <= 0.022)
        // Slow: at most a fifth of the orb's half-width a life, so at 168 points under 5 points a second.
        #expect(FieldOrb.Embers.drift.1 + FieldOrb.Embers.rise <= 0.2)
        #expect((FieldOrb.Embers.drift.1 + FieldOrb.Embers.rise) * 84 / FieldOrb.Embers.life.0 < 5)
        // Each comes into sight over a quarter of its life, and is never brighter than three fifths of its light.
        let working = FieldOrb.clock(FieldOrb.motion(.working, agent: false))
        var brightest = 0.0
        for step in 0..<1200 {
            for e in FieldOrb.frame(working, at: Double(step) * 0.05, seed: 3, embers: true).embers { brightest = max(brightest, e.alpha) }
        }
        #expect(brightest > 0.4 && brightest < 0.6)
    }

    @Test func aFramesEmbersAreThePWAs() {
        for item in field.frames {
            let frame = FieldOrb.frame(item.clock, at: item.t, seed: item.seed, embers: item.embers)
            #expect(near([frame.turn, frame.glow, frame.rim], [item.frame.turn, item.frame.glow, item.frame.rim]), "\(item.t)")
            #expect(frame.embers.count == item.frame.embers.count, "\(item.t)")
            for (mine, theirs) in zip(frame.embers, item.frame.embers) {
                #expect(near([mine.x, mine.y, mine.r, mine.alpha], [theirs.x, theirs.y, theirs.r, theirs.alpha]), "\(item.t)")
                // Always well inside its square.
                #expect((mine.x * mine.x + mine.y * mine.y).squareRoot() < 0.93)
            }
        }
    }

    @Test func aFailedRimDimsAsThePWAs() {
        #expect(FieldOrb.rimDim == field.tints.dim)
        for item in field.tints.rims {
            #expect(FieldOrb.colours(Field.aurum, rim: item.rim) == item.aurum, "\(item.rim)")
            #expect(FieldOrb.colours(FieldOrb.agent("coder").colours, rim: item.rim) == item.coder, "\(item.rim)")
        }
    }

    @Test func lightIsShownOnADarkPageAsTheIconShowsIt() {
        for item in field.tones {
            let shown = FieldOrb.tone(item.rgb[0], item.rgb[1], item.rgb[2], exposure: item.exposure)
            #expect(near([shown.0, shown.1, shown.2], item.shown), "\(item.rgb) \(item.exposure)")
        }
    }

    @Test func onALightPageItIsInkAsThePWAs() {
        for item in field.inks {
            let inks = FieldOrb.inks(item.colours)
            #expect(inks.key == item.inks.key && inks.rim == item.inks.rim && inks.sheen == item.inks.sheen, "\(item.colours)")
            for shown in item.shown {
                let ink = FieldOrb.ink(inks, lit: shown.lit, rim: shown.rim)
                #expect(near(ink.rgb, shown.ink.rgb) && near(ink.alpha, shown.ink.alpha), "\(shown.lit) \(shown.rim)")
            }
        }
        // A colour as an ink on the light page (26 November 2026): its hue kept, more saturated, as light as its contrast
        // allows; and the model's own numbers.
        let model = field.ink
        #expect(FieldOrb.Ink.key == model.key && FieldOrb.Ink.rim == model.rim && FieldOrb.Ink.chroma == model.chroma)
        #expect(FieldOrb.Ink.sheenContrast == model.sheen.contrast && FieldOrb.Ink.sheenFrom == model.sheen.from && FieldOrb.Ink.sheenMost == model.sheen.most)
        #expect(FieldOrb.Ink.floor == model.floor && FieldOrb.Ink.curve == model.curve)
        #expect(model.of.count >= 24)
        for item in model.of { #expect(FieldOrb.inkOf(item.hex, item.contrast) == item.rgb, "\(item.hex) at \(item.contrast)") }
    }

    @Test func aFramesInkIsTheInksWithinAThousandth() {
        // As a frame draws a point's ink on a light page (making nothing): the same colour, its opacity within a thousandth.
        for colours in [Field.aurum, FieldOrb.agent("ada").colours, FieldOrb.agent("coder").colours] {
            let inks = FieldOrb.inks(colours)
            for (lit, rim) in [(0.0, 0.0), (0.2, 0.05), (0.5, 0.5), (0.8, 0), (1, 0), (0, 1), (0.37, 0.61)] {
                let fast = FieldOrb.inkInto(inks, lit: lit, rim: rim), exact = FieldOrb.ink(inks, lit: lit, rim: rim)
                #expect(near([fast.r, fast.g, fast.b], exact.rgb), "\(lit) \(rim)")
                #expect(abs(fast.alpha - exact.alpha) < 0.001, "\(lit) \(rim)")
            }
            // The far lines faint but there, and whole where fully lit.
            #expect(FieldOrb.ink(inks, lit: 0, rim: 0).alpha == FieldOrb.Ink.floor && FieldOrb.ink(inks, lit: 1, rim: 0).alpha == 1)
        }
    }

    @Test func onALightPageItsLinesHoldAndHisBeamIsABlade() {
        // No line narrower than its least, and wider than on a dark page (ink has no glow to carry it).
        #expect(FieldOrb.Stroke.inkLeast >= 0.5 && FieldOrb.Stroke.ink >= 1)
        // At 34 points its beam's root is at least 2.5 points across on paper; its tint as close as the dark page's glow.
        #expect(2 * max(FieldOrb.Beam.inkLeast, (34 * FieldOrb.Beam.width) / 2) * FieldOrb.Beam.inkWidth > 2.5)
        #expect(FieldOrb.Beam.inkGlowWidth <= FieldOrb.Beam.glowWidth)
    }
}
