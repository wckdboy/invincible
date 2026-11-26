import Foundation
import Testing
@testable import Invincible

/// An orb's sphere of glyphs round its nucleus, as the PWA works it (`lib/orb-sphere.ts`; your words, 25 November 2026:
/// "use glyph and randomness on the orbs, like Jarvis/Ultron in the movies, and my other project Phren", "slow and
/// calming movement"): each handle's sphere, its points, its glyphs, what a frame shows of them, the shades, an agent's
/// arcs and the primary's data ring, checked against the PWA's own output to within a billionth (and characters exactly).
struct OrbSphereTests {
    let spheres = Vectors.shared.orb.sphere
    static let within = 1e-9

    @Test func anAgentsSphereAtEachSizeAndTheGlyphsAreThePWAs() {
        #expect(Set(spheres.agent.keys) == ["badge", "seat", "full"])
        for (level, look) in spheres.agent {
            #expect(Orb.agentSphere[Orb.Level(rawValue: level)!] == Orb.SphereLook(count: look.count, glyph: look.glyph, r: look.r, nucleus: look.nucleus), "\(level)")
        }
        #expect(Orb.sphereTurn == spheres.turn)
        #expect(Orb.glyphLadder == spheres.ladder)
        #expect(Orb.dataGlyphs.joined() == spheres.data)
        #expect(Set(spheres.flash.keys) == Set(Orb.Mood.allCases.map(\.rawValue)))
        for mood in Orb.Mood.allCases { #expect(Orb.sphereFlash[mood] == spheres.flash[mood.rawValue], "\(mood)") }
    }

    @Test func eachHandleMakesThePWAsSphere() {
        #expect(!spheres.spheres.isEmpty)
        for item in spheres.spheres {
            let mine = Orb.sphere(item.handle), theirs = item.sphere
            #expect(mine.seed == theirs.seed && mine.spin == theirs.spin, "\(item.handle)")
            #expect(Self.close(mine.tilt, theirs.tilt) && Self.close(mine.phase, theirs.phase) && Self.close(mine.share, theirs.share), "\(item.handle): \(mine)")
        }
    }

    @Test func itsPointsAreThePWAs() {
        #expect(!spheres.points.isEmpty)
        for item in spheres.points {
            let mine = Orb.spherePoints(Orb.sphere(item.handle), item.count)
            #expect(mine.count == item.points.count, "\(item.handle)")
            for (n, (a, b)) in zip(mine, item.points).enumerated() {
                #expect(Self.close(a.x, b.x) && Self.close(a.y, b.y) && Self.close(a.z, b.z) && Self.close(a.size, b.size) && a.second == b.second, "\(item.handle) \(n): \(a)")
            }
        }
    }

    @Test func itsGlyphsChangeAsThePWAs() {
        #expect(!spheres.glyphs.isEmpty)
        for item in spheres.glyphs {
            let mine = Orb.sphereGlyph(item.seed, item.i, item.level, item.t, item.flash)
            #expect(mine.char == item.glyph.char && mine.data == item.glyph.data && Self.close(mine.fade, item.glyph.fade), "\(item.seed) \(item.i) at \(item.t): \(mine)")
        }
        // Data among them, and not.
        #expect(spheres.glyphs.contains { $0.glyph.data } && spheres.glyphs.contains { !$0.glyph.data })
    }

    @Test func whatAFrameShowsOfItIsThePWAs() {
        #expect(!spheres.frames.isEmpty)
        for item in spheres.frames {
            let sphere = Orb.sphere(item.handle)
            let mood = Orb.Mood(rawValue: item.mood)!
            let mine = Orb.sphereFrame(sphere, Orb.spherePoints(sphere, item.count), angle: item.angle, radius: item.radius, scale: item.scale, glyph: item.glyph, t: item.t, mood: mood, paper: item.paper)
            Self.expectSameFrame(mine, item.shown, "\(item.handle) \(item.mood) at \(item.angle)°\(item.paper ? " on paper" : "")")
        }
        // On paper and not, failed and not, both its and an agent's.
        #expect(spheres.frames.contains { $0.paper } && spheres.frames.contains { $0.mood == "failed" } && spheres.frames.contains { $0.handle == "primary" })
    }

    @Test func eachColoursSixShadesAreThePWAs() {
        #expect(!spheres.shades.isEmpty)
        for item in spheres.shades {
            #expect(Orb.sphereShades(ink: item.ink, light: item.light, deep: item.deep) == item.shades, "\(item.ink)")
            #expect(Orb.paperShades(ink: item.ink, deep: item.deep) == item.paper, "\(item.ink)")
        }
    }

    @Test func eachAgentsArcsAreThePWAs() {
        #expect(!spheres.arcs.isEmpty)
        for item in spheres.arcs {
            let mine = Orb.agentArcs(Orb.sphere(item.handle), Orb.Level(rawValue: item.level)!)
            #expect(mine.count == item.arcs.count, "\(item.handle) \(item.level)")
            for (a, b) in zip(mine, item.arcs) {
                #expect(Self.close(a.r, b.r) && Self.close(a.width, b.width) && Self.close(a.from, b.from) && Self.close(a.length, b.length) && Self.close(a.speed, b.speed), "\(item.handle) \(item.level): \(a)")
            }
        }
    }

    @Test func hisDataRingIsThePWAs() {
        #expect(!spheres.ring.isEmpty)
        for item in spheres.ring {
            for (k, place) in item.places.enumerated() {
                let mine = Orb.dataGlyph(item.seed, k, item.t, item.share)
                #expect((mine == nil) == (place == nil), "\(item.seed) at \(item.t), place \(k)")
                if let mine, let place { #expect(mine.char == place.char && Self.close(mine.alpha, place.alpha), "\(item.seed) at \(item.t), place \(k): \(mine)") }
            }
        }
        // Its orb's ring is that one: 48 places round 80.5, about 62 % of them lit, in its lit tint.
        let data = Orb.parts(168).first { $0.name == "data" }
        #expect(data?.kind == Orb.Kind.glyphs(r: 80.5, count: 48, size: 7, share: 0.62, ink: .light))
    }

    // ---- what it is, whoever's it is (as the PWA's own tests have it) ----

    @Test func eachSphereIsWithinItsBoundsAndTurnsBothWays() {
        let many = (0..<300).map { Orb.sphere("agent-\($0)") }
        for sphere in many {
            #expect(sphere.tilt >= 12 && sphere.tilt < 32)
            #expect(sphere.spin == 1 || sphere.spin == -1)
            #expect(sphere.phase >= 0 && sphere.phase < 360)
            #expect(sphere.share >= 0.18 && sphere.share < 0.34)
        }
        #expect(Set(many.map(\.spin)).count == 2)
        // Its points cover the whole sphere, top to bottom, and a face's sphere stays inside its arcs.
        for level in [Orb.Level.badge, .seat, .full] {
            let look = Orb.agentSphere[level]!
            let points = Orb.spherePoints(Orb.sphere("ada"), look.count)
            for p in points { #expect(abs((p.x * p.x + p.y * p.y + p.z * p.z).squareRoot() - 1) < 1e-12 && p.size >= 0.7 && p.size < 1) }
            #expect(points.map(\.y) == points.map(\.y).sorted(by: >))
            #expect(look.r + 1.15 * look.glyph / 2 <= (level == .badge ? 100 : 89))
        }
    }

    @Test func aGlyphKeepsItsCharacterForSecondsAndIsDataOnlyNowAndThen() {
        let seed = Orb.seed("ada")
        for i in 0..<40 {
            var last = Orb.sphereGlyph(seed, i, 4, 0, 0).char
            var changed = 0.0
            for step in 1..<1200 {
                let t = Double(step) * 0.05
                let now = Orb.sphereGlyph(seed, i, 4, t, 0).char
                guard now != last else { continue }
                // (A beat can pick the same glyph again, so two changes are at least a beat apart: two seconds.)
                if changed > 0 { #expect(t - changed >= 2 - 0.06, "\(i) at \(t)") }
                (changed, last) = (t, now)
            }
        }
        let share = { (flash: Double) -> Double in
            var data = 0, all = 0
            for i in 0..<60 { for step in 0..<316 { all += 1; if Orb.sphereGlyph(seed, i, 3, Double(step) * 1.9, flash).data { data += 1 } } }
            return Double(data) / Double(all)
        }
        #expect(share(Orb.sphereFlash[.working]!) > share(Orb.sphereFlash[.idle]!))
        #expect(share(Orb.sphereFlash[.working]!) < 0.06)
        #expect(Orb.sphereFlash[.paused] == 0 && Orb.sphereFlash[.failed] == 0)
    }

    @Test func aFrameIsBackToFrontAndAWholeTurnOfItsRingIsThreeOfIts() {
        let sphere = Orb.sphere("coder")
        let points = Orb.spherePoints(sphere, 72)
        let at = { (angle: Double, mood: Orb.Mood, paper: Bool) in Orb.sphereFrame(sphere, points, angle: angle, radius: 72, scale: 1.02, glyph: 24, t: 31.5, mood: mood, paper: paper) }
        let shown = at(123.4, .idle, false)
        #expect(shown.map(\.near) == shown.map(\.near).sorted())
        for p in shown {
            #expect((p.x * p.x + p.y * p.y).squareRoot() <= 72 * 1.02 + 1e-9)
            #expect(p.shade == min(5, Int((p.near * 6).rounded(.down))))
            #expect(p.size <= 24 * 1.15 + 1e-9 && p.alpha <= 1 + 1e-12)
        }
        // On paper it is opaque further back; failed, its lower glyphs sag.
        #expect(at(123.4, .idle, true)[0].alpha > shown[0].alpha)
        #expect(at(123.4, .failed, false).map(\.y).max()! > shown.map(\.y).max()!)
        // The sphere turns three times as far as its ring, so its ring coming round to 0 again shows the same picture.
        for (a, b) in zip(at(10, .idle, false), at(370, .idle, false)) { #expect(abs(a.x - b.x) < 1e-9 && abs(a.y - b.y) < 1e-9) }
    }

    @Test func anAgentsArcsAreItsOwnOneOrTwoNoneOnASmallFace() {
        let sphere = Orb.sphere("coder")
        #expect(Orb.agentArcs(sphere, .badge).isEmpty)
        let arcs = Orb.agentArcs(sphere, .seat)
        #expect((1...2).contains(arcs.count))
        #expect(Orb.agentArcs(sphere, .full) == arcs)
        for arc in arcs {
            #expect(arc.length >= 50 && arc.length < 180)
            // A whole number of its ring's turns, so it never jumps where the ring comes round to 0.
            #expect(abs(arc.speed) == 1 || abs(arc.speed) == 2)
            #expect(arc.r + arc.width / 2 <= 100)
        }
        #expect(Set((0..<50).map { Orb.agentArcs(Orb.sphere("k\($0)"), .seat).count }) == [1, 2])
    }

    @Test func hisDataRingLightsAboutItsShareEachPlaceAlwaysLit() {
        let seed = Orb.seed("primary")
        let lit = Double((0..<480).filter { Orb.dataGlyph(seed, $0, 0, 0.62) != nil }.count) / 480
        #expect(lit > 0.5 && lit < 0.74)
        for k in 0..<48 {
            guard let shown = Orb.dataGlyph(seed, k, 12.3, 0.62) else { continue }
            #expect(Orb.dataGlyphs.contains(shown.char) && shown.alpha >= 0.45 && shown.alpha < 0.85)
            #expect(Orb.dataGlyph(seed, k, 999, 0.62) != nil)
        }
    }

    // ---- within a billionth ----

    private static func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= within }

    private static func same(_ a: Orb.ShownGlyph, _ b: Vectors.OrbCases.Spheres.Shown) -> Bool {
        close(a.x, b.x) && close(a.y, b.y) && close(a.near, b.near) && close(a.size, b.size) && close(a.alpha, b.alpha)
            && a.shade == b.shade && a.second == b.second && a.char == b.char && a.data == b.data
    }

    /// The frame is the PWA's, glyph for glyph and back to front; where neighbours are as near as each other (within a
    /// billionth), they may come in either order.
    private static func expectSameFrame(_ mine: [Orb.ShownGlyph], _ theirs: [Vectors.OrbCases.Spheres.Shown], _ what: String) {
        #expect(mine.count == theirs.count, "\(what): \(mine.count) ≠ \(theirs.count)")
        var start = 0
        while start < min(mine.count, theirs.count) {
            var end = start + 1
            while end < theirs.count && abs(theirs[end].near - theirs[end - 1].near) <= within { end += 1 }
            var left = Array(theirs[start..<end])
            for n in start..<min(end, mine.count) {
                if let at = left.firstIndex(where: { same(mine[n], $0) }) {
                    left.remove(at: at)
                } else {
                    Issue.record("\(what), glyph \(n): \(mine[n]) isn't the PWA's \(theirs[n])")
                }
            }
            start = end
        }
    }
}
