import Foundation
import SwiftUI
import Testing
@testable import Invincible

/// The orbs as they are drawn (OrbView.swift): a sphere's glyphs are drawn, and drawn the same again from the text kept
/// resolved (GlyphTexts); an agent's face and the primary's orb are ink on paper on a light page; and an agent's colour is
/// the one you chose.
@MainActor struct OrbDrawingTests {
    @Test func aSpheresGlyphsAreDrawnAndDrawnTheSameAgainFromWhatIsKept() throws {
        let sphere = Orb.sphere("coder")
        let shown = Orb.sphereFrame(sphere, Orb.spherePoints(sphere, 72), angle: 40, radius: 72, scale: 1, glyph: 24, t: 3, mood: .working)
        let colors = AgentOrb.colors(id: "coder", profile: nil)
        let shades = GlyphShades(tint: Orb.sphereShades(ink: colors.tint, light: colors.light, deep: colors.deep), second: Orb.sphereShades(ink: colors.second, light: colors.light, deep: colors.deep))
        let glyphs = Canvas { context, size in
            context.translateBy(x: size.width / 2, y: size.height / 2)
            context.scaleBy(x: size.width / 200, y: size.height / 200)
            OrbPainter.glyphs(shown, shades, in: context)
        }
        let first = try #require(Self.pixels(glyphs, size: 104))
        #expect(GlyphTexts.count > 0)
        let again = try #require(Self.pixels(glyphs, size: 104))
        // Its glyphs, and nothing else, are on it: a good many pixels of them, and none at its corners.
        #expect(Self.lit(first) > 200)
        #expect(first == again)
        #expect(first[3] == 0)
    }

    @Test func anAgentsFaceIsInkOnPaperOnALightPageAndInTheColourYouChose() throws {
        let dark = try #require(Self.pixels(AgentFace(id: "coder", size: 104).environment(\.colorScheme, .dark), size: 104))
        let light = try #require(Self.pixels(AgentFace(id: "coder", size: 104).environment(\.colorScheme, .light), size: 104))
        #expect(Self.lit(dark) > 500)
        #expect(dark != light)
        let chosen = JSONValue.object(["v": .number(2), "color": .string("#123456")])
        let mine = try #require(Self.pixels(AgentFace(id: "coder", profile: chosen, size: 104).environment(\.colorScheme, .dark), size: 104))
        #expect(mine != dark)
        // A small face, a row's and a welcome's draw too: a badge's sphere, a seat's with its arcs, the full one.
        for size in [32.0, 56, 120] {
            #expect(Self.lit(try #require(Self.pixels(AgentFace(id: "ada", size: size).environment(\.colorScheme, .dark), size: size))) > 50, "\(size)")
        }
    }

    @Test func hisOrbIsInkOnPaperOnALightPageAtEverySize() throws {
        for size in [28.0, 64, 168] {
            let dark = try #require(Self.pixels(PrimaryOrb(size: size, tone: .accent).environment(\.colorScheme, .dark), size: size))
            let light = try #require(Self.pixels(PrimaryOrb(size: size, tone: .accent).environment(\.colorScheme, .light), size: size))
            #expect(Self.lit(dark) > 50, "\(size)")
            #expect(dark != light, "\(size)")
        }
    }

    /// A view's pixels as SwiftUI draws it alone, `size` points square at twice its size: RGBA, eight bits each.
    private static func pixels(_ view: some View, size: CGFloat) -> [UInt8]? {
        let renderer = ImageRenderer(content: view.frame(width: size, height: size))
        renderer.scale = 2
        guard let image = renderer.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let (width, height) = (image.width, image.height)
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? bytes : nil
    }

    /// How many pixels are more than faintly there.
    private static func lit(_ pixels: [UInt8]) -> Int { stride(from: 3, to: pixels.count, by: 4).filter { pixels[$0] > 32 }.count }
}
