import CoreGraphics
import Foundation

/*
 * What the Grille (O2, 26 November 2026; core's agent-mark.ts, held to it by the vectors' `marks`) leaves an agent's
 * glass (Glass.swift; the owner's word of 27 November 2026 that the Grille goes): the palette of eight hues the glass's
 * ramps are paired with, a handle's seed, a colour you pick snapped to the eight, a mark an app or a node from before the
 * glass saved ({v: 3, color, form}) and a colour chosen before the marks ({v: 2, color}), each read for its colour, and
 * the states an agent is shown in. Its forms, its motion and its geometry are gone. Data alone, the widgets' as well as
 * the app's.
 */

/// An agent's mark, as an app or a node from before the glass saved it: its colour (an index into `AgentMark.palette`)
/// and its form (0 to 11).
struct AgentMark: Equatable, Hashable, Sendable {
    var color: Int
    var form: Int
}

/// What an agent is shown doing (core's MarkState): idle, working, needs (it asks you), queued, paused, done and failed.
/// Its glass shows working, needs and failed by its dot, and the rest as idle, the word beside it saying which.
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

    /// The Grille's twelve forms (six angles, two or three slots): a saved mark's form is read only to know it is one.
    static let forms = 12
}

// MARK: - Whose colour: a handle's seed, and what an agent's avatar says

extension AgentMark {
    /// A whole number for a handle: FNV-1a over its UTF-16 code units (core's handleSeed), the same in every app.
    static func seed(_ id: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for unit in id.utf16 { hash = (hash ^ UInt32(unit)) &* 0x0100_0193 }
        return hash
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
