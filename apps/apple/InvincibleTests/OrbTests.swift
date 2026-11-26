import Foundation
import Testing
@testable import Invincible

/// The primary's orb, as the PWA draws it (`lib/orb.ts`): the same colours and the same parts at every size (its rings, its
/// data ring, its nucleus and its sphere of glyphs), checked against its own output.
struct OrbTests {
    let orb = Vectors.shared.orb

    @Test func eachStatesColoursAreThePWAs() {
        #expect(Set(Orb.Tone.allCases.map(\.rawValue)) == Set(orb.palettes.keys))
        for tone in Orb.Tone.allCases {
            let theirs = orb.palettes[tone.rawValue]
            #expect(Orb.palette(tone) == theirs.map { Orb.Palette(tint: $0.tint, light: $0.light, deep: $0.deep) }, "\(tone)")
        }
    }

    @Test func eachLevelIsDrawnFromThePWAsParts() {
        #expect(Set(orb.levels.keys) == ["badge", "seat", "full"])
        for (level, parts) in orb.levels {
            let size: Double = level == "badge" ? 28 : level == "seat" ? 64 : 168
            #expect(Orb.parts(size).map(\.name) == parts.map(\.name), "\(level)")
            #expect(Orb.parts(size) == parts.map(Self.part), "\(level)")
        }
    }

    @Test func eachSizeShowsAsMuchOfHimAsThePWAs() {
        for item in orb.sizes { #expect(Orb.level(item.size).rawValue == item.level, "\(item.size)") }
    }

    @Test func hisLinesToneIsHisOrbs() {
        let tones: [PrimaryNow.Tone] = [.neutral, .accent, .warn, .ok]
        #expect(tones.map { Orb.Tone($0) } == [.neutral, .accent, .warn, .ok])
    }

    @Test func whereHeStandsIsHisSeatsColourAsThePWAs() {
        for item in orb.states {
            #expect(Standing(rawValue: item.state).map { Orb.Tone($0).rawValue } == item.tone, "\(item.state)")
        }
    }

    @Test func hisFullOrbHasItsDataRingNucleusAndSphereOfGlyphs() {
        // (Your words, 25 November 2026: "also update the primary's orb", "use glyph and randomness on the orbs".)
        let full = Orb.parts(168).map(\.name)
        for name in ["data", "nucleus", "sphere"] { #expect(full.contains(name), "\(name)") }
        // The sphere is drawn last, over its nucleus and the light it sits in; the data ring turns inside the ticks.
        #expect(full.suffix(3) == ["glow", "nucleus", "sphere"])
        #expect(full.firstIndex(of: "data")! > full.firstIndex(of: "marks")!)
        // Every level has its sphere round a nucleus; only the full one its data ring.
        for size in [28.0, 64] {
            let names = Orb.parts(size).map(\.name)
            #expect(names.suffix(3) == ["glow", "nucleus", "sphere"], "\(size)")
            #expect(!names.contains("data"), "\(size)")
        }
    }

    /// A part as lib/orb.ts wrote it, as the app's own (what it doesn't carry is NaN, which equals nothing).
    private static func part(_ given: Vectors.OrbCases.Part) -> Orb.Part {
        let number = { (value: Double?) in value ?? .nan }
        let ink = { (name: String?) in Orb.Ink(rawValue: name ?? "") ?? .white }
        let stops = (given.stops ?? []).map { Orb.Stop(at: $0.at, ink: ink($0.ink), opacity: $0.opacity) }
        let kind: Orb.Kind = switch given.kind {
        case "disc": .disc(r: number(given.r), cx: number(given.cx), cy: number(given.cy), spread: number(given.spread), stops: stops)
        case "ring": .ring(r: number(given.r), width: number(given.width), ink: ink(given.ink), opacity: number(given.opacity), arcs: given.arcs.map { $0.map { Orb.Arc(from: $0.first ?? .nan, to: $0.last ?? .nan) } })
        case "ticks": .ticks(r: number(given.r), count: given.count ?? -1, offset: number(given.offset), length: number(given.length), width: number(given.width), ink: ink(given.ink), opacity: number(given.opacity))
        case "glyphs": .glyphs(r: number(given.r), count: given.count ?? -1, size: number(given.size), share: number(given.share), ink: ink(given.ink))
        // (A kind the app doesn't know is a sphere of nothing: it equals none of the app's parts.)
        default: given.kind == "sphere"
            ? .sphere(r: number(given.r), count: given.count ?? -1, glyph: number(given.glyph), second: ink(given.second))
            : .sphere(r: .nan, count: -1, glyph: .nan, second: .white)
        }
        return Orb.Part(name: given.name, kind: kind)
    }
}
