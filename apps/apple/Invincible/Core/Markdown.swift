import Foundation

/**
 * Markdown-lite, as the PWA reads it (`apps/web/src/lib/markdown.ts`), into the same small tree: paragraphs (a single
 * newline is a line break), # headings, fenced code (an unclosed fence while an answer streams is still code), bullet
 * and numbered lists nested by indentation, > quotes, --- rules, GFM tables, `code`, **bold**, *italic*, ~~strike~~,
 * [links](https://…) and bare URLs. Only http(s) links ever become links; anything else, raw HTML too, stays text.
 *
 * It reads the text as the PWA's JavaScript does, in UTF-16 code units with the same patterns, so the two read every
 * answer alike; the tests hold it to the PWA's own output (scripts/vectors.ts).
 */
enum Markdown {
    indirect enum Inline: Equatable, Sendable {
        case text(String)
        case code(String)
        case strong([Inline])
        case em([Inline])
        case del([Inline])
        case link(href: String, [Inline])
        case br
    }

    enum Align: String, Sendable { case left, center, right }

    indirect enum Block: Equatable, Sendable {
        case p([Inline])
        case h(level: Int, [Inline])
        case code(lang: String, text: String, open: Bool)
        case list(ordered: Bool, start: Int, items: [[Block]])
        case quote([Block])
        case hr
        case table(align: [Align?], head: [[Inline]], rows: [[[Inline]]])
    }

    private static let maxDepth = 6

    // The PWA's patterns, with JavaScript's ASCII \w and \d written out.
    /// A fence: its run, its language, and whatever else its line says (never a backtick: that's inline code). No two
    /// parts can match the same spaces, so a line is read in linear time, whatever a model writes on it.
    private static let fence = pattern(#"^ {0,3}(`{3,}|~{3,})\s*(?:([A-Za-z0-9_+#.-]+)(?:\s+([^`\s](?:[^`]*[^`\s])?))?\s*)?$"#)
    private static let heading = pattern(#"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#)
    private static let rule = pattern(#"^ {0,3}([-*_])(\s*\1){2,}\s*$"#)
    private static let bullet = pattern(#"^(\s*)([-*+])\s+(.*)$"#)
    private static let ordered = pattern(#"^(\s*)([0-9]{1,9})[.)]\s+(.*)$"#)
    private static let quote = pattern(#"^ {0,3}>\s?(.*)$"#)
    private static let tableRule = pattern(#"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$"#)
    private static let closingFence = pattern(#"^\s*[`~]+\s*$"#)
    private static let link = pattern(#"^\[([^\]\n]{1,500})\]\(\s*([^()\s]{1,2000})\s*\)"#)
    private static let bareURL = pattern(#"^https?://[^\s<>"'`]+"#, caseInsensitive: true)

    // MARK: - Blocks

    static func parse(_ source: String, depth: Int = 0) -> [Block] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var i = 0
        let at = { (index: Int) -> String? in index < lines.count ? lines[index] : nil }
        func startsBlock(_ line: String, _ next: String?) -> Bool {
            matches(fence, line) || matches(heading, line) || matches(rule, line) || matches(quote, line) || matches(bullet, line) || matches(ordered, line) || isTableStart(line, next)
        }

        while i < lines.count {
            let line = lines[i]
            if trim(line).isEmpty {
                i += 1
                continue
            }

            if let found = match(fence, line) {
                let marker = found[1]
                let closer = String(repeating: String(marker.prefix(1)), count: marker.utf16.count)
                var body: [String] = []
                var open = true
                i += 1
                while i < lines.count {
                    let l = lines[i]
                    if trim(l).hasPrefix(closer), matches(closingFence, l) {
                        open = false
                        i += 1
                        break
                    }
                    body.append(l)
                    i += 1
                }
                // An answer block written on one line (```choices ["a","b"]) has its JSON on the fence line and nothing inside.
                let text = body.joined(separator: "\n"), said = found[3]
                blocks.append(.code(lang: found[2], text: trim(text).isEmpty && !said.isEmpty && Blocks.Kind(rawValue: found[2].lowercased()) != nil ? said : text, open: open))
                continue
            }

            if let found = match(heading, line) {
                blocks.append(.h(level: found[1].utf16.count, inline(found[2])))
                i += 1
                continue
            }

            if matches(rule, line) {
                blocks.append(.hr)
                i += 1
                continue
            }

            if matches(quote, line) {
                var body: [String] = []
                while i < lines.count, !trim(lines[i]).isEmpty, let found = match(quote, lines[i]) {
                    body.append(found[1])
                    i += 1
                }
                let text = body.joined(separator: "\n")
                blocks.append(depth < maxDepth ? .quote(parse(text, depth: depth + 1)) : .p([.text(text)]))
                continue
            }

            if isTableStart(line, at(i + 1)) {
                let head = splitRow(line)
                let align = splitRow(lines[i + 1]).map(alignment)
                i += 2
                var rows: [[[Inline]]] = []
                while i < lines.count, lines[i].contains("|"), !trim(lines[i]).isEmpty {
                    let cells = splitRow(lines[i])
                    i += 1
                    rows.append(head.indices.map { inline($0 < cells.count ? cells[$0] : "") })
                }
                blocks.append(.table(align: head.indices.map { $0 < align.count ? align[$0] : nil }, head: head.map { inline($0) }, rows: rows))
                continue
            }

            if let found = match(bullet, line) ?? match(ordered, line) {
                let isOrdered = !matches(bullet, line)
                let baseIndent = found[1].utf16.count
                var items: [[String]] = []
                let start = isOrdered ? Int(found[2]) ?? 1 : 1
                while i < lines.count {
                    let l = lines[i]
                    if let item = match(isOrdered ? ordered : bullet, l), item[1].utf16.count <= baseIndent + 1 {
                        items.append([item[3]])
                        i += 1
                        continue
                    }
                    if trim(l).isEmpty {
                        // A blank line ends the list unless the next line continues it (indented or another item).
                        if let next = at(i + 1), indentOf(next) > baseIndent || matches(isOrdered ? ordered : bullet, next) {
                            if !items.isEmpty { items[items.count - 1].append("") }
                            i += 1
                            continue
                        }
                        break
                    }
                    if indentOf(l) > baseIndent, !items.isEmpty {
                        items[items.count - 1].append(slice(l, from: min(indentOf(l), baseIndent + 2)))
                        i += 1
                        continue
                    }
                    if !items.isEmpty, !startsBlock(l, at(i + 1)) {
                        items[items.count - 1].append(trim(l)) // lazy continuation
                        i += 1
                        continue
                    }
                    break
                }
                blocks.append(.list(ordered: isOrdered, start: start, items: items.map { item in
                    let text = item.joined(separator: "\n")
                    return depth < maxDepth ? parse(text, depth: depth + 1) : [.p([.text(text)])]
                }))
                continue
            }

            // A paragraph: until a blank line or the start of another block.
            var body = [trim(line)]
            i += 1
            while i < lines.count, !trim(lines[i]).isEmpty, !startsBlock(lines[i], at(i + 1)) {
                body.append(trim(lines[i]))
                i += 1
            }
            blocks.append(.p(inline(body.joined(separator: "\n"))))
        }
        return blocks
    }

    private static func isTableStart(_ line: String, _ next: String?) -> Bool {
        guard let next else { return false }
        return line.contains("|") && matches(tableRule, next) && next.contains("-")
    }

    /// A table row's cells: an escaped \| is a bar in the cell, and a bar inside `code` doesn't split it.
    private static func splitRow(_ line: String) -> [String] {
        var row = Array(trim(line).utf16)
        let bar = UInt16(UInt8(ascii: "|")), backslash = UInt16(UInt8(ascii: "\\")), tick = UInt16(UInt8(ascii: "`"))
        if row.first == bar { row.removeFirst() }
        if row.last == bar, !(row.count >= 2 && row[row.count - 2] == backslash) { row.removeLast() }
        var cells: [String] = []
        var current: [UInt16] = []
        var inCode = false
        var i = 0
        while i < row.count {
            let ch = row[i]
            if ch == backslash, i + 1 < row.count, row[i + 1] == bar {
                current.append(bar)
                i += 1
            } else if ch == tick {
                inCode.toggle()
                current.append(ch)
            } else if ch == bar, !inCode {
                cells.append(trim(string(current)))
                current = []
            } else {
                current.append(ch)
            }
            i += 1
        }
        cells.append(trim(string(current)))
        return cells
    }

    private static func alignment(_ cell: String) -> Align? {
        let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
        return left && right ? .center : right ? .right : left ? .left : nil
    }

    /// A line's indentation, a tab counting four.
    private static func indentOf(_ line: String) -> Int {
        line.utf16.prefix { isSpace($0) }.reduce(0) { $0 + ($1 == 9 ? 4 : 1) }
    }

    // MARK: - Inlines

    /// Only absolute http(s) URLs are ever linked, written as a browser writes them.
    static func safeHref(_ href: String) -> String? {
        let trimmed = trim(href)
        guard trimmed.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
              var url = URLComponents(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        url.scheme = scheme
        url.host = host.lowercased()
        if url.port == (scheme == "https" ? 443 : 80) { url.port = nil }
        if url.percentEncodedPath.isEmpty { url.percentEncodedPath = "/" }
        return url.string
    }

    static func inline(_ source: String, depth: Int = 0, inLink: Bool = false) -> [Inline] {
        let s = Array(source.utf16)
        var out: [Inline] = []
        var text: [UInt16] = []
        func flush() {
            if !text.isEmpty { out.append(.text(string(text))) }
            text = []
        }
        let escapable = Set("\\`*_~[]()#>|-".utf16)
        let (newline, backslash, tick, star, underscore, tilde, bracket) = (UInt16(10), UInt16(92), UInt16(96), UInt16(42), UInt16(95), UInt16(126), UInt16(91))
        var i = 0
        while i < s.count {
            let ch = s[i]

            if ch == newline {
                flush()
                out.append(.br)
                i += 1
                continue
            }

            if ch == backslash, i + 1 < s.count, escapable.contains(s[i + 1]) {
                text.append(s[i + 1])
                i += 2
                continue
            }

            if ch == tick {
                var run = 0
                while i + run < s.count, s[i + run] == tick { run += 1 }
                let marker = Array(repeating: tick, count: run)
                if let end = indexOf(marker, in: s, from: i + run), end > 0 {
                    flush()
                    var code = Array(s[(i + run)..<end])
                    // ` x ` is x; a code span that breaks a line keeps its spaces.
                    if code.count >= 2, code.first == 32, code.last == 32, !code.contains(where: isLineBreak) { code = Array(code.dropFirst().dropLast()) }
                    out.append(.code(string(code)))
                    i = end + run
                    continue
                }
                text += marker
                i += run
                continue
            }

            if depth < maxDepth, ch == star || ch == underscore || ch == tilde {
                if let strong = delimited(s, i, [star, star]) ?? delimited(s, i, [underscore, underscore], wordBoundary: true) {
                    flush()
                    out.append(.strong(inline(string(strong.inner), depth: depth + 1, inLink: inLink)))
                    i = strong.end
                    continue
                }
                if let del = delimited(s, i, [tilde, tilde]) {
                    flush()
                    out.append(.del(inline(string(del.inner), depth: depth + 1, inLink: inLink)))
                    i = del.end
                    continue
                }
                if let em = delimited(s, i, [star]) ?? delimited(s, i, [underscore], wordBoundary: true) {
                    flush()
                    out.append(.em(inline(string(em.inner), depth: depth + 1, inLink: inLink)))
                    i = em.end
                    continue
                }
            }

            if ch == bracket, !inLink, let found = match(link, string(Array(s[i...]))) {
                flush()
                if let href = safeHref(found[2]), depth < maxDepth {
                    out.append(.link(href: href, inline(found[1], depth: depth + 1, inLink: true)))
                } else {
                    out.append(.text(found[0]))
                }
                i += found[0].utf16.count
                continue
            }

            if !inLink, ch == 104 || ch == 72, i == 0 || isSpace(s[i - 1]) || s[i - 1] == 40 || s[i - 1] == 60,
               let found = match(bareURL, string(Array(s[i...]))) {
                // Punctuation that ends a sentence isn't part of the address.
                var raw = Array(found[0].utf16)
                while let last = raw.last, ".,;:!?)]".utf16.contains(last) { raw.removeLast() }
                if let href = safeHref(string(raw)) {
                    flush()
                    out.append(.link(href: href, [.text(string(raw))]))
                    i += raw.count
                    continue
                }
            }

            text.append(ch)
            i += 1
        }
        flush()
        return out
    }

    /*
     * Emphasis needs a closing delimiter nearby, in the same paragraph, with no space just inside it. The search is
     * bounded (a few candidate closers within a short distance), so reading stays linear as an answer streams in.
     */
    private static let maxClosers = 8
    private static let maxSpan = 2000

    private static func delimited(_ s: [UInt16], _ i: Int, _ marker: [UInt16], wordBoundary: Bool = false) -> (inner: [UInt16], end: Int)? {
        guard i + marker.count <= s.count, Array(s[i..<(i + marker.count)]) == marker else { return nil }
        if marker.count == 1, i + 1 < s.count, s[i + 1] == marker[0] { return nil } // ** is the strong rule's
        if wordBoundary, i > 0, isWordish(s[i - 1]) { return nil }
        let open = i + marker.count
        if open >= s.count || isSpace(s[open]) { return nil }
        var search = open
        for _ in 0..<maxClosers {
            guard let close = indexOf(marker, in: s, from: search), close - open <= maxSpan else { return nil }
            let after: UInt16? = close + marker.count < s.count ? s[close + marker.count] : nil
            let valid = close > open
                && !isSpace(s[close - 1])
                && !(marker.count == 1 && after == marker[0])
                && !(wordBoundary && after.map(isWordish) == true)
            if valid {
                let inner = Array(s[open..<close])
                if indexOf([10, 10], in: inner, from: 0) == nil { return (inner, close + marker.count) }
            }
            search = close + marker.count
        }
        return nil
    }

    // MARK: - JavaScript's strings

    private static func pattern(_ source: String, caseInsensitive: Bool = false) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: source, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    /// The whole match and its groups (an unmatched group is ""), as `String.match` gives them; nil when it doesn't match.
    private static func match(_ regex: NSRegularExpression, _ text: String) -> [String]? {
        let ns = text as NSString
        guard let found = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<found.numberOfRanges).map { found.range(at: $0).location == NSNotFound ? "" : ns.substring(with: found.range(at: $0)) }
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool { match(regex, text) != nil }

    /// What JavaScript's \s matches, one code unit at a time.
    static func isSpace(_ u: UInt16) -> Bool {
        (9...13).contains(u) || u == 32 || u == 0xA0 || u == 0x1680 || (0x2000...0x200A).contains(u) || u == 0x2028 || u == 0x2029 || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF
    }

    private static func isLineBreak(_ u: UInt16) -> Bool { u == 10 || u == 13 || u == 0x2028 || u == 0x2029 }

    private static func isWordish(_ u: UInt16) -> Bool { (48...57).contains(u) || (65...90).contains(u) || (97...122).contains(u) }

    /// JavaScript's trim().
    static func trim(_ text: String) -> String {
        let units = Array(text.utf16)
        guard let first = units.firstIndex(where: { !isSpace($0) }), let last = units.lastIndex(where: { !isSpace($0) }) else { return "" }
        return string(Array(units[first...last]))
    }

    private static func slice(_ text: String, from start: Int) -> String {
        let units = Array(text.utf16)
        return start >= units.count ? "" : string(Array(units[start...]))
    }

    private static func string(_ units: [UInt16]) -> String { String(decoding: units, as: UTF16.self) }

    private static func indexOf(_ needle: [UInt16], in haystack: [UInt16], from start: Int) -> Int? {
        guard !needle.isEmpty, start >= 0, haystack.count >= needle.count else { return nil }
        var at = start
        while at + needle.count <= haystack.count {
            if haystack[at] == needle[0], Array(haystack[at..<(at + needle.count)]) == needle { return at }
            at += 1
        }
        return nil
    }
}

/// A message quoted in your next one, as a messaging app quotes it: one line of its words (its Markdown read, never
/// shown), at most 160 characters, after "> ", with who said it when that is known.
enum Quote {
    static func of(_ text: String, by speaker: String? = nil) -> String {
        let words = Markdown.plain(Markdown.parse(text))
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        var shown = String(words.prefix(160))
        if shown.count < words.count { shown = shown.trimmingCharacters(in: .whitespaces) + "…" }
        return "> " + (speaker.map { "\($0): " } ?? "") + shown + "\n\n"
    }
}

extension Markdown {
    /// An answer's words without their Markdown, a block a line (what a quote of it says). A block its answer shows
    /// beyond words (a chart, figures) says nothing here.
    static func plain(_ blocks: [Block]) -> String {
        blocks.map { block -> String in
            switch block {
            case .p(let inlines), .h(_, let inlines): plain(inlines)
            case .code(let lang, let text, _): Blocks.Kind(rawValue: lang.lowercased()) == nil ? text : ""
            case .list(_, _, let items): items.map { plain($0) }.joined(separator: "\n")
            case .quote(let inner): plain(inner)
            case .hr: ""
            case .table(_, let head, let rows): ([head] + rows).map { $0.map { plain($0) }.joined(separator: " ") }.joined(separator: "\n")
            }
        }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }

    static func plain(_ inlines: [Inline]) -> String {
        inlines.map { inline -> String in
            switch inline {
            case .text(let text), .code(let text): text
            case .strong(let inner), .em(let inner), .del(let inner), .link(_, let inner): plain(inner)
            case .br: " "
            }
        }
        .joined()
    }
}
