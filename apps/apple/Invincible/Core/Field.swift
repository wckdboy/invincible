import Foundation

/*
 * The primary's field (the PWA's lib/field.ts, held to it by the vectors): lines of force looping from pole to pole round a
 * dark core, lit from the upper left and burning at the rim on the far side (your choice for the app icon, 26 November
 * 2026: "field aurum"). Pure: points in space with a colour and a size, and their place on a square picture. Every orb
 * is this field (FieldOrb.swift says whose, at what size and in what mood; FieldOrbView draws it), the primary's in gold and
 * each agent's in its own colours.
 *
 * A field is made in two steps, so an orb that turns does the costly part once: its model (each line's longitude and
 * width from its seed, each step's angle, its lean, its colours in linear light), then its points at a turn (`at`, into a
 * buffer it keeps). `points` is the two at once.
 */

/// A field's colours: its key light (the lit face, bright then deep: `key[0]`, `key[1]`) and the rim burning on its far
/// side, each six hex digits after a `#`.
struct FieldColours: Equatable, Hashable, Sendable, Decodable {
    let key: [String]
    let rim: String
}

enum Field {
    /// Gold and copper: the field's fire.
    static let aurum = FieldColours(key: ["#fff4d6", "#ffb12e"], rim: "#ff5a2a")

    /// A colour in linear light (not sRGB): 0 to 1 and beyond, before tone mapping.
    struct Rgb: Equatable, Sendable {
        var r: Double
        var g: Double
        var b: Double
    }

    /// sRGB hex to linear light, as three.js reads a colour.
    static func linear(_ hex: String) -> Rgb {
        func channel(_ at: Int) -> Double {
            let c = Double(Int(hex.dropFirst(at).prefix(2), radix: 16) ?? 0) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return Rgb(r: channel(1), g: channel(3), b: channel(5))
    }

    /// Where the key light comes from and where the rim light burns: unit vectors in the field's space (x right, y up,
    /// z towards you).
    static let key: [Double] = unit(-0.55, 0.58, 0.6)
    static let rimLight: [Double] = unit(0.8, -0.45, -0.35)

    private static func unit(_ x: Double, _ y: Double, _ z: Double) -> [Double] {
        let l = hypot3(x, y, z)
        let d = l == 0 ? 1 : l
        return [x / d, y / d, z / d]
    }

    /// Math.hypot of three, as a length.
    @inline(__always) static func hypot3(_ x: Double, _ y: Double, _ z: Double) -> Double { (x * x + y * y + z * z).squareRoot() }

    /// A field's colours in linear light, read once (`shadeLit` reads them on every point).
    struct Light: Equatable, Sendable {
        let deep: Rgb
        let bright: Rgb
        let rim: Rgb
    }

    static func light(_ colours: FieldColours) -> Light {
        Light(deep: linear(colours.key[1]), bright: linear(colours.key[0]), rim: linear(colours.rim))
    }

    /// A point's colour by the key light on it and the rim light behind it; how strongly it is lit (`k`, 0 to 1); and the
    /// two lights apart, the key's (`lit`) and the rim's (`rim`), 0 to 1 each (`k` is the greater).
    struct Shade: Equatable, Sendable {
        let rgb: Rgb
        let k: Double
        let lit: Double
        let rim: Double
    }

    static func shadeLit(_ nx: Double, _ ny: Double, _ nz: Double, _ light: Light) -> Shade {
        let lit = pow(max(0, nx * key[0] + ny * key[1] + nz * key[2]), 1.2)
        let facing = max(0, nz)
        let rimK = pow(1 - facing, 2.4) * max(0, nx * rimLight[0] + ny * rimLight[1] + nz * rimLight[2] + 0.25)
        let (deep, bright, rim) = (light.deep, light.bright, light.rim)
        func mix(_ a: Rgb, _ b: Rgb, _ t: Double) -> Rgb { Rgb(r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t) }
        var c = Rgb(r: deep.r * 0.12, g: deep.g * 0.12, b: deep.b * 0.12)
        c = mix(c, deep, min(1, lit * 1.5))
        c = mix(c, bright, max(0, lit - 0.4) * 1.7)
        let k = max(lit, rimK), gain = 0.12 + 1.9 * k
        return Shade(rgb: Rgb(r: (c.r + rim.r * rimK * 2.2) * gain, g: (c.g + rim.g * rimK * 2.2) * gain, b: (c.b + rim.b * rimK * 2.2) * gain), k: k, lit: lit, rim: rimK)
    }

    /// The same random numbers every time (Park and Miller's), so a field is the same picture on every machine.
    private struct Random {
        var s: Int
        mutating func next() -> Double {
            s = (s * 16807) % 2_147_483_647
            return Double(s) / 2_147_483_647
        }
    }

    /// A field's fixed part: its lines' longitudes before any turn and their widths (its seed's), each step's angle along
    /// a line (its sine, cosine and sine squared), its lean's cosines and sines, its weight and its colours.
    struct Model: Sendable {
        let lines: Int
        let steps: Int
        let weight: Double
        let phi: [Double]
        let width: [Double]
        let sin: [Double]
        let cos: [Double]
        let sin2: [Double]
        /// The lean: cos and sin about x, y and z.
        let lean: [Double]
        let light: Light
    }

    static func model(lines: Int = 46, steps: Int = 260, tilt: [Double] = [0.42, 0.3, -0.18], weight: Double = 1, colours: FieldColours = aurum, seed: Int = 11) -> Model {
        var rnd = Random(s: seed)
        var phi = [Double](repeating: 0, count: lines), width = [Double](repeating: 0, count: lines)
        for line in 0..<lines {
            phi[line] = (Double(line) / Double(lines)) * Double.pi * 2 + rnd.next() * 0.12
            width[line] = 1.05 + 0.75 * pow(rnd.next(), 0.7)
        }
        var sines = [Double](repeating: 0, count: steps), cosines = [Double](repeating: 0, count: steps), squares = [Double](repeating: 0, count: steps)
        if steps > 1 {
            for j in 1..<steps {
                let th = (Double(j) / Double(steps)) * Double.pi
                let s = Foundation.sin(th)
                sines[j] = s
                cosines[j] = Foundation.cos(th)
                squares[j] = s * s
            }
        }
        let (ax, ay, az) = (tilt[0], tilt[1], tilt[2])
        return Model(
            lines: lines, steps: steps, weight: weight, phi: phi, width: width, sin: sines, cos: cosines, sin2: squares,
            lean: [Foundation.cos(ax), Foundation.sin(ax), Foundation.cos(ay), Foundation.sin(ay), Foundation.cos(az), Foundation.sin(az)],
            light: light(colours)
        )
    }

    /// Where a field's points go: x, y, z, their colour (r, g, b, linear), size, the key's and the rim's light on each
    /// (Shade's `lit` and `rim`), and where each is on its line (`at`: its line times the model's steps, plus its step,
    /// so two points follow each other on a line where one's is the other's plus one), as many as a model can have.
    struct Buffer: Sendable {
        var at: [Int]
        var x: [Double]
        var y: [Double]
        var z: [Double]
        var r: [Double]
        var g: [Double]
        var b: [Double]
        var size: [Double]
        var lit: [Double]
        var rim: [Double]

        init(_ model: Model) {
            let n = model.lines * model.steps
            let zero = [Double](repeating: 0, count: n)
            (at, x, y, z, r, g, b, size, lit, rim) = ([Int](repeating: 0, count: n), zero, zero, zero, zero, zero, zero, zero, zero, zero)
        }
    }

    /// The field's points turned `turn` radians about its axis, into `out`, and how many there are: each line a loop from
    /// pole to pole (a dipole's, r = L·sin²θ) at its own longitude and width, none inside the core (r < 0.32) and none the
    /// lights leave dark. `light` colours it otherwise than its model (a mood's tint, FieldOrb.colours).
    @discardableResult
    static func at(_ model: Model, turn: Double, into out: inout Buffer, light: Light? = nil) -> Int {
        let light = light ?? model.light
        let (lines, steps, weight) = (model.lines, model.steps, model.weight)
        let (cx, sx, cy, sy, cz, sz) = (model.lean[0], model.lean[1], model.lean[2], model.lean[3], model.lean[4], model.lean[5])
        var n = 0
        for line in 0..<lines {
            let p = model.phi[line] + turn, cp = Foundation.cos(p), sp = Foundation.sin(p), w = model.width[line]
            guard steps > 1 else { continue }
            for j in 1..<steps {
                let r = w * model.sin2[j]
                if r < 0.32 { continue }
                let rs = r * model.sin[j]
                let a0 = rs * cp, a1 = r * model.cos[j], a2 = rs * sp
                // The lean, as an XYZ Euler turns (three.js' default order: the matrix Rx·Ry·Rz applied to the point).
                var x = a0 * cz - a1 * sz, y = a0 * sz + a1 * cz, z = a2
                let x2 = x * cy + z * sy, z2 = -x * sy + z * cy
                x = x2
                z = z2
                let y3 = y * cx - z * sx, z3 = y * sx + z * cx
                y = y3
                z = z3
                let l = hypot3(x, y, z), d = l == 0 ? 1 : l
                let s = shadeLit(x / d, y / d, z / d, light)
                if s.k < 0.02 { continue }
                let near = min(1, 1.9 / (0.6 + r)), g = 0.35 + 0.65 * near
                out.at[n] = line * steps + j
                out.x[n] = x * 1.05
                out.y[n] = y * 1.05
                out.z[n] = z * 1.05
                out.r[n] = s.rgb.r * g
                out.g[n] = s.rgb.g * g
                out.b[n] = s.rgb.b * g
                out.size[n] = (0.009 + 0.02 * s.k) * weight
                out.lit[n] = s.lit
                out.rim[n] = s.rim
                n += 1
            }
        }
        return n
    }

    /// One point of light: where it is (the field's own units, the core at 0), its colour and its size.
    struct Point: Equatable, Sendable {
        let x: Double
        let y: Double
        let z: Double
        let rgb: Rgb
        let size: Double
    }

    /// The field's points at a turn: the model and its points at once, as the icon takes them.
    static func points(lines: Int = 46, steps: Int = 260, tilt: [Double] = [0.42, 0.3, -0.18], weight: Double = 1, colours: FieldColours = aurum, seed: Int = 11, turn: Double = 0) -> [Point] {
        let made = model(lines: lines, steps: steps, tilt: tilt, weight: weight, colours: colours, seed: seed)
        var out = Buffer(made)
        let count = at(made, turn: turn, into: &out)
        return (0..<count).map { Point(x: out.x[$0], y: out.y[$0], z: out.z[$0], rgb: Rgb(r: out.r[$0], g: out.g[$0], b: out.b[$0]), size: out.size[$0]) }
    }

    /// Where a point falls on a square picture `size` across, seen from a camera on the z axis (as the icon is drawn): its
    /// pixel position, its diameter in pixels, and whether it is in front of the camera at all.
    static func project(x: Double, y: Double, z: Double, size pointSize: Double, picture: Double, fov: Double = 28, distance: Double = 8.3, zoom: Double = 1) -> (x: Double, y: Double, d: Double, visible: Bool) {
        let depth = distance - z
        let f = (picture / 2 / Foundation.tan(((fov / 2) * Double.pi) / 180)) * zoom
        return (picture / 2 + (x * f) / depth, picture / 2 - (y * f) / depth, (pointSize * (picture / 2) * zoom) / depth, depth > 0.1)
    }
}
