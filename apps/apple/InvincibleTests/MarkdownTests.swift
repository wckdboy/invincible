import Foundation
import Testing
@testable import Invincible

/// Its answers are read as the PWA reads them (`apps/web/src/lib/markdown.ts`): the same tree for the same words, its
/// quirks included, so an answer reads alike in the app and the browser.
struct MarkdownTests {
    @Test(arguments: Vectors.shared.markdown.indices)
    func anAnswerReadsAsThePWAReadsIt(_ index: Int) throws {
        let item = Vectors.shared.markdown[index]
        #expect(Markdown.parse(item.source) == (try item.blocks.map(block)), "\(item.source)")
    }

    @Test func onlyWebAddressesBecomeLinksAndTheyAreWrittenAsABrowserWritesThem() {
        #expect(Markdown.safeHref("https://example.com/x?y=1") == "https://example.com/x?y=1")
        #expect(Markdown.safeHref("HTTPS://Example.COM") == "https://example.com/")
        #expect(Markdown.safeHref("http://example.org:80/p") == "http://example.org/p")
        #expect(Markdown.safeHref("javascript:alert(1)") == nil)
        #expect(Markdown.safeHref("/path") == nil)
        #expect(Markdown.safeHref("mailto:a@b.c") == nil)
    }

    // The PWA's tree, as the Swift one.
    private func block(_ json: JSONValue) throws -> Markdown.Block {
        let node = try object(json)
        switch try string(node["t"]) {
        case "p": return .p(try inlines(node["c"]))
        case "h": return .h(level: Int(try number(node["level"])), try inlines(node["c"]))
        case "code": return .code(lang: try string(node["lang"]), text: try string(node["v"]), open: node["open"] == .bool(true))
        case "list":
            guard case .array(let items) = node["items"] else { throw Unread.shape }
            return .list(ordered: node["ordered"] == .bool(true), start: Int(try number(node["start"])), items: try items.map { item in
                guard case .array(let blocks) = item else { throw Unread.shape }
                return try blocks.map(block)
            })
        case "quote":
            guard case .array(let blocks) = node["c"] else { throw Unread.shape }
            return .quote(try blocks.map(block))
        case "hr": return .hr
        case "table":
            guard case .array(let align) = node["align"], case .array(let head) = node["head"], case .array(let rows) = node["rows"] else { throw Unread.shape }
            return .table(
                align: align.map { if case .string(let side) = $0 { Markdown.Align(rawValue: side) } else { nil } },
                head: try head.map { try inlines($0) },
                rows: try rows.map { row in
                    guard case .array(let cells) = row else { throw Unread.shape }
                    return try cells.map { try inlines($0) }
                }
            )
        default: throw Unread.shape
        }
    }

    private func inlines(_ json: JSONValue?) throws -> [Markdown.Inline] {
        guard case .array(let nodes) = json else { throw Unread.shape }
        return try nodes.map { json in
            let node = try object(json)
            switch try string(node["t"]) {
            case "text": return .text(try string(node["v"]))
            case "code": return .code(try string(node["v"]))
            case "strong": return .strong(try inlines(node["c"]))
            case "em": return .em(try inlines(node["c"]))
            case "del": return .del(try inlines(node["c"]))
            case "link": return .link(href: try string(node["href"]), try inlines(node["c"]))
            case "br": return .br
            default: throw Unread.shape
            }
        }
    }

    private enum Unread: Error { case shape }
    private func object(_ json: JSONValue?) throws -> [String: JSONValue] { if case .object(let o) = json { o } else { throw Unread.shape } }
    private func string(_ json: JSONValue?) throws -> String { if case .string(let s) = json { s } else { throw Unread.shape } }
    private func number(_ json: JSONValue?) throws -> Double { if case .number(let n) = json { n } else { throw Unread.shape } }
}
