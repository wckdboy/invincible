import CoreGraphics
import SwiftUI
import Testing
@testable import Invincible

/// The app's mark, the I-beam, drawn as a shape of its own (IBeam): held to scripts/mark.ts, the icons' own renderer,
/// through the vectors, so the mark in the app is the one on the Home Screen.
@Suite struct MarkTests {
    @Test func itsRectanglesAndItsBoxAreTheIconsOwn() {
        let mark = Vectors.shared.mark
        #expect(IBeam.rects.map { [Double($0.minX), Double($0.minY), Double($0.maxX), Double($0.maxY)] } == mark.rects)
        #expect(IBeam.box == mark.box)
    }

    @Test func itFillsExactlyTheIconsPolygonAtAnySize() {
        // The polygon scripts/mark.ts gives SVG, in its 100-unit box.
        let points = Vectors.shared.mark.polygon.split(separator: " ").map { pair -> CGPoint in
            let xy = pair.split(separator: ",").compactMap { Double($0) }
            return CGPoint(x: xy[0], y: xy[1])
        }
        var polygon = Path()
        polygon.addLines(points)
        polygon.closeSubpath()
        for side in [18.0, 48.0, 100.0] {
            let frame = CGRect(x: 0, y: 0, width: side, height: side)
            let shape = IBeam().path(in: frame)
            // A grid over the frame, each point inside the shape exactly where it is inside the polygon (the box centred, at MARK_BOX).
            let unit = side * IBeam.box / 100
            for i in 0..<40 {
                for j in 0..<40 {
                    let at = CGPoint(x: (Double(i) + 0.5) * side / 40, y: (Double(j) + 0.5) * side / 40)
                    let inBox = CGPoint(x: (at.x - side / 2) / unit + 50, y: (at.y - side / 2) / unit + 50)
                    #expect(shape.contains(at) == polygon.contains(inBox), "at \(at) in a \(side) pt frame")
                }
            }
        }
    }

    @Test func itIsCentredAndKeepsItsProportionsInAFrameThatIsntSquare() {
        let shape = IBeam().path(in: CGRect(x: 0, y: 0, width: 200, height: 100))
        let bounds = shape.boundingRect
        // The 100-unit box on the shorter side: 0.7 of 100 pt, its mark 56 × 72 units of it, centred.
        #expect(abs(bounds.width - 56 * 0.7) < 0.001)
        #expect(abs(bounds.height - 72 * 0.7) < 0.001)
        #expect(abs(bounds.midX - 100) < 0.001)
        #expect(abs(bounds.midY - 50) < 0.001)
    }
}
