import Foundation

/**
 * What an answer may show beyond words: a fenced block whose language names it (core's `blocks.ts`). The app draws
 * each as a live element: a chart, figures, choices to tap, a plan's steps, a page. What a model writes is untrusted, so
 * every field is checked and every size capped, and a block the reader won't take is shown as the code it is, with why,
 * in core's own words. The tests hold each reader to core's output (scripts/vectors.ts).
 */
enum Blocks {
    enum Kind: String, CaseIterable, Sendable { case chart, stats, choices, steps, artifact }

    enum Read<T: Sendable & Equatable>: Sendable, Equatable {
        case ok(T)
        case no(String)
    }

    struct Chart: Sendable, Equatable {
        enum Shape: String, Sendable, CaseIterable { case line, area, bar, stacked }
        struct Series: Sendable, Equatable {
            let name: String
            /// nil leaves a gap.
            let values: [Double?]
        }

        let type: Shape
        let title: String?
        let unit: String?
        let labels: [String]
        let series: [Series]
    }

    struct Stat: Sendable, Equatable {
        enum Value: Sendable, Equatable {
            case number(Double)
            case text(String)
        }

        let label: String
        let value: Value
        let unit: String?
        /// The change against `note`'s period, signed.
        let delta: Double?
        let note: String?
        /// Which way is good: up, down, or neither.
        let good: String?
    }

    struct Step: Sendable, Equatable {
        enum State: String, Sendable, CaseIterable { case done, doing, todo, failed, skipped }
        let text: String
        let state: State
    }

    /// Sizes past which a block isn't drawn: a chart of more is a table, and a page bigger than this is no answer.
    enum Limit {
        static let labels = 60, series = 6, title = 80, name = 32, unit = 12, stats = 6, statLabel = 40, statValue = 24, note = 60, choices = 6, choice = 80, steps = 20, step = 120, artifactChars = 200_000
    }

    // MARK: - Readers

    /// A chart: numbers over time (line, area) or across categories (bar, stacked). One axis, at most six series.
    static func chart(_ text: String) -> Read<Chart> {
        guard let parsed = json(text) else { return .no("it isn't valid JSON") }
        guard case .object(let c) = parsed else { return .no("a chart is an object with type, labels and series") }
        let named: JSONValue = c["type"].flatMap { $0 == .null ? nil : $0 } ?? .string("line")
        guard case .string(let typeName) = named, let type = Chart.Shape(rawValue: typeName) else {
            return .no("its type is one of \(Chart.Shape.allCases.map(\.rawValue).joined(separator: ", "))")
        }
        guard case .array(let rawLabels) = c["labels"], !rawLabels.isEmpty else { return .no("it needs labels: what each value is for (a month, a name)") }
        if rawLabels.count > Limit.labels { return .no("at most \(Limit.labels) labels: more is a table") }
        let labels = rawLabels.map { line($0, Limit.name) ?? "" }
        guard case .array(let rawSeries) = c["series"], !rawSeries.isEmpty else { return .no("it needs a series of values") }
        if rawSeries.count > Limit.series { return .no("at most \(Limit.series) series: fold the rest into one called Other") }
        var series: [Chart.Series] = []
        for (i, s) in rawSeries.enumerated() {
            guard case .object(let s) = s, case .array(let raw) = s["values"] else { return .no("series \(i + 1) needs values") }
            if raw.count != labels.count { return .no("series \(i + 1) has \(raw.count) values for \(labels.count) labels") }
            let values: [Double?] = raw.map { if case .number(let n) = $0, n.isFinite { n } else { nil } }
            if zip(raw, values).contains(where: { $0 != .null && $1 == nil }) { return .no("series \(i + 1) has a value that isn't a number (null leaves a gap)") }
            if type == .stacked, values.contains(where: { ($0 ?? 0) < 0 }) { return .no("a stacked chart's values are parts of a whole: none below zero") }
            let name = line(s["name"], Limit.name) ?? (rawSeries.count == 1 ? (line(c["title"], Limit.name) ?? "Value") : "Series \(i + 1)")
            if series.contains(where: { $0.name.lowercased() == name.lowercased() }) { return .no("two series are called \(name)") }
            series.append(Chart.Series(name: name, values: values))
        }
        if !series.contains(where: { $0.values.contains { $0 != nil } }) { return .no("it has no values") }
        return .ok(Chart(type: type, title: line(c["title"], Limit.title), unit: line(c["unit"], Limit.unit), labels: labels, series: series))
    }

    /// A few headline figures, each with what it is, and maybe how it changed and whether that's good.
    static func stats(_ text: String) -> Read<[Stat]> {
        guard let parsed = json(text) else { return .no("it isn't valid JSON") }
        var list = parsed
        if case .object(let o) = parsed, case .array(let inner)? = o["stats"] { list = .array(inner) }
        guard case .array(let items) = list, !items.isEmpty else { return .no("figures are a list of {label, value}") }
        if items.count > Limit.stats { return .no("at most \(Limit.stats) figures") }
        var stats: [Stat] = []
        for (i, s) in items.enumerated() {
            guard case .object(let s) = s else { return .no("figure \(i + 1) is an object with a label and a value") }
            let label = line(s["label"], Limit.statLabel)
            let value: Stat.Value? = if case .number(let n)? = s["value"], n.isFinite { .number(n) } else { line(s["value"], Limit.statValue).map { .text($0) } }
            guard let label, let value else { return .no("figure \(i + 1) needs a label and a value") }
            let delta: Double? = if case .number(let n)? = s["delta"], n.isFinite { n } else { nil }
            let good: String? = if case .string(let g)? = s["good"], g == "up" || g == "down" { g } else { nil }
            stats.append(Stat(label: label, value: value, unit: line(s["unit"], Limit.unit), delta: delta, note: line(s["note"], Limit.note), good: good))
        }
        return .ok(stats)
    }

    /// Answers to tap: each one, tapped, is sent as your reply.
    static func choices(_ text: String) -> Read<[String]> {
        guard let parsed = json(text) else { return .no("it isn't valid JSON") }
        var list = parsed
        if case .object(let o) = parsed, case .array(let inner)? = o["options"] { list = .array(inner) }
        guard case .array(let items) = list else { return .no("choices are a list of short answers") }
        var choices: [String] = []
        for item in items {
            if let choice = line(item, Limit.choice), !choices.contains(where: { $0.lowercased() == choice.lowercased() }) { choices.append(choice) }
        }
        if choices.count < 2 { return .no("at least two choices") }
        if choices.count > Limit.choices { return .no("at most \(Limit.choices) choices") }
        return .ok(choices)
    }

    /// A plan's steps and where each stands. A bare line is a step still to do.
    static func steps(_ text: String) -> Read<[Step]> {
        guard let parsed = json(text) else { return .no("it isn't valid JSON") }
        var list = parsed
        if case .object(let o) = parsed, case .array(let inner)? = o["steps"] { list = .array(inner) }
        guard case .array(let items) = list, !items.isEmpty else { return .no("steps are a list of {text, state}") }
        if items.count > Limit.steps { return .no("at most \(Limit.steps) steps") }
        var steps: [Step] = []
        for (i, s) in items.enumerated() {
            let object: [String: JSONValue]? = if case .object(let o) = s { o } else { nil }
            guard let text = line(object.map { $0["text"] ?? .null } ?? s, Limit.step) else { return .no("step \(i + 1) needs its text") }
            let state: Step.State = if case .string(let name)? = object?["state"], let known = Step.State(rawValue: name) { known } else { .todo }
            steps.append(Step(text: text, state: state))
        }
        return .ok(steps)
    }

    /// A whole page: HTML with its own CSS (and scripts, which run only when you say so).
    static func artifact(_ text: String) -> Read<String> {
        let page = Markdown.trim(text)
        if !page.contains("<") { return .no("a page is HTML") }
        if page.utf16.count > Limit.artifactChars { return .no("a page is at most \(Limit.artifactChars / 1000)K characters") }
        return .ok(page)
    }

    /// The page's own <title>, as plain text, for its card.
    static func artifactTitle(_ page: String) -> String? {
        let ns = page as NSString
        guard let found = titlePattern.firstMatch(in: page, range: NSRange(location: 0, length: ns.length)), found.range(at: 1).location != NSNotFound else { return nil }
        let raw = ns.substring(with: found.range(at: 1))
            .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'")
        return line(.string(raw), Limit.title)
    }

    private static let titlePattern = try! NSRegularExpression(pattern: "<title[^>]*>([^<]{1,200})</title>", options: [.caseInsensitive])

    // MARK: - Numbers as people read them

    /// A figure as people read it: 1,284 under ten thousand; 12.9K, 4.2M above (core's compactNumber).
    static func compactNumber(_ n: Double) -> String {
        let abs = Swift.abs(n)
        if abs < 10_000 { return format(n, digits: abs < 10 ? 2 : abs < 100 ? 1 : 0) }
        let units: [(Double, String)] = [(1e3, "K"), (1e6, "M"), (1e9, "B"), (1e12, "T")]
        var at = units.lastIndex { abs >= $0.0 } ?? 0
        func shown(_ i: Int) -> (text: String, rounded: Double) {
            let scaled = n / units[i].0
            let digits = Swift.abs(scaled) < 100 ? 1 : 0
            let factor = digits == 1 ? 10.0 : 1.0
            return (format(scaled, digits: digits), Swift.abs((scaled * factor).rounded(.toNearestOrAwayFromZero) / factor))
        }
        // 999,999 rounds to 1,000K: that's 1M.
        if shown(at).rounded >= 1000, at < units.count - 1 { at += 1 }
        return shown(at).text + units[at].1
    }

    /// A unit of one sign sits on its number (12%); a word stands apart (3,400 DKK).
    static func withUnit(_ text: String, _ unit: String?) -> String {
        guard let unit else { return text }
        return ["%", "°", "‰"].contains(unit) ? "\(text)\(unit)" : "\(text) \(unit)"
    }

    private static func format(_ n: Double, digits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = digits
        formatter.minimumFractionDigits = 0
        // Half away from zero, as JavaScript's toLocaleString rounds.
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSNumber(value: n)) ?? String(n)
    }

    // MARK: - JSON, as JavaScript reads it

    private static func json(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// One line of text, its whitespace folded, cut to `max` characters with an ellipsis. Nil when there's none.
    private static func line(_ value: JSONValue?, _ max: Int) -> String? {
        var text: String
        switch value {
        case .string(let s)?: text = s
        case .number(let n)? where n.isFinite: text = n.rounded() == n && Swift.abs(n) < 1e15 ? String(Int64(n)) : String(n)
        default: return nil
        }
        // Control characters, then every run of whitespace, become one space.
        text = text.replacingOccurrences(of: "[\\u0000-\\u001f\\u007f]+", with: " ", options: .regularExpression)
        text = Markdown.trim(text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression))
        if text.isEmpty { return nil }
        let units = Array(text.utf16)
        guard units.count > max else { return text }
        let cut = String(decoding: units.prefix(max - 1), as: UTF16.self)
        return cut.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "…"
    }
}
