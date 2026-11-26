import Foundation

/*
 * Model calls and what they cost at your prices (core's spend.ts): a task's record counts its calls by role and model,
 * as the providers reported them; your prices turn the counted tokens into money, and a call that reported nothing, or a
 * model with no price, makes the sum a lower bound. Pure.
 */

/// The calls one model made in one role (core's UsageLine): `unknown` of them reported no usage, and the counts leave
/// them out.
struct UsageLine: Codable, Equatable, Hashable, Sendable {
    let role: String
    let model: String
    let calls: Int
    let unknown: Int
    let input: Int
    let output: Int
    let cached: Int
    let reasoning: Int
}

/// Your price for a model, in US dollars per million tokens (cached input at the input price where it has none of its own).
struct Price: Codable, Equatable, Hashable, Sendable {
    let input: Double
    let output: Double
    var cached: Double? = nil
}

enum Spend {
    typealias Prices = [String: Price]

    struct Total: Equatable, Sendable {
        let calls: Int
        let unknown: Int
        let input: Int
        let output: Int
        let cached: Int
        let reasoning: Int
        var tokens: Int { input + output }
        /// No call reported nothing: the counts are the whole of it.
        var complete: Bool { unknown == 0 }
    }

    static func total(_ lines: [UsageLine]) -> Total {
        Total(
            calls: lines.reduce(0) { $0 + $1.calls }, unknown: lines.reduce(0) { $0 + $1.unknown }, input: lines.reduce(0) { $0 + $1.input },
            output: lines.reduce(0) { $0 + $1.output }, cached: lines.reduce(0) { $0 + $1.cached }, reasoning: lines.reduce(0) { $0 + $1.reasoning }
        )
    }

    /// The price that applies to a model: its own, else its provider's (`<provider>/*`), else none.
    static func price(_ prices: Prices, _ model: String) -> Price? {
        if let own = prices[model] { return own }
        guard let slash = model.firstIndex(of: "/"), slash > model.startIndex else { return nil }
        return prices["\(model[..<slash])/*"]
    }

    /// Your prices as money goes: a coding plan's calls are paid for already, so every model of one of `plans` (their
    /// provider ids) costs nothing more (core's moneyPrices).
    static func money(_ prices: Prices, plans: [String]) -> Prices {
        let free = Price(input: 0, output: 0, cached: 0)
        var out: Prices = [:]
        for (ref, price) in prices {
            let provider = ref.firstIndex(of: "/").flatMap { $0 > ref.startIndex ? String(ref[..<$0]) : nil }
            out[ref] = provider.map(plans.contains) == true ? free : price
        }
        for plan in plans { out["\(plan)/*"] = free }
        return out
    }

    /// What these calls cost at your prices: money only where a price is known; the models with counted calls and no
    /// price; and whether it is the whole of it.
    struct Cost: Equatable, Sendable {
        let usd: Double
        let unpriced: [String]
        let complete: Bool
    }

    static func cost(_ lines: [UsageLine], _ prices: Prices) -> Cost {
        var usd = 0.0
        var unknown = 0
        var unpriced = Set<String>()
        for l in lines {
            unknown += l.unknown
            if l.calls == l.unknown { continue }
            guard let p = price(prices, l.model) else {
                unpriced.insert(l.model)
                continue
            }
            usd += (Double(l.input - l.cached) * p.input + Double(l.cached) * (p.cached ?? p.input) + Double(l.output) * p.output) / 1e6
        }
        return Cost(usd: usd, unpriced: unpriced.sorted(), complete: unknown == 0 && unpriced.isEmpty)
    }

    /// Money in a word: "$0", "$0.0042", "$0.31", "$12.5", "$140" (core's usdLabel).
    static func usd(_ usd: Double) -> String {
        if usd == 0 { return "$0" }
        if usd < 0.01 { return "$\(fixed(usd, 4))" }
        if usd < 10 { return "$\(fixed(usd, 2))" }
        return "$\(fixed(usd, usd < 100 ? 1 : 0))"
    }

    /// JavaScript's toFixed for 0 ≤ x < 10^15: x's exact value to `digits` places, a half going up. printf rounds its exact
    /// value too, but an exact half to even (0.125 to "0.12" where the web says "0.13"): those, and only those, go up here.
    static func fixed(_ x: Double, _ digits: Int) -> String {
        let printed = String(format: "%.\(digits)f", x)
        guard x.isFinite, x > 0, x < 1e15, isHalf(x, digits) else { return printed }
        // A whole number and a half exactly, times 10^digits: the whole number above it, as digits with a point.
        let up = Int((x * pow(10, Double(digits))).rounded(.up))
        var text = String(up)
        guard digits > 0 else { return text }
        if text.count <= digits { text = String(repeating: "0", count: digits - text.count + 1) + text }
        text.insert(".", at: text.index(text.endIndex, offsetBy: -digits))
        return text
    }

    /// Whether x is exactly half way between two numbers of `digits` places: x = M·2^e with M odd, and x·2·10^d =
    /// M·5^d·2^(e+1+d) is an odd whole number, which it is when e = -(d + 1).
    private static func isHalf(_ x: Double, _ digits: Int) -> Bool {
        guard x.isNormal else { return false }
        var m = x.significandBitPattern | (1 << 52)
        var e = Int(x.exponent) - 52
        let zeros = m.trailingZeroBitCount
        m >>= UInt64(zeros)
        e += zeros
        return e == -(digits + 1)
    }
}
