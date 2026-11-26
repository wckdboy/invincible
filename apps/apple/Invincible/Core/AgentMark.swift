import CoreGraphics
import Foundation

/*
 * An agent's mark, the Grille (O2, 26 November 2026: shown five directions, the owner chose "2 · Grille"; core's
 * agent-mark.ts, held to it by the vectors' `marks`): a solid disc in the agent's own colour, cut into slats by two or
 * three slots at its own angle, the I-beam's bars through the orb. The primary (your agent) is the I-beam in one ink,
 * never a Grille. Its colour and its form are the node's to give, once, as the agent joins, and are saved as its avatar
 * ({v: 3, color, form}), so every device draws the same mark; an agent a node from before the marks sends is read from
 * what it has (a colour chosen for its orb, snapped to the eight, with its handle's form; else its handle's). Everything
 * here is data and pure geometry, the widgets' as well as the app's; AgentMarkView draws it.
 */

/// An agent's mark: its colour (an index into `AgentMark.palette`) and its form (0 to 11).
struct AgentMark: Equatable, Hashable, Sendable {
    var color: Int
    var form: Int
}

/// What a mark shows (core's MarkState): idle (solid and still); working (its slats slide, each in its own phase,
/// calmly); needs (it asks you: its top slat turns ink and beats); queued (pale); paused (grey); done (its slots close and
/// open once as it arrives, then still); failed (its bottom slat turns the shared red and drops loose: the shape carries
/// the state, never colour alone). Rows are always still, reduced motion stills everything, and nothing is drawn at rest.
enum MarkState: String, CaseIterable, Sendable {
    case idle, working, needs, queued, paused, done, failed

    /// The state an agent's mark shows for what it is seen doing (core's markState, of its avatarExpression).
    init(expression: String?) {
        switch expression {
        case "thinking", "working", "reading", "browsing", "checking": self = .working
        case "asking": self = .needs
        case "waiting": self = .queued
        case "resting": self = .paused
        case "pleased": self = .done
        case "concerned": self = .failed
        default: self = .idle
        }
    }
}

extension AgentMark {
    enum Theme: String, Sendable { case light, dark }

    /// A colour on each page: its light-page form and its dark-page form ("#rrggbb").
    struct Forms: Equatable, Sendable {
        let light: String
        let dark: String
        func on(_ theme: Theme) -> String { theme == .light ? light : dark }
    }

    /// The palette: eight hues (OKLCH 72 to 334 degrees; none between pink-red and red-orange, which are failure's red),
    /// each a light-page form at least 3:1 against the page and a dark-page form. A colour is saved as its light form.
    static let palette: [(name: String, forms: Forms)] = [
        ("Amber", Forms(light: "#c88200", dark: "#ffbc63")),
        ("Lime", Forms(light: "#699700", dark: "#b1ef4a")),
        ("Green", Forms(light: "#007745", dark: "#18c376")),
        ("Teal", Forms(light: "#04a19b", dark: "#34eee5")),
        ("Sky", Forms(light: "#0084ba", dark: "#3bb7f7")),
        ("Blue", Forms(light: "#3453d3", dark: "#5b81fe")),
        ("Violet", Forms(light: "#9a68da", dark: "#ccabff")),
        ("Magenta", Forms(light: "#a23493", dark: "#e26ace")),
    ]

    /// The page a mark is drawn on, the ink (what asks you turns), and the shared red (what failed).
    static let page = Forms(light: "#ffffff", dark: "#000000")
    static let ink = Forms(light: "#0a0a0b", dark: "#ffffff")
    static let red = Forms(light: "#c4141b", dark: "#ee2c36")
    /// Each hue while queued (pale), and every mark while paused (grey): mixed in OKLab once, in core, so no app mixes.
    static let queued: [Forms] = [
        Forms(light: "#ebcdaa", dark: "#634721"), Forms(light: "#c1d6a9", dark: "#425c17"), Forms(light: "#a5c8b1", dark: "#044a29"), Forms(light: "#b0d9d6", dark: "#0e5c58"),
        Forms(light: "#aacee5", dark: "#114560"), Forms(light: "#a7bdf2", dark: "#1e2e63"), Forms(light: "#d5c3f3", dark: "#4e4063"), Forms(light: "#deafd4", dark: "#57244e"),
    ]
    static let paused = Forms(light: "#8c8c8d", dark: "#484848")

    /// The forms: the slots' angle, one of six, and two or three slots: form n is `angles[n % 6]` with `slotCounts[n / 6]`.
    static let angles: [Double] = [-40, -27, -14, 14, 27, 40]
    static let slotCounts = [2, 3]
    static let forms = 12

    static func shape(_ form: Int) -> (slots: Int, angle: Double) {
        (slotCounts[(form / angles.count) % slotCounts.count], angles[form % angles.count])
    }

    /// Its motion's numbers, in seconds (core's MARK_TIMING).
    enum Timing {
        static let workCycle = 5.5
        static let needsBeat = 4.2
        static let doneSettle = 1.4
        static let failDrop = 0.6
    }

    /// The colours it is drawn in: its body, and its key slat (the top one in ink when it asks you, the bottom one red when
    /// it failed).
    static func colors(_ color: Int, state: MarkState, theme: Theme) -> (body: String, key: String) {
        let at = palette.indices.contains(color) ? color : 0
        let body = state == .queued ? queued[at].on(theme) : state == .paused ? paused.on(theme) : palette[at].forms.on(theme)
        return (body, state == .needs ? ink.on(theme) : state == .failed ? red.on(theme) : body)
    }
}

// MARK: - Whose mark: an agent's avatar, its handle, the node's giving

extension AgentMark {
    /// A whole number for a handle: FNV-1a over its UTF-16 code units (core's handleSeed), the same in every app.
    static func seed(_ id: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for unit in id.utf16 { hash = (hash ^ UInt32(unit)) &* 0x0100_0193 }
        return hash
    }

    /// The handle's own mark, before any is given: its seed's colour and form.
    static func seeded(_ id: String) -> AgentMark {
        let hash = seed(id)
        return AgentMark(color: Int(hash % UInt32(palette.count)), form: Int((hash >> 8) % UInt32(forms)))
    }

    /// A saved mark, read strictly (core's isMarkProfile): exactly v 3, a colour that is one of the eight (its light form,
    /// lowercase) and a whole form from 0 to 11; nil for anything else.
    static func read(_ profile: JSONValue?) -> AgentMark? {
        guard case .object(let p)? = profile, p.count == 3, p["v"] == .number(3),
              case .string(let color)? = p["color"], let at = palette.firstIndex(where: { $0.forms.light == color }),
              case .number(let form)? = p["form"], form.rounded(.towardZero) == form, form >= 0, form < Double(forms) else { return nil }
        return AgentMark(color: at, form: Int(form))
    }

    /// The colour chosen for an agent's orb before the marks (core's isOrbProfile: exactly `{ v: 2, color }`, six hex
    /// digits), lowercased; nil for anything else.
    static func chosenColor(_ profile: JSONValue?) -> String? {
        guard case .object(let p)? = profile, p.count == 2, p["v"] == .number(2), case .string(let color)? = p["color"], isHex(color) else { return nil }
        return color.lowercased()
    }

    /// A colour as six hex digits after a `#`.
    static func isHex(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return bytes.count == 7 && bytes[0] == UInt8(ascii: "#") && bytes.dropFirst().allSatisfy { hexDigit($0) != nil }
    }

    /// An agent's mark, from what it has (core's markOf): its own (v 3); a colour chosen for it before the marks (v 2),
    /// snapped, with its handle's form; else its handle's.
    static func of(id: String, profile: JSONValue?) -> AgentMark {
        if let own = read(profile) { return own }
        let handle = seeded(id)
        if let chosen = chosenColor(profile) { return AgentMark(color: snap(chosen), form: handle.form) }
        return handle
    }

    /// The mark a node gives an agent as it joins, after `others` (core's assignMark): its colour the one its handle's
    /// seed points to, or the next one free, so no two share a colour until all eight are taken (or the one you chose,
    /// snapped); its form the one its seed points to, or the next one no agent wears; once every form is worn, the next one
    /// no agent of its colour wears, so a ninth agent repeats a colour but never a form. Only which marks are worn counts,
    /// not their order, so the app can tell what a node will give.
    static func assign(_ id: String, after others: [AgentMark], chosen: String? = nil) -> AgentMark {
        let hash = seed(id)
        var color = Int(hash % UInt32(palette.count))
        if let chosen, !chosen.isEmpty {
            color = snap(chosen)
        } else {
            let taken = Set(others.map(\.color))
            if taken.count < palette.count { while taken.contains(color) { color = (color + 1) % palette.count } }
        }
        let anyWorn = Set(others.map(\.form))
        let worn = Set(others.filter { $0.color == color }.map(\.form))
        var form = Int((hash >> 8) % UInt32(forms))
        if anyWorn.count < forms {
            while anyWorn.contains(form) { form = (form + 1) % forms }
        } else if worn.count < forms {
            while worn.contains(form) { form = (form + 1) % forms }
        }
        return AgentMark(color: color, form: form)
    }
}

// MARK: - The snap: a colour you pick, to the nearest hue of the eight

extension AgentMark {
    /// sRGB's 256 levels in linear light (core's MARK_LINEAR): its transfer function's values written out, so no app raises
    /// to a power (pow differs between platforms in its last bits).
    static let linear: [Double] = [
        0, 0.0003035269835488375, 0.000607053967097675, 0.0009105809506465125, 0.00121410793419535, 0.0015176349177441874,
        0.001821161901293025, 0.0021246888848418626, 0.0024282158683907, 0.0027317428519395373, 0.003035269835488375, 0.003346535763899161,
        0.003676507324047436, 0.004024717018496307, 0.004391442037410293, 0.004776953480693729, 0.005181516702338386, 0.005605391624202723,
        0.006048833022857054, 0.006512090792594475, 0.006995410187265387, 0.007499032043226175, 0.008023192985384994, 0.008568125618069307,
        0.009134058702220787, 0.00972121732023785, 0.010329823029626936, 0.010960094006488246, 0.011612245179743885, 0.012286488356915872,
        0.012983032342173012, 0.013702083047289686, 0.014443843596092545, 0.01520851442291271, 0.01599629336550963, 0.016807375752887384,
        0.017641954488384078, 0.018500220128379697, 0.019382360956935723, 0.0202885630566524, 0.021219010376003555, 0.02217388479338738,
        0.02315336617811041, 0.024157632448504756, 0.02518685962736163, 0.026241221894849898, 0.027320891639074894, 0.028426039504420793,
        0.0295568344378088, 0.030713443732993635, 0.03189603307301153, 0.033104766570885055, 0.03433980680868217, 0.03560131487502034,
        0.03688945040110004, 0.0382043715953465, 0.03954623527673284, 0.04091519690685319, 0.042311410620809675, 0.043735029256973465,
        0.04518620438567554, 0.046665086336880095, 0.04817182422688942, 0.04970656598412723, 0.05126945837404324, 0.052860647023180246,
        0.05448027644244237, 0.05612849004960009, 0.05780543019106723, 0.0595112381629812, 0.06124605423161761, 0.06301001765316767,
        0.06480326669290577, 0.06662593864377289, 0.06847816984440017, 0.07036009569659588, 0.07227185068231748, 0.07421356838014963,
        0.07618538148130785, 0.07818742180518633, 0.08021982031446832, 0.0822827071298148, 0.08437621154414882, 0.08650046203654976,
        0.08865558628577294, 0.09084171118340768, 0.09305896284668745, 0.0953074666309647, 0.09758734714186246, 0.09989872824711389,
        0.10224173308810132, 0.10461648409110419, 0.10702310297826761, 0.10946171077829933, 0.1119324278369056, 0.11443537382697373,
        0.11697066775851084, 0.11953842798834562, 0.12213877222960187, 0.12477181756095049, 0.12743768043564743, 0.1301364766903643,
        0.13286832155381798, 0.13563332965520566, 0.13843161503245183, 0.14126329114027164, 0.14412847085805777, 0.14702726649759498,
        0.14995978981060856, 0.15292615199615017, 0.1559264637078274, 0.1589608350608804, 0.162029375639111, 0.1651321945016676,
        0.16826940018969075, 0.1714411007328226, 0.17464740365558504, 0.17788841598362912, 0.18116424424986022, 0.184474994500441,
        0.18782077230067787, 0.19120168274079138, 0.1946178304415758, 0.19806931955994886, 0.20155625379439707, 0.20507873639031693,
        0.20863687014525575, 0.21223075741405523, 0.21586050011389926, 0.2195261997292692, 0.2232279573168085, 0.22696587351009836,
        0.23074004852434915, 0.23455058216100522, 0.238397573812271, 0.24228112246555486, 0.24620132670783548, 0.25015828472995344,
        0.25415209433082675, 0.2581828529215958, 0.26225065752969623, 0.26635560480286247, 0.2704977910130658, 0.27467731206038465,
        0.2788942634768104, 0.2831487404299921, 0.2874408377269175, 0.29177064981753587, 0.2961382707983211, 0.3005437944157765,
        0.3049873140698863, 0.30946892281750854, 0.31398871337571754, 0.31854677812509186, 0.32314320911295075, 0.3277780980565422,
        0.33245153634617935, 0.33716361504833037, 0.3419144249086609, 0.3467040563550296, 0.35153259950043936, 0.3564001441459435,
        0.3613067797835095, 0.3662525955988395, 0.3712376804741491, 0.3762621229909065, 0.38132601143253014, 0.386429433787049,
        0.39157247774972326, 0.39675523072562685, 0.4019777798321958, 0.4072402119017367, 0.41254261348390375, 0.4178850708481375,
        0.4232676699860717, 0.4286904966139066, 0.43415363617474895, 0.4396571738409188, 0.44520119451622786, 0.45078578283822346,
        0.45641102318040466, 0.4620769996544071, 0.467783796112159, 0.47353149614800955, 0.4793201831008268, 0.4851499400560704,
        0.4910208498478356, 0.4969329950608704, 0.5028864580325687, 0.5088813208549338, 0.5149176653765214, 0.5209955732043543,
        0.5271151257058131, 0.5332764040105052, 0.5394794890121072, 0.5457244613701866, 0.5520114015120001, 0.5583403896342679,
        0.5647115057049292, 0.5711248294648731, 0.5775804404296506, 0.5840784178911641, 0.5906188409193369, 0.5972017883637634,
        0.6038273388553378, 0.6104955708078648, 0.6172065624196511, 0.6239603916750761, 0.6307571363461468, 0.6375968739940326,
        0.6444796819705821, 0.6514056374198242, 0.6583748172794485, 0.665387298282272, 0.6724431569576875, 0.6795424696330938,
        0.6866853124353135, 0.6938717612919899, 0.7011018919329731, 0.7083757798916868, 0.7156935005064807, 0.7230551289219693,
        0.7304607400903537, 0.7379104087727308, 0.7454042095403874, 0.7529422167760779, 0.7605245046752924, 0.768151147247507,
        0.7758222183174236, 0.7835377915261935, 0.7912979403326302, 0.799102738014409, 0.8069522576692516, 0.8148465722161012,
        0.8227857543962835, 0.8307698767746546, 0.83879901174074, 0.846873231509858, 0.8549926081242338, 0.8631572134541023,
        0.8713671191987972, 0.8796223968878317, 0.8879231178819663, 0.8962693533742664, 0.9046611743911496, 0.9130986517934192,
        0.9215818562772946, 0.9301108583754237, 0.938685728457888, 0.9473065367331999, 0.9559733532492861, 0.9646862478944651,
        0.9734452903984125, 0.9822505503331171, 0.9911020971138298, 1,
    ]

    /// Under this chroma a colour is a grey: it has no hue to snap by.
    static let grey = 0.02

    /// A cube root of [0, 1] by Newton's method (core's markCubeRoot): from 1, halved until its cube is within 8 times x,
    /// then a fixed 8 steps; + − × ÷ alone, so the same to the last bit in every app.
    static func cubeRoot(_ x: Double) -> Double {
        if x <= 0 { return 0 }
        var y = 1.0
        while y * y * y > 8 * x { y = y / 2 }
        for _ in 0..<8 { y = (2 * y + x / (y * y)) / 3 }
        return y
    }

    /// A colour ("#rrggbb") in OKLab (core's markLab): its lightness and its (a, b), each sum in core's order. Nil where it
    /// isn't six hex digits.
    static func lab(_ hex: String) -> (L: Double, a: Double, b: Double)? {
        levels(hex).map { lab(r: $0.r, g: $0.g, b: $0.b) }
    }

    /// A colour's three levels, 0 to 255, from "#rrggbb" (either case); nil where it isn't one.
    private static func levels(_ hex: String) -> (r: Int, g: Int, b: Int)? {
        let bytes = Array(hex.utf8)
        guard bytes.count == 7, bytes[0] == UInt8(ascii: "#") else { return nil }
        var levels = [Int]()
        for at in stride(from: 1, to: 7, by: 2) {
            guard let high = hexDigit(bytes[at]), let low = hexDigit(bytes[at + 1]) else { return nil }
            levels.append(high * 16 + low)
        }
        return (levels[0], levels[1], levels[2])
    }

    /// A colour of three levels, 0 to 255, in OKLab.
    static func lab(r red: Int, g green: Int, b blue: Int) -> (L: Double, a: Double, b: Double) {
        let r = linear[red], g = linear[green], b = linear[blue]
        let l = cubeRoot(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cubeRoot(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cubeRoot(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
        let A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
        let B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
        return (L, A, B)
    }

    private static func hexDigit(_ byte: UInt8) -> Int? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): Int(byte - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): Int(byte - UInt8(ascii: "a")) + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): Int(byte - UInt8(ascii: "A")) + 10
        default: nil
        }
    }

    /// Each hue's direction in (a, b), from its light form, and both its forms' lightness and chroma, for a tie.
    private static let hues: [(a: Double, b: Double, forms: [(L: Double, C: Double)])] = palette.map { hue in
        let own = AgentMark.lab(hue.forms.light)!
        let chroma = (own.a * own.a + own.b * own.b).squareRoot()
        let forms = [hue.forms.light, hue.forms.dark].map { form in
            let it = AgentMark.lab(form)!
            return (L: it.L, C: (it.a * it.a + it.b * it.b).squareRoot())
        }
        return (a: own.a / chroma, b: own.b / chroma, forms: forms)
    }

    /// Which of the eight a colour you pick snaps to (core's snapColor): the nearest hue (OKLCH's), its lightness and
    /// chroma only breaking a tie, so a pale mint is Teal's and red, which isn't among them, is Amber's; a grey, which has
    /// no hue, goes to the form nearest it in lightness. Reckoned with + − × ÷ and √ alone, in core's order, so every app
    /// comes to the same one. A colour that isn't six hex digits is the first.
    static func snap(_ hex: String) -> Int {
        guard let it = levels(hex) else { return 0 }
        return snap(r: it.r, g: it.g, b: it.b)
    }

    /// Which of the eight a colour of three levels, 0 to 255, snaps to.
    static func snap(r: Int, g: Int, b blue: Int) -> Int {
        let (L, a, b) = lab(r: r, g: g, b: blue)
        let chroma = (a * a + b * b).squareRoot()
        var best = 0
        if chroma < grey {
            var apart = Double.infinity
            for (n, hue) in hues.enumerated() {
                for form in hue.forms {
                    let d = abs(form.L - L)
                    if d < apart { (best, apart) = (n, d) }
                }
            }
            return best
        }
        // The nearest direction is the one (a, b) lies most along; on a tie, the hue whose form is nearer in lightness, then in chroma.
        var along = -Double.infinity, nearL = Double.infinity, nearC = Double.infinity
        for (n, hue) in hues.enumerated() {
            let at = a * hue.a + b * hue.b
            let dL = min(abs(hue.forms[0].L - L), abs(hue.forms[1].L - L))
            let dC = min(abs(hue.forms[0].C - chroma), abs(hue.forms[1].C - chroma))
            if at > along || (at == along && (dL < nearL || (dL == nearL && dC < nearC))) { (best, along, nearL, nearC) = (n, at, dL, dC) }
        }
        return best
    }
}

// MARK: - Its geometry

extension AgentMark {
    /// A slat, in a 100-unit box, about the box's middle and turned by the mark's angle (core's MarkSlat): it lies across
    /// the disc from `from` to `to` (along the slots' normal, downward before turning), as a band of the disc between those
    /// lines; slid `slide` along its slot; filled as the body or the key; and, knocked loose, moved down `drop` units on the
    /// page and turned `turn` degrees about `pivot`, the turn applied first.
    struct Slat: Equatable, Sendable {
        var from: Double
        var to: Double
        var slide: Double
        var key: Bool
        var drop: Double
        var turn: Double
        var pivot: CGPoint
    }

    struct Geometry: Equatable, Sendable {
        /// The slots' angle, degrees, clockwise.
        var angle: Double
        /// The disc's radius, in units of the 100-unit box.
        var radius: Double
        var slats: [Slat]
    }

    /// Its slats as they stand (core's markGeometry): `size` the mark's square in points (a slot is 7.5 units, or 1.35 pt
    /// where that is wider); `t` seconds on the page's clock (nil: still, as every row and reduced motion draw it); `since`
    /// seconds since it came to its state (nil: long ago, settled); `seed` its handle's, which sets its slats' phase. Every
    /// sine and cosine is markSin's and markCos's, so it stands to the last bit where core's does.
    static func geometry(_ mark: AgentMark, seed: UInt32, state: MarkState, size: Double, t: Double?, since: Double?) -> Geometry {
        let (slots, angle) = shape(mark.form)
        let radius = 44.0
        let tau = Double.pi * 2
        var gap = max(7.5, (1.35 * 100) / size)
        if state == .done { gap *= 1 - 0.85 * (since.map { $0 < Timing.doneSettle ? markSin(Double.pi * ($0 / Timing.doneSettle)) : 0 } ?? 0) }
        let n = slots + 1
        let width = (2 * radius - Double(slots) * gap) / Double(n)
        let turned = (angle * Double.pi) / 180
        var slats = [Slat]()
        for i in 0..<n {
            let from = -radius + Double(i) * (width + gap)
            let to = from + width
            let key = state == .needs ? i == 0 : state == .failed ? i == n - 1 : false
            var slide = 0.0
            if state == .working, let t { slide = 6 * markSin(tau * (t / Timing.workCycle) + (Double(i) * tau) / Double(n) + Double(seed % 7)) }
            if key && state == .needs { slide = t.map { 3 + 4 * (0.5 - 0.5 * markCos((tau * $0) / Timing.needsBeat)) } ?? 5 }
            var drop = 0.0, turn = 0.0
            let middle = (from + to) / 2
            let pivot = CGPoint(x: 50 - middle * markSin(turned), y: 50 + middle * markCos(turned))
            if key && state == .failed {
                let k = since.map { since in
                    let left = 1 - min(1, max(0, since / Timing.failDrop))
                    return 1 - left * left * left
                } ?? 1
                drop = 8 * k
                turn = 10 * k
            }
            slats.append(Slat(from: from, to: to, slide: slide, key: key, drop: drop, turn: turn, pivot: pivot))
        }
        return Geometry(angle: angle, radius: radius, slats: slats)
    }

    /// Its slats as shapes in a square `side` points wide (its top left at the origin, y down), each with whether it is the
    /// key's: the band of the disc between its lines, slid along its slot, turned to the mark's angle about the box's
    /// middle, and knocked loose where it is (core's order: the turn about its pivot first, then the drop).
    static func paths(_ geometry: Geometry, side: CGFloat) -> [(path: CGPath, key: Bool)] {
        let unit = side / 100
        let turned = rotation((geometry.angle * Double.pi) / 180)
        return geometry.slats.map { slat in
            var place = CGAffineTransform(scaleX: unit, y: unit)
            if slat.drop != 0 || slat.turn != 0 {
                place = place.translatedBy(x: 0, y: slat.drop).translatedBy(x: slat.pivot.x, y: slat.pivot.y)
                place = rotation((slat.turn * Double.pi) / 180).concatenating(place).translatedBy(x: -slat.pivot.x, y: -slat.pivot.y)
            }
            place = turned.concatenating(place.translatedBy(x: 50, y: 50)).translatedBy(x: slat.slide, y: 0)
            return (band(geometry.radius, slat.from, slat.to).copy(using: &place) ?? CGMutablePath(), slat.key)
        }
    }

    /// A turn of `radians`, clockwise on a page whose y is down, from markSin and markCos.
    private static func rotation(_ radians: Double) -> CGAffineTransform {
        let (s, c) = (markSin(radians), markCos(radians))
        return CGAffineTransform(a: c, b: s, c: -s, d: c, tx: 0, ty: 0)
    }

    /// A band of a disc of radius `r` about the origin, between the lines u = a and u = b (u down, across the slots): its
    /// arcs drawn from where the circle's tangents at their ends meet, so it takes no angle.
    private static func band(_ r: Double, _ a: Double, _ b: Double) -> CGMutablePath {
        let ha = max(0, r * r - a * a).squareRoot(), hb = max(0, r * r - b * b).squareRoot()
        let (topRight, bottomRight) = (CGPoint(x: ha, y: a), CGPoint(x: hb, y: b))
        let (bottomLeft, topLeft) = (CGPoint(x: -hb, y: b), CGPoint(x: -ha, y: a))
        let path = CGMutablePath()
        path.move(to: topLeft)
        path.addLine(to: topRight)
        path.addArc(tangent1End: corner(r, topRight, bottomRight), tangent2End: bottomRight, radius: r)
        path.addLine(to: bottomLeft)
        path.addArc(tangent1End: corner(r, bottomLeft, topLeft), tangent2End: topLeft, radius: r)
        path.closeSubpath()
        return path
    }

    /// Where the tangents of a circle of radius `r` about the origin at two of its points meet (a slat's arc is under a
    /// quarter turn, so they always do).
    private static func corner(_ r: Double, _ p: CGPoint, _ q: CGPoint) -> CGPoint {
        let k = (r * r) / (r * r + p.x * q.x + p.y * q.y)
        return CGPoint(x: (p.x + q.x) * k, y: (p.y + q.y) * k)
    }
}

// MARK: - Its arithmetic: the same to the last bit everywhere

extension AgentMark {
    /*
     * A mark's sines and cosines come from + − × ÷ and floor alone, in core's fixed order (markSin and markCos), never from
     * the platform's sin, cos or pow, whose last bit is each platform's own (CI's Linux runner read a frame of the vectors
     * one bit off the Mac's, 26 November 2026). An angle is taken to its nearest quarter turn, q, and what is left, r; then
     * Taylor's series to the 13th power for sine and the 14th for cosine, in Horner's form. Each step is correctly rounded
     * in Swift as in TypeScript and Kotlin, and none is fused (a * b + c is two roundings here, as there).
     */
    private static let quarter = Double.pi / 2
    private static let s3 = -1.0 / 6, s5 = 1.0 / 120, s7 = -1.0 / 5040, s9 = 1.0 / 362880, s11 = -1.0 / 39916800, s13 = 1.0 / 6227020800
    private static let c2 = -1.0 / 2, c4 = 1.0 / 24, c6 = -1.0 / 720, c8 = 1.0 / 40320, c10 = -1.0 / 3628800, c12 = 1.0 / 479001600, c14 = -1.0 / 87178291200

    private static func quarterOf(_ x: Double) -> (q: Double, r: Double) {
        let q = (x / quarter + 0.5).rounded(.down)
        return (q, x - q * quarter)
    }

    private static func sinNear(_ r: Double) -> Double {
        let r2 = r * r
        let series = s3 + r2 * (s5 + r2 * (s7 + r2 * (s9 + r2 * (s11 + r2 * s13))))
        return r + r * r2 * series
    }

    private static func cosNear(_ r: Double) -> Double {
        let r2 = r * r
        let series = c2 + r2 * (c4 + r2 * (c6 + r2 * (c8 + r2 * (c10 + r2 * (c12 + r2 * c14)))))
        return 1 + r2 * series
    }

    /// Which quarter turn, 0 to 3, of a whole number of them.
    private static func turnOf(_ q: Double) -> Double { q - 4 * (q / 4).rounded(.down) }

    /// The sine of `x` radians (core's markSin), the same to the last bit on every platform.
    static func markSin(_ x: Double) -> Double {
        let (q, r) = quarterOf(x)
        let m = turnOf(q)
        return m == 0 ? sinNear(r) : m == 1 ? cosNear(r) : m == 2 ? -sinNear(r) : -cosNear(r)
    }

    /// The cosine of `x` radians (core's markCos), the same to the last bit on every platform.
    static func markCos(_ x: Double) -> Double {
        let (q, r) = quarterOf(x)
        let m = turnOf(q)
        return m == 0 ? cosNear(r) : m == 1 ? -sinNear(r) : m == 2 ? -cosNear(r) : sinNear(r)
    }
}
