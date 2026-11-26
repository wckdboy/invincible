import SwiftUI

/// Its answer as the PWA draws it: paragraphs, headings, lists, quotes, rules, code and tables, in the system's own
/// type. Words only ever become text; a link is tappable only when it is a web address (`Markdown.safeHref`).
struct MarkdownView: View {
    let blocks: [Markdown.Block]

    init(_ source: String) { blocks = Markdown.parse(source) }
    init(blocks: [Markdown.Block]) { self.blocks = blocks }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
    }
}

private struct BlockView: View {
    let block: Markdown.Block

    var body: some View {
        switch block {
        case .p(let inlines):
            // Its whole height, however it wraps: beside a list's number it was cut to the lines a narrower guess allowed.
            Text(Inlines.attributed(inlines)).fixedSize(horizontal: false, vertical: true)
        case .h(let level, let inlines):
            Text(Inlines.attributed(inlines))
                .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, Space.line)
        case .code(let lang, let text, let open):
            // A block its answer shows beyond words (a chart, figures, choices, steps, a page); any other language is code.
            if let kind = Blocks.Kind(rawValue: lang.lowercased()) {
                AnswerBlock(kind: kind, text: text, open: open)
            } else {
                CodeBlock(lang: lang, text: text)
            }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: Space.s2) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        Text(ordered ? "\(start + index)." : "•")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 22 : 12, alignment: .trailing)
                            .accessibilityHidden(!ordered)
                        // The rest of the line is the item's: its words wrap at the bubble's edge, not sooner.
                        MarkdownView(blocks: item).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: Space.s2) {
                Capsule().fill(.secondary.opacity(0.5)).frame(width: 3)
                MarkdownView(blocks: blocks).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .hr:
            Divider().padding(.vertical, Space.line)
        case .table(let align, let head, let rows):
            TableBlock(align: align, head: head, rows: rows)
        }
    }
}

/// Code, as written: coloured by what each part is (Highlight), monospaced, scrolled sideways rather than wrapped,
/// copied whole, and opened on a page of its own with its lines numbered.
struct CodeBlock: View {
    let lang: String
    let text: String
    @State private var copied = false
    @State private var opened = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s3) {
                Text(lang.isEmpty ? "Code" : lang).font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button {
                    opened = true
                } label: {
                    Label("Open", systemImage: "arrow.up.left.and.arrow.down.right").font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Open the code on a page of its own")
                Button {
                    Pasteboard.copy(text)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(copied ? "Copied" : "Copy the code")
            }
            .padding(.horizontal, Space.s3)
            .padding(.top, Space.s2)
            ScrollView(.horizontal) {
                Text(Highlight.attributed(text, lang: lang))
                    .font(.footnote.monospaced())
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(Space.s3)
            }
        }
        .cover(isPresented: $opened) { CodePage(title: lang.isEmpty ? "Code" : lang, lang: lang, text: text) }
        .background(.fill.quaternary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/// A table: its head in bold, each column aligned as written, scrolled sideways when it's wider than the bubble.
private struct TableBlock: View {
    let align: [Markdown.Align?]
    let head: [[Markdown.Inline]]
    let rows: [[[Markdown.Inline]]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: Space.s4, verticalSpacing: Space.s2) {
                GridRow {
                    ForEach(Array(head.enumerated()), id: \.offset) { column, cell in
                        Text(Inlines.attributed(cell)).font(.subheadline.weight(.semibold)).gridColumnAlignment(alignment(column))
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(Inlines.attributed(cell)).font(.subheadline)
                        }
                    }
                }
            }
            .fixedSize()
            .padding(.vertical, Space.line)
        }
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        switch column < align.count ? align[column] : nil {
        case .center: .center
        case .right: .trailing
        default: .leading
        }
    }
}

/// Inline Markdown as one attributed string: bold, italic, struck, code in the monospaced face, and web links.
enum Inlines {
    static func attributed(_ inlines: [Markdown.Inline]) -> AttributedString {
        var out = AttributedString()
        append(inlines, to: &out, intent: [], struck: false, link: nil)
        return out
    }

    private static func append(_ inlines: [Markdown.Inline], to out: inout AttributedString, intent: InlinePresentationIntent, struck: Bool, link: URL?) {
        for inline in inlines {
            switch inline {
            case .text(let text): out += piece(text, intent: intent, struck: struck, link: link)
            case .code(let text): out += piece(text, intent: intent.union(.code), struck: struck, link: link)
            case .strong(let children): append(children, to: &out, intent: intent.union(.stronglyEmphasized), struck: struck, link: link)
            case .em(let children): append(children, to: &out, intent: intent.union(.emphasized), struck: struck, link: link)
            case .del(let children): append(children, to: &out, intent: intent, struck: true, link: link)
            case .link(let href, let children): append(children, to: &out, intent: intent, struck: struck, link: URL(string: href))
            case .br: out += AttributedString("\n")
            }
        }
    }

    private static func piece(_ text: String, intent: InlinePresentationIntent, struck: Bool, link: URL?) -> AttributedString {
        var piece = AttributedString(text)
        if !intent.isEmpty { piece.inlinePresentationIntent = intent }
        if struck { piece.strikethroughStyle = .single }
        if let link {
            piece.link = link
            piece.underlineStyle = .single
        }
        return piece
    }
}

/// Code on a page of its own: every line numbered, coloured as it is in the answer, wrapped or scrolled sideways as you
/// like (remembered on this device), copied or shared whole. A file of an agent's workspace opens on it too.
struct CodePage: View {
    let title: String
    let lang: String
    let text: String
    @AppStorage("code.wrap") private var wrap = false
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            CodeLines(text: text, lang: lang, wrap: wrap)
                .navigationTitle(title)
                .inlineTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    ToolbarItemGroup(placement: .primaryAction) {
                        Toggle(isOn: $wrap) { Label("Wrap Lines", systemImage: "text.word.spacing") }
                        Button {
                            Pasteboard.copy(text)
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 520)
        #endif
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/// Code with its lines numbered: as written (the numbers' column beside the code's, scrolled both ways), or wrapped, each
/// line beside its number however many rows it takes. A code page, a workspace's file and a diff are drawn with it.
struct CodeLines: View {
    let text: String
    let lang: String
    var wrap = false

    /// Its lines: a file's last newline ends its last line, and starts no line of its own.
    private var lines: [Substring] {
        // ("\r\n" is one character to Swift: a file written on Windows has its lines too.)
        let all = shown.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
        return all.isEmpty ? [""] : all
    }

    /// The text as shown: without the one newline that ends it.
    private var shown: String { text.hasSuffix("\n") || text.hasSuffix("\r\n") ? String(text.dropLast()) : text }

    var body: some View {
        Group {
            if wrap {
                // Wrapped, each line beside its number, however many rows it takes.
                ScrollView {
                    let all = lines
                    let width = String(all.count).count
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(all.enumerated()), id: \.offset) { number, line in
                            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                                Text(String(number + 1).leftPadded(to: width)).foregroundStyle(.tertiary).accessibilityHidden(true)
                                Text(Highlight.attributed(String(line), lang: lang)).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .font(.footnote.monospaced())
                    .padding(Space.s4)
                    .textSelection(.enabled)
                }
            } else {
                // As written: the numbers' column beside the code's, scrolled both ways (each a line a row, so they stay level).
                ScrollView([.vertical, .horizontal]) {
                    HStack(alignment: .top, spacing: Space.s3) {
                        Text((1...max(1, lines.count)).map(String.init).joined(separator: "\n"))
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                        Text(Highlight.attributed(shown, lang: lang))
                            .textSelection(.enabled)
                    }
                    .font(.footnote.monospaced())
                    .fixedSize()
                    .padding(Space.s4)
                }
                .defaultScrollAnchor(.topLeading)
            }
        }
    }
}

private extension String {
    /// Padded on the left with spaces to `width` characters (a line number, so the numbers' column stays straight).
    func leftPadded(to width: Int) -> String { String(repeating: " ", count: max(0, width - count)) + self }
}
