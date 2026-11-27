import Foundation

/// A loop's task, and what wakes it, in words, as the PWA's lib/loops.ts (describeTask) and lib/wakes.ts
/// (describeWakes) say them, held to them by the vectors' `loops`: a loop it drafted says them in Needs you.
enum Loops {
    /// As much of a text as a line keeps, counted as a string's length is in JavaScript (UTF-16), and an ellipsis where
    /// it was cut.
    private static func clip(_ text: String, _ n: Int) -> String {
        let units = Array(text.utf16)
        return units.count > n ? String(decoding: units.prefix(n - 1), as: UTF16.self) + "…" : text
    }

    /// A JSON value as JavaScript's String() says it: a whole number without a point, an array its items joined by
    /// commas (null as nothing), an object "[object Object]".
    static func jsString(_ value: JSONValue) -> String {
        switch value {
        case .null: "null"
        case .bool(let bool): bool ? "true" : "false"
        case .number(let number): jsNumber(number)
        case .string(let string): string
        case .array(let array): array.map { $0 == .null ? "" : jsString($0) }.joined(separator: ",")
        case .object: "[object Object]"
        }
    }

    /// A number as JavaScript writes it (Number::toString): its shortest digits that read back as it, in figures from 1e-6
    /// up to 1e21 ("0.00001", "12345678901234567000": a whole number past 2^53 its shortest digits and zeros, never its
    /// exact value), in an exponent outside that ("1e-7", "1e+21").
    static func jsNumber(_ number: Double) -> String {
        if number.isNaN { return "NaN" }
        if number.isInfinite { return number > 0 ? "Infinity" : "-Infinity" }
        if number == 0 { return "0" }
        // JavaScript's k digits, and n: the number is 0.digits × 10^n.
        let (digits, n) = shortest(abs(number))
        let k = digits.count
        let sign = number < 0 ? "-" : ""
        if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return sign + digits.prefix(n) + "." + digits.dropFirst(n) }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
        let e = n - 1
        return sign + (k == 1 ? digits : String(digits.prefix(1)) + "." + digits.dropFirst(1)) + "e" + (e < 0 ? "-" : "+") + String(abs(e))
    }

    /// The shortest digits of a positive number that read back as it (Swift's description finds them, as JavaScript's
    /// does), with no zeros at either end, and n: the number is 0.digits × 10^n.
    private static func shortest(_ x: Double) -> (digits: String, n: Int) {
        let text = "\(x)"
        var mantissa = Substring(text)
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = text[..<e]
            exponent = Int(text[text.index(after: e)...]) ?? 0
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0])
        var digits = whole + (parts.count > 1 ? String(parts[1]) : "")
        var n = whole.count + exponent
        while digits.hasPrefix("0") {
            digits.removeFirst()
            n -= 1
        }
        while digits.hasSuffix("0") { digits.removeLast() }
        return (digits, n)
    }

    /// What a loop runs, in a sentence: a heartbeat, a run (its network, its goal, what proves it), a call (its tool and
    /// its arguments, by name), or a tell.
    static func describeTask(_ task: JSONValue?) -> String {
        guard let task, let kind = task["kind"]?.string else { return "A task this node can't read." }
        switch kind {
        case "heartbeat":
            let what = (task["checklist"]?.string ?? "").isEmpty ? "Heartbeat: checks the fleet and the machine it runs on." : "Heartbeat: checks the fleet, then reads your checklist."
            return what + (task["selfAction"]?.bool == false ? " Only reports: self-action is off." : " Then fixes what's safe itself.")
        case "run":
            let gates = task["gates"]?.array?.compactMap(\.string) ?? []
            let proves = gates.isEmpty ? "" : " Done means \(gates.count == 1 ? "this passes" : "these \(gates.count) pass"): \(clip(gates.joined(separator: " · "), 160))"
            return "Run, \(task["network"]?.string ?? ""): \(clip(task["goal"]?.string ?? "", 160))\(proves)"
        case "tell":
            let text = task["text"]?.string ?? ""
            return "Tells you\(text.isEmpty ? ", with what woke it" : ": \(clip(text, 160))"): a notice in Needs you, and your loop's name on your phone."
        default:
            let args = (task["args"]?.object ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\(jsString($0.value))" }.joined(separator: " ")
            return "Calls \(task["connector"]?.string ?? "").\(task["tool"]?.string ?? "")\(args.isEmpty ? "" : " \(clip(args, 120))")"
        }
    }

    private static let gitHubWords = ["ci.failed": "a failed CI run", "pushed": "a push", "issue.opened": "a new issue", "pr.opened": "a new pull request"]

    /// A wake in a few words (lib/wakes.ts describeWake).
    static func describeWake(_ wake: JSONValue) -> String {
        switch wake["kind"]?.string {
        case "webhook":
            return "a webhook"
        case "mail":
            let query = wake["query"]?.string ?? ""
            return "new \(wake["connector"]?.string == "gmail" ? "Gmail" : "Outlook") mail\(query.isEmpty ? "" : " matching \"\(query)\"")"
        case "github":
            let branch = wake["branch"]?.string ?? ""
            let what = (wake["on"]?.array?.compactMap(\.string) ?? []).map { on in on == "ci.failed" && !branch.isEmpty ? "a failed CI run on \(branch)" : gitHubWords[on] ?? on }
            return "\(what.joined(separator: " or ")) in \(wake["owner"]?.string ?? "")/\(wake["repo"]?.string ?? "")"
        default:
            return ""
        }
    }

    /// What else wakes it, and that a burst of them is one run (lib/wakes.ts describeWakes); "" for none.
    static func describeWakes(_ wakes: [JSONValue], cooldownMs: Double?) -> String {
        guard !wakes.isEmpty else { return "" }
        // (JavaScript's Math.round: half up.)
        let minutes = Int(((cooldownMs ?? 600_000) / 60_000 + 0.5).rounded(.down))
        return "Also wakes on \(wakes.map(describeWake).joined(separator: " · ")); a burst within \(minutes) min is one run."
    }
}
