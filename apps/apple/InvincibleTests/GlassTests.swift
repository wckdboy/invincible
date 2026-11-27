import CoreGraphics
import Foundation
import SwiftUI
import Testing
@testable import Invincible

/*
 * An agent's glass (core's glass.ts) as this app reads and draws it: GlassData.swift held to the vectors' `glass` (its
 * shapes, path for path, and their bounds as this app parses them; its ramps; the Guardian's), AgentGlass held to core's
 * reading and rule, and its pictures: its paint inside its shape, nothing outside it, its blur from 40 pt.
 */
struct GlassTests {
    private final class Token {}

    struct Vectors: Decodable {
        struct Shape: Decodable {
            let id: String
            let name: String
            let family: String
            let kind: String
            let width: Double
            let smallWidth: Double
            let d: String
            let bounds: [Double]
        }
        struct Stops: Decodable, Equatable {
            let highlight: String
            let a: String
            let b: String
            let accent: String
            let deep: String
        }
        struct Ramp: Decodable {
            let id: String
            let name: String
            let light: Stops
            let dark: Stops
        }
        struct Pair: Decodable, Equatable {
            let color: Int
            let shape: Int
        }
        struct Read: Decodable {
            let id: String
            let profile: JSONValue?
            let glass: Pair
            let own: Bool
        }
        struct Given: Decodable {
            let id: String
            let seed: UInt32
            let glass: Pair
        }
        struct Chosen: Decodable {
            let id: String
            let others: [Pair]
            let chosen: JSONValue
            let glass: Pair
        }
        struct StateOf: Decodable {
            let state: String
            let glass: String
        }
        struct IBeam: Decodable {
            let glass: Shape
        }
        let shapes: [Shape]
        let ibeam: IBeam
        let ramps: [Ramp]
        let pearl: Ramp
        let states: [StateOf]
        let reads: [Read]
        let given: [Given]
        let chosen: [Chosen]
        let paint: JSONValue
        let glow: JSONValue
        let dot: JSONValue
        let pearlTile: JSONValue
    }

    static let vectors: Vectors = {
        struct Root: Decodable { let glass: Vectors }
        let url = Bundle(for: Token.self).url(forResource: "core-vectors", withExtension: "json")!
        return try! JSONDecoder().decode(Root.self, from: Data(contentsOf: url)).glass
    }()

    private func stops(_ s: AgentGlass.Stops) -> Vectors.Stops { .init(highlight: s.highlight, a: s.a, b: s.b, accent: s.accent, deep: s.deep) }

    @Test func itsShapesAreCoresPathForPath() {
        let v = Self.vectors
        #expect(AgentGlass.shapes.count == v.shapes.count)
        for (mine, core) in zip(AgentGlass.shapes, v.shapes) {
            #expect(mine.id == core.id && mine.name == core.name && mine.family == core.family, "\(core.id)")
            #expect(mine.tube == (core.kind == "tube") && mine.width == core.width && mine.smallWidth == core.smallWidth, "\(core.id)")
            #expect(mine.d == core.d, "\(core.id)")
        }
        #expect(AgentGlass.ibeam.d == v.ibeam.glass.d && AgentGlass.ibeam.width == v.ibeam.glass.width)
    }

    @Test func itsPathsAreParsedToEveryPointCoreNames() {
        // Every point a path names lies within the bounds core gives it: its path's own box, to the hundredth.
        for (shape, core) in zip(AgentGlass.shapes + [AgentGlass.ibeam], Self.vectors.shapes + [Self.vectors.ibeam.glass]) {
            var points: [CGPoint] = []
            AgentGlass.path(shape.d).applyWithBlock { element in
                let e = element.pointee
                let count = switch e.type {
                case .moveToPoint, .addLineToPoint: 1
                case .addQuadCurveToPoint: 2
                case .addCurveToPoint: 3
                default: 0
                }
                for i in 0..<count { points.append(e.points[i]) }
            }
            let box = [points.map(\.x).min()!, points.map(\.y).min()!, points.map(\.x).max()!, points.map(\.y).max()!].map(Double.init)
            #expect(zip(box, core.bounds).allSatisfy { abs($0 - $1) < 0.005 }, "\(core.id): \(box) against \(core.bounds)")
            // And none left out: a point for every two of its numbers.
            let numbers = shape.d.replacingOccurrences(of: "-", with: " -").split(whereSeparator: { "MLCQZ ".contains($0) }).count
            #expect(points.count * 2 == numbers, "\(core.id): \(points.count) points of \(numbers) numbers")
        }
    }

    @Test func itsPaintItsGlowAndItsDotAreCores() {
        let v = Self.vectors
        func n(_ value: JSONValue?) -> Double? { if case .number(let x)? = value { x } else { nil } }
        func ns(_ value: JSONValue?) -> [Double] { (value?.array ?? []).compactMap(n) }
        let paint = v.paint
        #expect(ns(paint["blend"]?["from"]) == [0, 0] && ns(paint["blend"]?["to"]) == [100, 100])
        let accent = AgentGlass.Paint.accent
        #expect(ns(paint["accent"]?["at"]) == [accent.x, accent.y] && n(paint["accent"]?["r"]) == accent.r && n(paint["accent"]?["opacity"]) == accent.opacity)
        let light = AgentGlass.Paint.highlight
        #expect(ns(paint["highlight"]?["at"]) == [light.x, light.y] && n(paint["highlight"]?["r"]) == light.r)
        #expect((paint["highlight"]?["stops"]?.array ?? []).map(ns) == AgentGlass.Paint.highlightStops.map { [$0.at, $0.opacity] })
        let shade = AgentGlass.Paint.shade
        #expect(ns(paint["shade"]?["at"]) == [shade.x, shade.y] && n(paint["shade"]?["r"]) == shade.r)
        #expect(n(paint["shade"]?["opacity"]?["light"]) == AgentGlass.Paint.shadeOpacity(.light) && n(paint["shade"]?["opacity"]?["dark"]) == AgentGlass.Paint.shadeOpacity(.dark))

        typealias G = AgentGlass.Glow
        let pool = v.glow["pool"], shadow = v.glow["shadow"], blur = v.glow["blur"]
        #expect(n(pool?["minSize"]) == Double(G.poolFrom) && n(pool?["spread"]) == Double(G.poolSpread) && n(pool?["breathe"]) == G.poolBreathe)
        #expect(n(pool?["opacity"]?["dark"]) == G.poolOpacity && n(pool?["opacity"]?["light"]) == 0)
        #expect((pool?["stops"]?.array ?? []).map { [n($0.array?[0]) ?? -1, $0.array?[1].string == "b" ? 1 : 0, n($0.array?[2]) ?? -1] } == G.poolStops.map { [$0.at, $0.ofB ? 1 : 0, $0.opacity] })
        #expect(n(shadow?["minSize"]) == Double(G.shadowFrom) && n(shadow?["breathe"]) == G.shadowBreathe)
        #expect(n(shadow?["opacity"]?["light"]) == G.shadowOpacity && n(shadow?["opacity"]?["dark"]) == 0)
        let box = shadow?["box"]
        #expect([n(box?["left"]), n(box?["right"]), n(box?["top"]), n(box?["bottom"])] == [G.shadowBox.left, G.shadowBox.right, G.shadowBox.top, G.shadowBox.bottom])
        #expect((shadow?["stops"]?.array ?? []).map { [n($0.array?[0]) ?? -1, n($0.array?[2]) ?? -1] } == G.shadowStops.map { [$0.at, $0.opacity] })
        #expect((shadow?["stops"]?.array ?? []).allSatisfy { $0.array?[1].string == "b" })
        #expect(n(blur?["minSize"]) == Double(G.blurFrom) && n(blur?["radius"]) == G.blurRadius)
        #expect(n(blur?["opacity"]?["light"]) == G.blurOpacity(.light) && n(blur?["opacity"]?["dark"]) == G.blurOpacity(.dark))
        #expect(n(blur?["dy"]?["light"]) == G.blurDrop(.light) && n(blur?["dy"]?["dark"]) == G.blurDrop(.dark))
        #expect(n(v.glow["period"]) == G.period)

        let dot = v.dot
        for state in AgentGlass.State.allCases {
            #expect(dot["colors"]?[state.rawValue]?["light"]?.string == AgentGlass.Dot.colors[state]?.light && dot["colors"]?[state.rawValue]?["dark"]?.string == AgentGlass.Dot.colors[state]?.dark, "\(state)")
        }
        #expect(n(dot["idleRing"]) == Double(AgentGlass.Dot.idleRing))
        #expect((dot["sizes"]?.array ?? []).map { [n($0["upTo"]), n($0["size"]), n($0["out"]), n($0["cut"])] } == AgentGlass.Dot.sizes.map { [Double($0.upTo), Double($0.size), Double($0.out), Double($0.cut)] as [Double?] })
        #expect(v.pearlTile["light"]?.string == AgentGlass.pearlTile.light && v.pearlTile["dark"] == .null)
    }

    @Test func itsRampsAreCores() {
        let v = Self.vectors
        #expect(AgentGlass.ramps.map(\.id) == v.ramps.map(\.id))
        for (mine, core) in zip(AgentGlass.ramps + [AgentGlass.pearl], v.ramps + [v.pearl]) {
            #expect(stops(mine.light) == core.light && stops(mine.dark) == core.dark, "\(core.id)")
        }
    }

    @Test func anAgentsGlassIsReadAsCoreReadsIt() {
        for read in Self.vectors.reads {
            let glass = AgentGlass.of(id: read.id, profile: read.profile)
            #expect(Vectors.Pair(color: glass.color, shape: glass.shape) == read.glass, "\(read.id) \(String(describing: read.profile))")
            #expect((AgentGlass.read(read.profile) != nil) == read.own, "\(String(describing: read.profile))")
        }
        for state in Self.vectors.states {
            #expect(AgentGlass.state(MarkState(rawValue: state.state)!).rawValue == state.glass, "\(state.state)")
        }
    }

    @Test func aNodesRuleIsCoresSoTheEditorShowsWhatItWillGive() {
        var given: [AgentGlass] = []
        for case_ in Self.vectors.given {
            #expect(AgentMark.seed(case_.id) == case_.seed)
            let glass = AgentGlass.assign(case_.id, after: given)
            #expect(Vectors.Pair(color: glass.color, shape: glass.shape) == case_.glass, "\(case_.id)")
            given.append(glass)
        }
        for case_ in Self.vectors.chosen {
            let others = case_.others.map { AgentGlass(color: $0.color, shape: $0.shape) }
            // (A colour chosen as an app chooses it: its hex, snapped; or one of the eight already, by its index.)
            let chosen: String? = switch case_.chosen {
            case .string(let hex): hex
            case .number(let n): AgentMark.palette[Int(n)].forms.light
            default: nil
            }
            let glass = AgentGlass.assign(case_.id, after: others, chosen: chosen)
            #expect(Vectors.Pair(color: glass.color, shape: glass.shape) == case_.glass, "\(case_.id)")
        }
    }

    // MARK: Its pictures

    /// A picture's pixel at a point of the avatar's box (0 to 100), un-premultiplied.
    private func pixel(_ image: CGImage, pad: CGFloat, x: Double, y: Double) -> (r: Int, g: Int, b: Int, a: Int) {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let ctx = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        let span = 100 * (1 + 2 * pad)
        let px = Int((Double(pad) * 100 + x) / span * Double(image.width)), py = Int((Double(pad) * 100 + y) / span * Double(image.height))
        let i = (py * image.width + px) * 4
        let a = Int(bytes[i + 3])
        let plain = { (c: UInt8) in a == 0 ? 0 : min(255, Int(c) * 255 / a) }
        return (plain(bytes[i]), plain(bytes[i + 1]), plain(bytes[i + 2]), a)
    }

    @Test func itsPaintIsInsideItsShapeAndNothingIsOutside() throws {
        // The Pill (index 12) in Sky's ramp at 24 pt: its middle solid, in its paint; its corners clear (no blur at 24).
        let pill = AgentGlass.shapes.firstIndex { $0.id == "pill" }!
        let image = try #require(GlassDrawing.draw(shape: AgentGlass.shapes[pill], ramp: AgentGlass.ramps[4], size: 24, theme: .light, scale: 4, pad: 0.3, blur: nil))
        let middle = pixel(image, pad: 0.3, x: 50, y: 50)
        #expect(middle.a > 250)
        #expect(middle.b > middle.r, "Sky's paint is blue: \(middle)")
        #expect(pixel(image, pad: 0.3, x: 8, y: 8).a == 0 && pixel(image, pad: 0.3, x: 92, y: 92).a == 0)
        // The Ring's middle is its hole.
        let ring = AgentGlass.shapes.firstIndex { $0.id == "ring" }!
        let hoop = try #require(GlassDrawing.draw(shape: AgentGlass.shapes[ring], ramp: AgentGlass.ramps[0], size: 24, theme: .dark, scale: 4, pad: 0.3, blur: nil))
        #expect(pixel(hoop, pad: 0.3, x: 50, y: 50).a == 0 && pixel(hoop, pad: 0.3, x: 50, y: 22).a > 250)
    }

    /// A picture's pixels, straight (not premultiplied), RGBA row by row.
    private func pixels(_ image: CGImage) -> [UInt8] {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let ctx = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }

    @Test func itsSoftEdgeLeavesNoSeamInItsPaint() throws {
        // A fill's soft edge is a round stroke along its path, half of it inside the fill: wherever the bare path is
        // solid, the soft shape is painted exactly as the bare one is, with no line where the stroke's inside meets the
        // fill (27 November 2026: the pearl I-beam at 96 pt showed one, 3 to 4 levels bright, its paint drawn twice).
        for (soft, ramp) in [(AgentGlass.ibeam, AgentGlass.pearl), (AgentGlass.shapes[20], AgentGlass.ramps[5])] {
            let bare = AgentGlass.Shape(id: soft.id, name: soft.name, family: soft.family, tube: false, width: 0, smallWidth: 0, d: soft.d)
            for theme in [AgentMark.Theme.light, .dark] {
                let a = try #require(GlassDrawing.draw(shape: soft, ramp: ramp, size: 96, theme: theme, scale: 3, pad: 0, blur: nil))
                let b = try #require(GlassDrawing.draw(shape: bare, ramp: ramp, size: 96, theme: theme, scale: 3, pad: 0, blur: nil))
                let (pa, pb, w, h) = (pixels(a), pixels(b), a.width, a.height)
                var worst = 0, at = (0, 0), solid = 0
                for y in 1..<(h - 1) {
                    for x in 1..<(w - 1) where (-1...1).allSatisfy({ dy in (-1...1).allSatisfy({ dx in pb[((y + dy) * w + x + dx) * 4 + 3] == 255 }) }) {
                        solid += 1
                        let i = (y * w + x) * 4
                        let apart = (0..<3).map { abs(Int(pa[i + $0]) - Int(pb[i + $0])) }.max()!
                        if apart > worst { (worst, at) = (apart, (x, y)) }
                    }
                }
                #expect(solid > 1000, "\(soft.id): the bare shape is solid somewhere")
                #expect(worst <= 1, "\(soft.id), \(theme): painted \(worst) levels apart from the bare shape at \(at)")
            }
        }
    }

    @Test @MainActor func fromFortyPointsItsBlurGlowsRoundItAndNotBefore() throws {
        let pill = AgentGlass.shapes.firstIndex { $0.id == "pill" }!
        let at40 = try #require(GlassPictures.picture(shape: pill, ramp: 4, size: 40, theme: .dark, scale: 2))
        let at24 = try #require(GlassPictures.picture(shape: pill, ramp: 4, size: 24, theme: .dark, scale: 2))
        // Five units out from the pill's long side (x + y = 124.8, its lower right): a faint glow at 40, nothing at 24.
        let span = (at40.span - 1) / 2
        #expect(pixel(at40.image, pad: span, x: 66, y: 66).a > 0)
        #expect(pixel(at24.image, pad: span, x: 66, y: 66).a == 0)
        // And it is made once: asked again, the same picture.
        #expect(GlassPictures.picture(shape: pill, ramp: 4, size: 40, theme: .dark, scale: 2)!.image === at40.image)
    }

    /// A view, drawn as the screen would at twice its points: its pixels, straight, and how wide it is.
    @MainActor private func drawn(_ view: some View, width: CGFloat, height: CGFloat) throws -> (bytes: [UInt8], width: Int) {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 2
        let image = try #require(renderer.cgImage)
        return (pixels(image), image.width)
    }

    @Test @MainActor func aStatesDotIsCutOutOfWhatItSitsOn() throws {
        // The dot (GlassCut, the app's and a Live Activity's) on a red 40 pt box, set 10 pt in: working's blue at its
        // middle, the ring round it taken out of the red, the red elsewhere as it was.
        let red = Color(.sRGB, red: 1, green: 0, blue: 0)
        let (bytes, width) = try drawn(GlassCut(size: 40, state: .working, theme: .light) { red.frame(width: 40, height: 40) }.padding(10), width: 60, height: 60)
        func at(_ x: Double, _ y: Double) -> [Int] { let i = (Int(y * 2) * width + Int(x * 2)) * 4; return (0..<4).map { Int(bytes[i + $0]) } }
        // At 40 pt: a dot of 10, 1 past the corner, cut 2 wide: its middle at 36 of the box, its ring out to 7 from it.
        let middle = 10 + 40 + 1 - 5.0
        #expect(at(middle, middle) == [0x15, 0x5d, 0xfc, 255], "\(at(middle, middle))")
        #expect(at(middle - 4.4, middle - 4.4)[3] == 0, "the cut: \(at(middle - 4.4, middle - 4.4))")
        #expect(at(20, 20) == [255, 0, 0, 255] && at(45, 20) == [255, 0, 0, 255])
    }

    @Test @MainActor func anAgentsFaceIsItsGlass() throws {
        // AgentFace draws the glass its avatar names: the Pill in Sky's ramp, its middle solid and blue.
        let pill = AgentGlass.shapes.firstIndex { $0.id == "pill" }!
        let profile = JSONValue.object(["v": .number(4), "color": .string(AgentMark.palette[4].forms.light), "shape": .number(Double(pill))])
        #expect(AgentGlass.of(id: "builder", profile: profile) == AgentGlass(color: 4, shape: pill))
        let renderer = ImageRenderer(content: AgentFace(id: "builder", profile: profile, size: 100).environment(\.colorScheme, .light).frame(width: 100, height: 100))
        renderer.scale = 2
        let image = try #require(renderer.cgImage)
        let middle = pixel(image, pad: 0, x: 50, y: 50)
        #expect(middle.a > 250 && middle.b > middle.r, "\(middle)")
    }
}
