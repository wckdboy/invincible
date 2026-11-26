import Foundation

/// Code coloured by what each part of it is (the PWA's lib/highlight.ts, held to it by the vectors): comments, strings,
/// numbers and a language's own words, found by a small scanner for each family of languages, and a diff by its lines.
/// A language it doesn't know, and code past `long` characters, is left as it is.
enum Highlight {
    enum Tone: String, Sendable { case comment, string, number, keyword, added, removed, meta }

    struct Piece: Equatable, Sendable {
        var text: String
        var tone: Tone?
    }

    private struct Family {
        /// What starts a comment to the end of its line (a `#` only at a line's start or after a space).
        var line: [String]
        var block: (open: String, close: String)? = nil
        /// Quotes that open a string to the same quote, on one line (a backtick's may run on).
        var quotes: Set<Unicode.Scalar>
        /// A `'` is a character, closed within three more: one that isn't stays as it is (a lifetime).
        var chars = false
        /// `"""` (or `'''`) opens a string to the same three.
        var triple = false
        var words: Set<String>
        /// Its words in any case (SQL).
        var caseless = false
    }

    private static func words(_ list: String) -> Set<String> { Set(list.split(separator: " ").map(String.init)) }
    private static let cWords = words("as async await break case catch class const continue default defer do else enum extends extension false final fileprivate fn for func go goto guard if impl import in init inout interface internal let loop match mod move mut namespace new nil null object open operator override package private protected protocol pub public repeat return self Self static struct super switch this throw throws true try type typealias union unsafe use using var virtual void volatile where while yield")
    private static let jsWords = words("as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield")
    private static let pyWords = words("and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try while with yield")
    private static let shWords = words("if then else elif fi for while until do done case esac in function select return exit export local readonly unset shift break continue source alias trap")
    private static let rbWords = words("alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo require rescue retry return self super then true undef unless until when while yield")
    private static let sqlWords = words("add all alter and as asc begin between by case check column commit create default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction union unique update values view when where with")
    private static let dataWords = words("true false null")

    private static let families: [String: Family] = [
        "c": Family(line: ["//"], block: ("/*", "*/"), quotes: ["\""], chars: true, triple: true, words: cWords),
        "go": Family(line: ["//"], block: ("/*", "*/"), quotes: ["\"", "`"], chars: true, words: cWords),
        "js": Family(line: ["//"], block: ("/*", "*/"), quotes: ["\"", "'", "`"], words: jsWords),
        "py": Family(line: ["#"], quotes: ["\"", "'"], triple: true, words: pyWords),
        "sh": Family(line: ["#"], quotes: ["\"", "'"], words: shWords),
        "rb": Family(line: ["#"], quotes: ["\"", "'"], words: rbWords),
        "sql": Family(line: ["--"], block: ("/*", "*/"), quotes: ["'"], words: sqlWords, caseless: true),
        "json": Family(line: [], quotes: ["\""], words: dataWords),
        "yaml": Family(line: ["#"], quotes: ["\"", "'"], words: dataWords),
    ]

    /// A fence's language, by the names models and people give it.
    private static let langs: [String: String] = [
        "swift": "c", "rust": "c", "rs": "c", "java": "c", "kotlin": "c", "kt": "c", "c": "c", "cpp": "c", "c++": "c", "h": "c", "hpp": "c", "cs": "c", "csharp": "c", "scala": "c", "dart": "c", "zig": "c", "php": "c",
        "go": "go", "golang": "go",
        "ts": "js", "typescript": "js", "tsx": "js", "js": "js", "javascript": "js", "jsx": "js", "mjs": "js", "cjs": "js", "jsonc": "js",
        "py": "py", "python": "py", "python3": "py",
        "sh": "sh", "bash": "sh", "zsh": "sh", "shell": "sh", "console": "sh", "fish": "sh", "shellscript": "sh",
        "rb": "rb", "ruby": "rb",
        "sql": "sql", "sqlite": "sql", "postgres": "sql", "postgresql": "sql", "mysql": "sql",
        "json": "json",
        "yaml": "yaml", "yml": "yaml", "toml": "yaml",
    ]

    /// Past this many characters (UTF-16, as the PWA counts) code is shown as it is.
    static let long = 60_000

    static func pieces(_ code: String, lang: String) -> [Piece] {
        let name = lang.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if code.utf16.count > long { return [Piece(text: code)] }
        if name == "diff" || name == "patch" { return diff(code) }
        guard let family = langs[name].flatMap({ families[$0] }) else { return [Piece(text: code)] }
        let s = Array(code.unicodeScalars)
        var out: [Piece] = []
        var plain = String.UnicodeScalarView()
        func text(_ from: Int, _ to: Int) -> String { String(String.UnicodeScalarView(s[from..<to])) }
        func push(_ from: Int, _ to: Int, _ tone: Tone?) {
            guard let tone else { plain.append(contentsOf: s[from..<to]); return }
            if !plain.isEmpty { out.append(Piece(text: String(plain))) }
            plain = String.UnicodeScalarView()
            out.append(Piece(text: text(from, to), tone: tone))
        }
        func starts(_ mark: String, _ at: Int) -> Bool {
            var j = at
            for scalar in mark.unicodeScalars {
                guard j < s.count, s[j] == scalar else { return false }
                j += 1
            }
            return true
        }
        /// From `at` to just past `close` (the end, when it never comes).
        func through(_ at: Int, _ close: String) -> Int {
            let length = close.unicodeScalars.count
            var j = at
            while j + length <= s.count {
                if starts(close, j) { return j + length }
                j += 1
            }
            return s.count
        }
        func space(_ at: Int) -> Bool { at < 0 || [" ", "\t", "\n", "\r"].contains(s[at]) }
        func wordChar(_ at: Int) -> Bool { at >= 0 && at < s.count && (isLetter(s[at]) || isDigit(s[at]) || s[at] == "_" || s[at] == "$") }

        var i = 0
        while i < s.count {
            let ch = s[i]
            if family.line.contains(where: { starts($0, i) && ($0 != "#" || space(i - 1)) }) {
                var stop = i
                while stop < s.count, s[stop] != "\n" { stop += 1 }
                push(i, stop, .comment)
                i = stop
                continue
            }
            if let block = family.block, starts(block.open, i) {
                let stop = through(i + block.open.unicodeScalars.count, block.close)
                push(i, stop, .comment)
                i = stop
                continue
            }
            if family.triple, ch == "\"" || ch == "'", starts(String(repeating: String(ch), count: 3), i) {
                let stop = through(i + 3, String(repeating: String(ch), count: 3))
                push(i, stop, .string)
                i = stop
                continue
            }
            if family.quotes.contains(ch) {
                var j = i + 1
                while j < s.count, s[j] != ch, s[j] != "\n" || ch == "`" { j += s[j] == "\\" ? 2 : 1 }
                let stop = min(s.count, j + 1)
                push(i, stop, .string)
                i = stop
                continue
            }
            if family.chars, ch == "'" {
                var close = i + 1
                while close < s.count, s[close] != "'" { close += 1 }
                if close < s.count, close - i <= 4, !s[(i + 1)..<close].contains("\n") {
                    push(i, close + 1, .string)
                    i = close + 1
                    continue
                }
            }
            if isDigit(ch), !wordChar(i - 1) {
                let stop = number(s, i)
                push(i, stop, .number)
                i = stop
                continue
            }
            if isLetter(ch) || ch == "_" || ch == "$", !wordChar(i - 1) {
                var stop = i + 1
                while stop < s.count, stop - i < 128, wordChar(stop) { stop += 1 }
                let word = text(i, stop)
                push(i, stop, family.words.contains(family.caseless ? word.lowercased() : word) ? .keyword : nil)
                i = stop
                continue
            }
            push(i, i + 1, nil)
            i += 1
        }
        if !plain.isEmpty { out.append(Piece(text: String(plain))) }
        return out
    }

    private static func isDigit(_ c: Unicode.Scalar) -> Bool { c >= "0" && c <= "9" }
    private static func isLetter(_ c: Unicode.Scalar) -> Bool { (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") }
    private static func isHex(_ c: Unicode.Scalar) -> Bool { isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F") || c == "_" }

    /// Where a number that starts at `i` ends: 0x…, 0b…, or digits with a fraction and an exponent (at most 64 long).
    private static func number(_ s: [Unicode.Scalar], _ i: Int) -> Int {
        let end = min(s.count, i + 64)
        func at(_ j: Int) -> Unicode.Scalar? { j < end ? s[j] : nil }
        if s[i] == "0", let x = at(i + 1), x == "x" || x == "X", let d = at(i + 2), isHex(d) {
            var j = i + 2
            while let c = at(j), isHex(c) { j += 1 }
            return j
        }
        if s[i] == "0", let b = at(i + 1), b == "b" || b == "B", let d = at(i + 2), d == "0" || d == "1" || d == "_" {
            var j = i + 2
            while let c = at(j), c == "0" || c == "1" || c == "_" { j += 1 }
            return j
        }
        var j = i + 1
        while let c = at(j), isDigit(c) || c == "_" { j += 1 }
        if at(j) == ".", let d = at(j + 1), isDigit(d) {
            j += 2
            while let c = at(j), isDigit(c) || c == "_" { j += 1 }
        }
        if let e = at(j), e == "e" || e == "E" {
            var k = j + 1
            if let sign = at(k), sign == "+" || sign == "-" { k += 1 }
            if let d = at(k), isDigit(d) {
                k += 1
                while let c = at(k), isDigit(c) { k += 1 }
                j = k
            }
        }
        return j
    }

    /// A diff, line by line: what it adds, what it takes out, and the lines that say where (each with its own newline).
    private static func diff(_ code: String) -> [Piece] {
        var out: [Piece] = []
        // (Split as the PWA splits, at each "\n" alone: a "\r\n" stays with its line.)
        var lines: [String] = []
        var line = String.UnicodeScalarView()
        for c in code.unicodeScalars {
            line.append(c)
            if c == "\n" {
                lines.append(String(line))
                line = String.UnicodeScalarView()
            }
        }
        if !line.isEmpty { lines.append(String(line)) }
        for line in lines {
            let meta = ["+++", "---", "@@", "diff ", "index "].contains { line.hasPrefix($0) }
            let tone: Tone? = meta ? .meta : line.hasPrefix("+") ? .added : line.hasPrefix("-") ? .removed : nil
            if tone == nil, let last = out.last, last.tone == nil {
                out[out.count - 1].text += line
            } else {
                out.append(Piece(text: line, tone: tone))
            }
        }
        return out
    }
}

/// A diff in its files' parts: each `diff --git a/… b/…` section with the path it is about, in order.
enum DiffParts {
    struct Part: Equatable, Sendable {
        let path: String
        let text: String
    }

    static func of(_ diff: String) -> [Part] {
        var parts: [Part] = []
        var path: String?
        var lines: [Substring] = []
        func close() {
            if let path, !lines.isEmpty { parts.append(Part(path: path, text: lines.joined(separator: "\n"))) }
        }
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") {
                close()
                // "diff --git a/<path> b/<path>": the path after " b/" (a path with spaces keeps them).
                path = line.range(of: " b/").map { String(line[$0.upperBound...]) } ?? String(line.dropFirst("diff --git ".count))
                lines = [line]
            } else if path != nil {
                lines.append(line)
            }
        }
        close()
        return parts
    }

    /// The language a file is written in, by its name (for its colours), or "" when it isn't one Highlight knows.
    static func language(of path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return name == "Dockerfile" || name == "Makefile" ? "sh" : "" }
        let ext = name[name.index(after: dot)...].lowercased()
        return ["md": "", "markdown": "", "yml": "yaml", "h": "c", "hpp": "cpp", "mts": "ts", "cts": "ts"][ext] ?? ext
    }
}
