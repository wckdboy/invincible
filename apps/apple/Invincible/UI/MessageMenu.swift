import SwiftUI

extension View {
    /// What holding a message offers (a right click, on a Mac): copy it, select some of it, share it, quote it in your
    /// reply, and for yours, put it back in the box to change; for its latest answer, ask again.
    func messageMenu(_ text: String, reply: ((String) -> Void)? = nil, edit: ((String) -> Void)? = nil, askAgain: (() -> Void)? = nil) -> some View {
        modifier(MessageMenu(text: text, reply: reply, edit: edit, askAgain: askAgain))
    }
}

private struct MessageMenu: ViewModifier {
    let text: String
    let reply: ((String) -> Void)?
    let edit: ((String) -> Void)?
    let askAgain: (() -> Void)?
    @State private var selecting = false

    func body(content: Content) -> some View {
        content
            #if os(iOS)
            // The bubble lifts as itself, its own rounded shape.
            .contentShape(.contextMenuPreview, .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
            #endif
            .contextMenu {
                if !text.isEmpty {
                    Button { Pasteboard.copy(text) } label: { Label("Copy", systemImage: "doc.on.doc") }
                    #if os(iOS)
                    // (Holding a bubble selects it whole; this is for a part of it.)
                    Button { selecting = true } label: { Label("Select Text", systemImage: "character.cursor.ibeam") }
                    #endif
                    ShareLink(item: text) { Label("Share…", systemImage: "square.and.arrow.up") }
                }
                if let reply, !text.isEmpty { Button { reply(text) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") } }
                if let edit, !text.isEmpty { Button { edit(text) } label: { Label("Edit", systemImage: "pencil") } }
                if let askAgain {
                    Divider()
                    Button { askAgain() } label: { Label("Ask Again", systemImage: "arrow.clockwise") }
                }
            }
            #if os(iOS)
            .sheet(isPresented: $selecting) { SelectableText(text: text) }
            #else
            // On a Mac a message's words are selected where they are.
            .textSelection(.enabled)
            #endif
    }
}

#if os(iOS)
/// A message's words, to select as much of them as you like and copy.
private struct SelectableText: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Words(text: text)
                .navigationTitle("Select Text")
                .inlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private struct Words: UIViewRepresentable {
        let text: String

        func makeUIView(context: Context) -> UITextView {
            let view = UITextView()
            view.isEditable = false
            view.isSelectable = true
            view.font = .preferredFont(forTextStyle: .body)
            view.adjustsFontForContentSizeCategory = true
            view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
            view.backgroundColor = .clear
            return view
        }

        func updateUIView(_ view: UITextView, context: Context) {
            if view.text != text { view.text = text }
        }
    }
}
#endif
