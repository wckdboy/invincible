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

    /// A number as JavaScript writes it: whole numbers below 1e21 in figures, the rest in its shortest form, an
    /// exponent without its leading zeros ("1e-7").
    static func jsNumber(_ number: Double) -> String {
        if number.isNaN { return "NaN" }
        if number.isInfinite { return number > 0 ? "Infinity" : "-Infinity" }
        if number == 0 { return "0" }
        if number == number.rounded(), abs(number) < 1e21 { return String(format: "%.0f", number) }
        let text = "\(number)"
        guard let e = text.firstIndex(of: "e") else { return text }
        let mantissa = text[..<e]
        var exponent = String(text[text.index(after: e)...])
        let sign = exponent.hasPrefix("-") ? "-" : "+"
        exponent = String(exponent.drop { $0 == "-" || $0 == "+" || $0 == "0" })
        return "\(mantissa)e\(sign)\(exponent.isEmpty ? "0" : exponent)"
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
            return "Tells you\(text.isEmpty ? ", with what woke it" : ": \(clip(text, 160))"): a notice in your Inbox, and your loop's name on your phone."
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
