import CoreGraphics
import CoreImage
import Foundation

/// One glass, drawn with Core Graphics (and its blur with Core Image) from Core/Glass.swift's numbers, as the web's SVG
/// draws it: its paint over its fill and its soft stroke (or its tube's round line), as one.
enum GlassDrawing {
    static func draw(shape: AgentGlass.Shape, ramp: AgentGlass.Ramp, size: CGFloat, theme: AgentMark.Theme, scale: CGFloat, pad: CGFloat, blur: CIContext?) -> CGImage? {
        let pixels = Int((size * (1 + 2 * pad) * scale).rounded(.up))
        guard pixels > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let k = size * scale / 100
        let origin = CGPoint(x: size * pad * scale, y: size * pad * scale)
        func layer(_ draw: (CGContext) -> Void) -> CGImage? {
            guard let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            // (Its box from the top left, as the path's numbers are.)
            ctx.translateBy(x: 0, y: CGFloat(pixels))
            ctx.scaleBy(x: 1, y: -1)
            draw(ctx)
            return ctx.makeImage()
        }
        let width = (size <= 16 ? shape.smallWidth : shape.width) * k
        let path = AgentGlass.path(shape.d, scale: k, offset: origin)
        let regions: [CGPath] = shape.tube
            ? [path.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 10)]
            : width > 0 ? [path, path.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 10)] : [path]
        let stops = ramp.on(theme)
        // Its region, opaque, then its paint's layers atop it: the paint drawn once, through the one region, so no seam
        // shows where a fill's soft stroke meets the fill (each region painted in its own clip blended the see-through
        // layers twice along the stroke's inside edge).
        func paint(_ ctx: CGContext) {
            ctx.setFillColor(CGColor(gray: 0, alpha: 1))
            for region in regions {
                ctx.addPath(region)
                ctx.fillPath(using: .winding)
            }
            ctx.setBlendMode(.sourceAtop)
            fill(ctx, stops: stops, theme: theme, k: k, origin: origin, space: space)
            ctx.setBlendMode(.normal)
        }
        guard let shapeImage = layer(paint) else { return nil }
        guard let blur, let ci = CIFilter(name: "CIGaussianBlur") else { return shapeImage }
        // A blurred copy of it, under it: at the page's opacity, moved down on a light page.
        ci.setValue(CIImage(cgImage: shapeImage), forKey: kCIInputImageKey)
        ci.setValue(AgentGlass.Glow.blurRadius * k, forKey: kCIInputRadiusKey)
        let rect = CGRect(x: 0, y: 0, width: pixels, height: pixels)
        guard let blurred = ci.outputImage?.cropped(to: rect), let soft = blur.createCGImage(blurred, from: rect) else { return shapeImage }
        // (Pictures drawn as they are, in Core Graphics' own space: down the page is down its y.)
        guard let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return shapeImage }
        ctx.setAlpha(AgentGlass.Glow.blurOpacity(theme))
        ctx.draw(soft, in: rect.offsetBy(dx: 0, dy: -AgentGlass.Glow.blurDrop(theme) * k))
        ctx.setAlpha(1)
        ctx.draw(shapeImage, in: rect)
        return ctx.makeImage() ?? shapeImage
    }

    /// The paint's four layers over the box (AgentGlass.Paint), in the blend mode set: atop the region already drawn.
    private static func fill(_ ctx: CGContext, stops: AgentGlass.Stops, theme: AgentMark.Theme, k: CGFloat, origin: CGPoint, space: CGColorSpace) {
        func colour(_ hex: String, _ alpha: Double = 1) -> CGColor { CGColor(colorSpace: space, components: rgb(hex) + [alpha]) ?? CGColor(gray: 0, alpha: 0) }
        func gradient(_ list: [(CGColor, CGFloat)]) -> CGGradient? { CGGradient(colorsSpace: space, colors: list.map(\.0) as CFArray, locations: list.map(\.1)) }
        func at(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: origin.x + x * k, y: origin.y + y * k) }
        if let blend = gradient([(colour(stops.a), 0), (colour(stops.b), 1)]) {
            ctx.drawLinearGradient(blend, start: at(0, 0), end: at(100, 100), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        let accent = AgentGlass.Paint.accent
        if let pool = gradient([(colour(stops.accent, accent.opacity), 0), (colour(stops.accent, 0), 1)]) {
            ctx.drawRadialGradient(pool, startCenter: at(accent.x, accent.y), startRadius: 0, endCenter: at(accent.x, accent.y), endRadius: accent.r * k, options: [])
        }
        let light = AgentGlass.Paint.highlight
        if let pool = gradient(AgentGlass.Paint.highlightStops.map { (colour(stops.highlight, $0.opacity), CGFloat($0.at)) }) {
            ctx.drawRadialGradient(pool, startCenter: at(light.x, light.y), startRadius: 0, endCenter: at(light.x, light.y), endRadius: light.r * k, options: [])
        }
        let shade = AgentGlass.Paint.shade
        if let deep = gradient([(colour(stops.deep, AgentGlass.Paint.shadeOpacity(theme)), 0), (colour(stops.deep, 0), 1)]) {
            ctx.drawRadialGradient(deep, startCenter: at(shade.x, shade.y), startRadius: 0, endCenter: at(shade.x, shade.y), endRadius: shade.r * k, options: [])
        }
    }

    private static func rgb(_ hex: String) -> [CGFloat] {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let n = UInt32(digits, radix: 16) else { return [0, 0, 0] }
        return [CGFloat((n >> 16) & 0xff) / 255, CGFloat((n >> 8) & 0xff) / 255, CGFloat(n & 0xff) / 255]
    }
}
