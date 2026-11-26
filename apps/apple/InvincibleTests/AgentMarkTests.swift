import CoreGraphics
import Foundation
import SwiftUI
import Testing
@testable import Invincible

/// An agent's mark, the Grille (O2, 26 November 2026), as core makes it (`agent-mark.ts`, through the vectors' `marks`):
/// its palette and its pale and grey forms, its forms and times, each expression's state, the marks a node gives, the snap
/// of a colour you pick, a saved mark read strictly, its sines and cosines and its slats at given moments to the last bit;
/// and the mark as it is drawn, its state in its shape.
struct AgentMarkTests {
    let marks = Vectors.shared.marks

    @Test func itsPaletteAndItsPaleAndGreyFormsAreCores() {
        #expect(AgentMark.palette.map(\.name) == marks.palette.map(\.name))
        #expect(AgentMark.palette.map(\.forms.light) == marks.palette.map(\.light))
        #expect(AgentMark.palette.map(\.forms.dark) == marks.palette.map(\.dark))
        #expect(AgentMark.queued.map(\.light) == marks.queued.map(\.light))
        #expect(AgentMark.queued.map(\.dark) == marks.queued.map(\.dark))
        for (mine, theirs) in [(AgentMark.paused, marks.paused), (AgentMark.page, marks.page), (AgentMark.ink, marks.ink), (AgentMark.red, marks.red)] {
            #expect(mine.light == theirs.light && mine.dark == theirs.dark, "\(theirs.light)")
        }
        #expect(AgentMark.grey == marks.grey)
    }

    @Test func itsFormsTimesAndStatesAreCores() {
        #expect(AgentMark.forms == marks.forms.count)
        for (n, form) in marks.forms.enumerated() {
            let mine = AgentMark.shape(n)
            #expect(mine.slots == form.slots && mine.angle == form.angle, "\(n)")
        }
        #expect(AgentMark.Timing.workCycle == marks.timing.workCycle && AgentMark.Timing.needsBeat == marks.timing.needsBeat)
        #expect(AgentMark.Timing.doneSettle == marks.timing.doneSettle && AgentMark.Timing.failDrop == marks.timing.failDrop)
        #expect(MarkState.allCases.map(\.rawValue) == marks.states)
    }

    @Test func whatAnAgentIsDoingIsItsMarksStateAsCores() {
        #expect(marks.stateOf.count == 11)
        for item in marks.stateOf {
            #expect(MarkState(expression: item.expression).rawValue == item.state, "\(item.expression)")
            // A face given its mood shows the same: waiting on you is its `needs`.
            #expect(MarkState(Orb.Mood(expression: item.expression)).rawValue == item.state, "\(item.expression)")
        }
        #expect(MarkState(expression: "dancing") == .idle && MarkState(expression: nil) == .idle)
    }

    @Test func aHandlesSeedIsFNV1aOverItsUTF16AsCoresIs() {
        // (core's handleSeed of each, as the vectors' agentOrbs.seeds have them: two quotes, a backslash and an emoji with
        // its variation selector among them, each counted in UTF-16 code units.)
        let seeds: [(String, UInt32)] = [("", 2_166_136_261), ("a", 3_826_002_220), ("foobar", 3_214_735_720), ("coder", 3_469_596_402), ("Will\u{2019}s \u{201C}iPad\u{201D} \\ \u{1F6E1}\u{FE0F}", 3_419_317_483)]
        for (id, seed) in seeds { #expect(AgentMark.seed(id) == seed, "\(id)") }
    }

    @Test func aNodeGivesMarksAsCoreDoes() {
        var given = [AgentMark]()
        for item in marks.given {
            #expect(AgentMark.seed(item.id) == item.seed, "\(item.id)")
            let mark = AgentMark.assign(item.id, after: given)
            #expect(mark == AgentMark(color: item.color, form: item.form), "\(item.id)")
            given.append(mark)
        }
        for item in marks.chosen {
            let others = item.others.map { AgentMark(color: $0.color, form: $0.form) }
            #expect(AgentMark.assign(item.id, after: others, chosen: item.chosen) == AgentMark(color: item.mark.color, form: item.mark.form), "\(item.id)")
        }
        // Only which marks are worn counts, never their order: what the app tells you a node will give is what it gives.
        for id in ["ada", "lin", "agent"] {
            #expect(AgentMark.assign(id, after: given.reversed()) == AgentMark.assign(id, after: given), "\(id)")
        }
    }

    @Test func aColourYouPickSnapsAsCoresToTheLastBit() {
        // sRGB's levels in linear light, to the last bit: the snap raises nothing to a power.
        #expect(AgentMark.linear.count == 256)
        #expect(AgentMark.linear == marks.linear)
        for item in marks.snaps { #expect(AgentMark.snap(item.hex) == item.color, "\(item.hex)") }
        // Every colour of the grid core snapped: 18 levels a channel, red slowest.
        var grid = ""
        for r in stride(from: 0, to: 256, by: 15) {
            for g in stride(from: 0, to: 256, by: 15) {
                for b in stride(from: 0, to: 256, by: 15) { grid += String(AgentMark.snap("#" + [r, g, b].map { $0 < 16 ? "0" + String($0, radix: 16) : String($0, radix: 16) }.joined())) }
            }
        }
        #expect(grid == marks.snapGrid)
        // A pale mint is Teal's, never Violet's; red, which isn't among the eight, is Amber's; each of the eight is its own.
        #expect(AgentMark.palette[AgentMark.snap("#b9dfd4")].name == "Teal")
        #expect(AgentMark.palette[AgentMark.snap("#ff0000")].name == "Amber")
        for (n, hue) in AgentMark.palette.enumerated() {
            #expect(AgentMark.snap(hue.forms.light) == n && AgentMark.snap(hue.forms.dark) == n, "\(hue.name)")
        }
        // What isn't six hex digits is the first, as core's arithmetic comes to.
        #expect(AgentMark.snap("blue") == 0 && AgentMark.snap("#12345g") == 0)
    }

    @Test func aSavedMarkIsReadStrictlyAsCoresIs() throws {
        #expect(marks.profiles.count == 6)
        for item in marks.profiles {
            #expect((AgentMark.read(item.profile) != nil) == item.saved, "\(item.id) \(String(describing: item.profile))")
            #expect(AgentMark.of(id: item.id, profile: item.profile) == AgentMark(color: item.mark.color, form: item.mark.form), "\(item.id) \(String(describing: item.profile))")
        }
        // As the node sends it, read by the app's own decoding: every form, 0 and 1 among them, is a number, never a yes or no.
        for form in 0..<AgentMark.forms {
            let sent = try JSONDecoder().decode(JSONValue.self, from: Data(##"{"v":3,"color":"#0084ba","form":\##(form)}"##.utf8))
            #expect(AgentMark.read(sent) == AgentMark(color: 4, form: form), "\(form)")
        }
        // Not a mark: half a form, a form in words, a colour not among the eight's light forms.
        for text in [##"{"v":3,"color":"#0084ba","form":1.5}"##, ##"{"v":3,"color":"#0084ba","form":"1"}"##, ##"{"v":3,"color":"#0084BA","form":1}"##, ##"{"v":"3","color":"#0084ba","form":1}"##] {
            #expect(AgentMark.read(try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) == nil, "\(text)")
        }
        // From a node before the marks: the colour chosen for its orb, snapped, in its handle's form; nothing: its handle's.
        let chosen = try JSONDecoder().decode(JSONValue.self, from: Data(##"{"v":2,"color":"#3ABEFF"}"##.utf8))
        #expect(AgentMark.of(id: "coder", profile: chosen) == AgentMark(color: AgentMark.snap("#3abeff"), form: AgentMark.seeded("coder").form))
        #expect(AgentMark.of(id: "coder", profile: nil) == AgentMark.seeded("coder"))
    }

    @Test func itsSinesAndCosinesAreCoresToTheLastBit() {
        #expect(marks.trig.count == 21)
        for item in marks.trig {
            // (Exactly equal: JSON can't say a negative zero, and no other two doubles are equal but for their bits.)
            #expect(AgentMark.markSin(item.x) == item.sin, "sin \(item.x)")
            #expect(AgentMark.markCos(item.x) == item.cos, "cos \(item.x)")
        }
    }

    @Test func itsSlatsStandAsCoresToTheLastBit() throws {
        #expect(marks.geometry.count == 108)
        for item in marks.geometry {
            let state = try #require(MarkState(rawValue: item.state))
            let mark = AgentMark(color: item.mark.color, form: item.mark.form)
            let mine = AgentMark.geometry(mark, seed: item.seed, state: state, size: item.size, t: item.t, since: item.since)
            let at = "\(item.id) \(item.state) \(item.size) t \(String(describing: item.t)) since \(String(describing: item.since))"
            #expect(mine.angle == item.geometry.angle && mine.radius == item.geometry.radius, "\(at)")
            #expect(mine.slats.count == item.geometry.slats.count, "\(at)")
            for (n, (a, b)) in zip(mine.slats, item.geometry.slats).enumerated() {
                #expect(a.from == b.from && a.to == b.to && a.slide == b.slide, "\(at) slat \(n)")
                #expect(a.key == (b.fill == "key") && a.drop == b.drop && a.turn == b.turn, "\(at) slat \(n)")
                #expect(Double(a.pivot.x) == b.pivot[0] && Double(a.pivot.y) == b.pivot[1], "\(at) slat \(n)")
            }
            let colors = AgentMark.colors(mark.color, state: state, theme: try #require(AgentMark.Theme(rawValue: item.theme)))
            #expect(colors.body == item.colors.body && colors.key == item.colors.key, "\(at)")
        }
    }

    @Test func aMarkComesToRestWhereItsStillFormIs() {
        // So a mark that stops moving (it settled, it left the screen's front, motion was reduced) draws nothing new.
        let mark = AgentMark(color: 2, form: 7)
        let still = { (state: MarkState) in AgentMark.geometry(mark, seed: 7, state: state, size: 44, t: nil, since: nil) }
        #expect(AgentMark.geometry(mark, seed: 7, state: .done, size: 44, t: 9, since: AgentMark.Timing.doneSettle) == still(.done))
        #expect(AgentMark.geometry(mark, seed: 7, state: .failed, size: 44, t: 9, since: AgentMark.Timing.failDrop) == still(.failed))
        #expect(still(.done) == still(.idle) && still(.working) == still(.idle))
        // Still, what asks you holds its top slat out, and what failed its bottom one loose.
        #expect(still(.needs).slats.first?.slide == 5 && still(.needs).slats.first?.key == true)
        #expect(still(.failed).slats.last?.drop == 8 && still(.failed).slats.last?.turn == 10)
    }

    @Test func aTasksLiveActivityShowsHowItStandsInItsAgentsMark() {
        let at = 1_764_000_000_000.0
        let of = { (phase: String, verdict: String?) in TaskActivityState(phase: phase, gates: [], review: nil, verdict: verdict, gate: nil, at: at).markState }
        #expect(of("queued", nil) == .queued)
        #expect(of("running", nil) == .working && of("review", nil) == .working)
        #expect(of("interrupted", nil) == .needs)
        for verdict in ["failed", "rejected", "gave-up"] { #expect(of("ended", verdict) == .failed, "\(verdict)") }
        for verdict in ["proven", "reviewed", "stopped", "unverified"] { #expect(of("ended", verdict) == .done, "\(verdict)") }
    }

    #if os(iOS)
    @Test func aLiveActivityAnAppFromBeforeTheMarksStartedStillReads() throws {
        // Its attributes as the app before the marks wrote them: no form, its colour its orb's (drawn as a disc of it).
        let old = try JSONDecoder().decode(TaskActivityAttributes.self, from: Data(##"{"task":"task-1","title":"Ship it","agentName":"Ada","colour":"#3abeff"}"##.utf8))
        #expect(old.form == nil && old.colour == "#3abeff")
        // As this app writes them: its mark's colour (its light form) and its form, read back the same.
        let mark = AgentMark.of(id: "ada", profile: nil)
        let now = TaskActivityAttributes(task: "task-1", title: "Ship it", agentName: "Ada", colour: AgentMark.palette[mark.color].forms.light, form: mark.form)
        let again = try JSONDecoder().decode(TaskActivityAttributes.self, from: JSONEncoder().encode(now))
        #expect(again.form == mark.form && again.colour == now.colour)
    }
    #endif
}

/// The mark as it is drawn (AgentMarkView): its slats in its colour with the slots between them clear, nothing outside its
/// disc, and its state in its shape: the top slat in the ink when it asks you, the bottom one red and knocked loose below
/// the disc when it failed, pale while queued, grey while paused.
@MainActor struct AgentMarkDrawingTests {
    /// Builder's mark in the vectors: Amber, two slots at -27 degrees.
    let mark = AgentMark(color: 0, form: 1)

    @Test func itsSlatsAreItsColourAndItsSlotsAreClear() throws {
        for theme in [AgentMark.Theme.light, .dark] {
            let picture = try #require(Self.pixels(mark, .idle, theme))
            let geometry = AgentMark.geometry(mark, seed: 0, state: .idle, size: 100, t: nil, since: nil)
            // The middle of each slat is its colour; the middle of each slot is clear.
            for slat in geometry.slats {
                #expect(Self.near(Self.at(picture, Self.point(geometry, slide: slat.slide, across: (slat.from + slat.to) / 2)), AgentMark.palette[0].forms.on(theme)), "\(theme) slat \(slat.from)")
            }
            for (upper, lower) in zip(geometry.slats, geometry.slats.dropFirst()) {
                #expect(Self.at(picture, Self.point(geometry, slide: 0, across: (upper.to + lower.from) / 2)).alpha < 8, "\(theme) slot \(upper.to)")
            }
            // Nothing outside its disc (its radius 44 of the box's 100, and a pixel's softening).
            #expect(Self.outside(picture, beyond: 45.5) == 0, "\(theme)")
        }
    }

    @Test func itsStateIsInItsShape() throws {
        // Asks you: its top slat in the ink, held out along its slot.
        for theme in [AgentMark.Theme.light, .dark] {
            let picture = try #require(Self.pixels(mark, .needs, theme))
            let geometry = AgentMark.geometry(mark, seed: 0, state: .needs, size: 100, t: nil, since: nil)
            let top = try #require(geometry.slats.first)
            #expect(Self.near(Self.at(picture, Self.point(geometry, slide: top.slide, across: (top.from + top.to) / 2)), AgentMark.ink.on(theme)), "\(theme)")
        }
        // Failed: its bottom slat red, and knocked loose below the disc; nothing of it there while it is well.
        let failed = try #require(Self.pixels(mark, .failed, .light))
        let idle = try #require(Self.pixels(mark, .idle, .light))
        #expect(Self.below(failed, AgentMark.red.light) > 20)
        #expect(Self.below(idle, AgentMark.red.light) == 0)
        // Queued is pale, paused grey: the middle slat in each.
        let geometry = AgentMark.geometry(mark, seed: 0, state: .idle, size: 100, t: nil, since: nil)
        let middle = Self.point(geometry, slide: 0, across: 0)
        #expect(Self.near(Self.at(try #require(Self.pixels(mark, .queued, .light)), middle), AgentMark.queued[0].light))
        #expect(Self.near(Self.at(try #require(Self.pixels(mark, .paused, .dark)), middle), AgentMark.paused.dark))
    }

    @Test func anAgentsFaceIsItsMark() throws {
        // AgentFace draws the mark its avatar says: the same pixels as the mark itself.
        let profile = JSONValue.object(["v": .number(3), "color": .string("#c88200"), "form": .number(1)])
        let face = try #require(Self.render(AgentFace(id: "builder", profile: profile, size: 100).environment(\.colorScheme, .light)))
        let drawn = try #require(Self.pixels(mark, .idle, .light))
        #expect(face == drawn)
    }

    // MARK: Pixels

    struct Pixel { let r: Int; let g: Int; let b: Int; let alpha: Int }
    /// A picture 100 points square at twice its size, and its width in pixels.
    struct Picture: Equatable { let bytes: [UInt8]; let width: Int }

    static func pixels(_ mark: AgentMark, _ state: MarkState, _ theme: AgentMark.Theme) -> Picture? {
        render(AgentMarkView(mark: mark, seed: 0, state: state, size: 100).environment(\.colorScheme, theme == .dark ? .dark : .light))
    }

    /// A view's pixels as SwiftUI draws it alone, 100 points square at twice its size: RGBA, eight bits each.
    static func render(_ view: some View) -> Picture? {
        let renderer = ImageRenderer(content: view.frame(width: 100, height: 100))
        renderer.scale = 2
        guard let image = renderer.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let (width, height) = (image.width, image.height)
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? Picture(bytes: bytes, width: width) : nil
    }

    /// A point of the 100-unit box: `across` its slots (down, before turning) and `slide` along them, turned to its angle.
    static func point(_ geometry: AgentMark.Geometry, slide: Double, across: Double) -> CGPoint {
        let turned = geometry.angle * Double.pi / 180
        return CGPoint(x: 50 + slide * cos(turned) - across * sin(turned), y: 50 + slide * sin(turned) + across * cos(turned))
    }

    /// The pixel at a point of the box (un-premultiplied).
    static func at(_ picture: Picture, _ point: CGPoint) -> Pixel {
        let scale = Double(picture.width) / 100
        let (x, y) = (Int(point.x * scale), Int(point.y * scale))
        let i = (y * picture.width + x) * 4
        let alpha = Int(picture.bytes[i + 3])
        let plain = { (c: UInt8) in alpha == 0 ? 0 : min(255, Int(c) * 255 / alpha) }
        return Pixel(r: plain(picture.bytes[i]), g: plain(picture.bytes[i + 1]), b: plain(picture.bytes[i + 2]), alpha: alpha)
    }

    /// Whether a pixel is a colour ("#rrggbb"), solid, within a few levels.
    static func near(_ pixel: Pixel, _ hex: String) -> Bool {
        let value = Int(hex.dropFirst(), radix: 16) ?? -1
        let (r, g, b) = ((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
        return pixel.alpha > 250 && abs(pixel.r - r) <= 3 && abs(pixel.g - g) <= 3 && abs(pixel.b - b) <= 3
    }

    /// How many pixels more than faintly there lie further than `beyond` units from the box's middle.
    static func outside(_ picture: Picture, beyond: Double) -> Int {
        let scale = Double(picture.width) / 100
        var count = 0
        for y in 0..<picture.width {
            for x in 0..<picture.width where picture.bytes[(y * picture.width + x) * 4 + 3] > 16 {
                let (dx, dy) = ((Double(x) + 0.5) / scale - 50, (Double(y) + 0.5) / scale - 50)
                if (dx * dx + dy * dy).squareRoot() > beyond { count += 1 }
            }
        }
        return count
    }

    /// How many pixels of a colour lie below the disc (more than 45 units under the box's middle).
    static func below(_ picture: Picture, _ hex: String) -> Int {
        let scale = Double(picture.width) / 100
        var count = 0
        for y in Int(95 * scale)..<picture.width {
            for x in 0..<picture.width where near(at(picture, CGPoint(x: (Double(x) + 0.5) / scale, y: (Double(y) + 0.5) / scale)), hex) { count += 1 }
        }
        return count
    }
}
