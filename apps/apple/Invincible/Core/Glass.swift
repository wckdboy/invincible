import CoreGraphics
import Foundation

/*
 * An agent's glass (core's glass.ts; the owner's word of 27 November 2026 that the Grille goes): its shape, one of 22 of
 * our own, and its colour, one of eight ramps on the palette's hues, as its node gave them ({v: 4, color, shape}), the
 * same on every device. Read and drawn from core's numbers (GlassData.swift), held to the vectors' `glass` by
 * GlassTests: this file is the reading and the rule, UI/GlassView.swift the drawing.
 */
struct AgentGlass: Equatable, Hashable, Sendable {
    /// Its colour: an index into AgentMark.palette, and so into AgentGlass.ramps.
    var color: Int
    /// Its shape: an index into AgentGlass.shapes.
    var shape: Int

    struct Shape: Sendable {
        let id: String
        let name: String
        let family: String
        /// A tube (a round line `width` wide along its path), or a fill softened by a round stroke `width` wide (0: none).
        let tube: Bool
        let width: Double
        let smallWidth: Double
        let d: String
    }

    struct Stops: Sendable, Equatable {
        let highlight: String
        let a: String
        let b: String
        let accent: String
        let deep: String
    }

    struct Ramp: Sendable {
        let id: String
        let name: String
        let light: Stops
        let dark: Stops
        func on(_ theme: AgentMark.Theme) -> Stops { theme == .dark ? dark : light }
    }

    /// What its dot says: working, needs you and failed are their own; idle is the rest, the word beside it saying which.
    enum State: String, Sendable, CaseIterable {
        case working, needs, idle, failed
    }

    static func state(_ mark: MarkState) -> State {
        switch mark {
        case .working: .working
        case .needs: .needs
        case .failed: .failed
        default: .idle
        }
    }
}

// MARK: - Its paint, its glow, its dot (core's GLASS_PAINT, GLASS_GLOW, GLASS_DOT)

extension AgentGlass {
    /// The paint over the shape's 100 × 100 box, its layers in this order: `a` to `b` along the diagonal; `accent` in a
    /// pool at the bottom right; `highlight` in a pool at the top left (its opacity at each stop); the `deep` shade in the
    /// bottom-right corner, at the page's opacity, to nothing.
    enum Paint {
        static let accent = (x: 82.0, y: 78.0, r: 55.0, opacity: 0.95)
        static let highlight = (x: 27.0, y: 20.0, r: 50.0)
        static let highlightStops: [(at: Double, opacity: Double)] = [(0, 0.95), (0.45, 0.38), (1, 0)]
        static let shade = (x: 96.0, y: 100.0, r: 82.0)
        static func shadeOpacity(_ theme: AgentMark.Theme) -> Double { theme == .dark ? 0.72 : 0.42 }
    }

    /// Its glow, by its size in points: on a dark page a pool of its light behind it from 24, on a light one a tinted
    /// shadow under it from 20; from 40 a blurred copy of it. Only working breathes, every `period` seconds.
    enum Glow {
        static let poolFrom: CGFloat = 24
        /// The pool's circle reaches this far past the box on each side, as a share of its size.
        static let poolSpread: CGFloat = 0.3
        static let poolStops: [(at: Double, ofB: Bool, opacity: Double)] = [(0, false, 0.46), (0.64, true, 0.16), (1, true, 0)]
        static let poolOpacity = 0.7, poolBreathe = 0.45
        static let shadowFrom: CGFloat = 20
        /// The shadow's ellipse, as shares of the box: in 4 % from each side, from 64 % of its height to 116 %.
        static let shadowBox = (left: 0.04, right: 0.04, top: 0.64, bottom: 1.16)
        static let shadowStops: [(at: Double, opacity: Double)] = [(0, 0.3), (1, 0)]
        static let shadowOpacity = 0.9, shadowBreathe = 0.55
        static let blurFrom: CGFloat = 40
        /// The blur: a Gaussian of this standard deviation in the box; its opacity, and how far down it is moved, by page.
        static let blurRadius = 6.5
        static func blurOpacity(_ theme: AgentMark.Theme) -> Double { theme == .dark ? 0.7 : 0.32 }
        static func blurDrop(_ theme: AgentMark.Theme) -> Double { theme == .dark ? 0 : 7 }
        static let period = 3.6
    }

    /// The dot: its colours (idle a ring in its colour), and its size by the avatar's: diameter, how far past the box's
    /// bottom-right corner it sits, and the ring cut out round it.
    enum Dot {
        static let colors: [State: AgentMark.Forms] = [
            .working: .init(light: "#155dfc", dark: "#51a2ff"),
            .needs: .init(light: "#e17100", dark: "#ffba00"),
            .failed: .init(light: "#e7000b", dark: "#ff6467"),
            .idle: .init(light: "#a1a1a1", dark: "#737373"),
        ]
        static let idleRing: CGFloat = 1.5
        static let sizes: [(upTo: CGFloat, size: CGFloat, out: CGFloat, cut: CGFloat)] = [(16, 6, 2, 1.5), (28, 8, 2, 2), (40, 10, 1, 2), (1000, 13, -1, 3)]
        static func size(for avatar: CGFloat) -> (size: CGFloat, out: CGFloat, cut: CGFloat) {
            let found = sizes.first { avatar <= $0.upTo } ?? sizes[sizes.count - 1]
            return (found.size, found.out, found.cut)
        }
    }

    /// The Guardian's pearl, on a light page, sits on a graphite tile; on a dark one it glows on its own.
    static let pearlTile = AgentMark.Forms(light: "#171717", dark: "")
}

// MARK: - Who wears what

extension AgentGlass {
    /// A saved glass, read strictly (core's isGlassProfile): exactly v 4, a colour that is one of the eight (its light
    /// form) and a whole shape.
    static func read(_ profile: JSONValue?) -> AgentGlass? {
        guard case .object(let p)? = profile, p.count == 3, p["v"] == .number(4), case .string(let hex)? = p["color"], case .number(let n)? = p["shape"] else { return nil }
        guard let color = AgentMark.palette.firstIndex(where: { $0.forms.light == hex }), n.rounded() == n, n >= 0, n < Double(shapes.count) else { return nil }
        return AgentGlass(color: color, shape: Int(n))
    }

    /// A handle's own glass, before any is given: its seed's shape and colour (core's seeded).
    static func seeded(_ id: String) -> AgentGlass {
        let seed = AgentMark.seed(id)
        return AgentGlass(color: Int((seed >> 7) % UInt32(AgentMark.palette.count)), shape: Int(seed % UInt32(shapes.count)))
    }

    /// An agent's glass from what it has (core's glassOf): its own (v 4); a mark's colour (v 3) or a colour chosen before
    /// (v 2), snapped, with its handle's shape; else its handle's, an avatar of a version yet to come too.
    static func of(id: String, profile: JSONValue?) -> AgentGlass {
        if let own = read(profile) { return own }
        let handle = seeded(id)
        if let mark = AgentMark.read(profile) { return AgentGlass(color: mark.color, shape: handle.shape) }
        if let chosen = AgentMark.chosenColor(profile) { return AgentGlass(color: AgentMark.snap(chosen), shape: handle.shape) }
        return handle
    }

    /// The glass a node gives an agent as it joins, after `others` (core's assignGlass): among the shapes no agent wears,
    /// the one from the least-used family, tried in its seed's order (once all are worn, the least worn, then the
    /// least-used family); its colour the one you chose, snapped, else the least worn, tried from its seed's, never the
    /// same as either of the two before it. The editor previews a new agent's with it.
    static func assign(_ id: String, after others: [AgentGlass], chosen: String? = nil) -> AgentGlass {
        let seed = AgentMark.seed(id)
        let count = shapes.count
        let wear = (0..<count).map { n in others.filter { $0.shape == n }.count }
        func familyUse(_ family: String) -> Int { others.filter { $0.shape >= 0 && $0.shape < count && shapes[$0.shape].family == family }.count }
        let free = wear.contains(0)
        var shape = -1
        for i in 0..<count {
            let c = Int((UInt64(seed) + UInt64(i)) % UInt64(count))
            if free, wear[c] > 0 { continue }
            if shape < 0 || wear[c] < wear[shape] || (wear[c] == wear[shape] && familyUse(shapes[c].family) < familyUse(shapes[shape].family)) { shape = c }
        }
        let colors = AgentMark.palette.count
        var color: Int
        if let chosen, !chosen.isEmpty {
            color = AgentMark.snap(chosen)
        } else {
            let recent = others.suffix(2).map(\.color)
            let worn = (0..<colors).map { n in others.filter { $0.color == n }.count }
            color = -1
            for i in 0..<colors {
                let c = Int((UInt64(seed >> 7) + UInt64(i)) % UInt64(colors))
                if recent.contains(c) { continue }
                if color < 0 || worn[c] < worn[color] { color = c }
            }
        }
        return AgentGlass(color: color, shape: shape)
    }
}

// MARK: - Its path

extension AgentGlass {
    /// A shape's path (core's: absolute M, L, C, Q and Z) in its 100 × 100 box, scaled by `scale` and moved by `offset`.
    static func path(_ d: String, scale: CGFloat = 1, offset: CGPoint = .zero) -> CGPath {
        let path = CGMutablePath()
        var numbers: [CGFloat] = []
        var command: Character = " "
        func flush() {
            let p = { (i: Int) in CGPoint(x: numbers[i] * scale + offset.x, y: numbers[i + 1] * scale + offset.y) }
            switch command {
            case "M" where numbers.count >= 2: path.move(to: p(0))
            case "L" where numbers.count >= 2: path.addLine(to: p(0))
            case "C" where numbers.count >= 6: path.addCurve(to: p(4), control1: p(0), control2: p(2))
            case "Q" where numbers.count >= 4: path.addQuadCurve(to: p(2), control: p(0))
            case "Z": path.closeSubpath()
            default: break
            }
            numbers = []
        }
        var token = ""
        func endNumber() {
            if let n = Double(token) { numbers.append(CGFloat(n)) }
            token = ""
        }
        for ch in d {
            if "MLCQZ".contains(ch) {
                endNumber()
                flush()
                command = ch
            } else if ch == " " {
                endNumber()
            } else if ch == "-", !token.isEmpty {
                endNumber()
                token = "-"
            } else {
                token.append(ch)
            }
        }
        endNumber()
        flush()
        return path
    }
}
