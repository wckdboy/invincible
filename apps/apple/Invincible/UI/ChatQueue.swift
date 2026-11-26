import SwiftUI

/*
 * What waits above the primary's message box while it works (the PWA's chat-queue.ts, in its words: ComposerWords):
 * what became of something you sent then, steers on their way to it, and what you queued behind the chat, each with
 * Send now, Edit and Remove; a held queue says why, with Resume and Discard. And a side question, asked apart
 * (chat-aside.ts), with Bring back.
 */
struct QueuePanel: View {
    @Bindable var chat: ChatModel
    let client: NodeClient
    @State private var editing: QueuedMessage?
    @State private var edited = ""
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if chat.notice != nil || !chat.steering.isEmpty || !chat.queue.isEmpty {
            VStack(alignment: .leading, spacing: Space.s2) {
                if let notice = chat.notice {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        VStack(alignment: .leading, spacing: Space.line) {
                            Text(notice.title).font(.caption.weight(.semibold))
                            Text(notice.detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: Space.s2)
                        Button("OK") { chat.notice = nil }.font(.caption.weight(.semibold)).frame(minHeight: Metrics.touch)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("chat.notice")
                }
                if !chat.steering.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        ProgressView().controlSize(.mini)
                        VStack(alignment: .leading, spacing: Space.line) {
                            Text(ComposerWords.steering(chat.steering.count)).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                            ForEach(Array(chat.steering.enumerated()), id: \.offset) { _, text in
                                Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("queue.steering")
                }
                if !chat.queue.isEmpty {
                    let head = ComposerWords.queueHead(queued: chat.queue.count, held: chat.held, busy: chat.answering)
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        Image(systemName: chat.held != nil ? "pause" : "clock").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                        Text("\(Text(head.count).fontWeight(.semibold))\(head.rest)").font(.caption).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(chat.held != nil ? "queue.held" : "queue.head")
                    if chat.held != nil {
                        HStack(spacing: Space.s2) {
                            NeedButton(title: "Resume", prominent: true) { Task { await chat.resumeQueue(with: client) } }
                                .accessibilityIdentifier("queue.resume")
                            NeedButton(title: "Discard") { Task { await chat.discardQueue(with: client) } }
                                .accessibilityIdentifier("queue.discard")
                        }
                    }
                    ForEach(chat.queue) { queued in row(queued) }
                }
            }
            .padding(.horizontal, Metrics.margin)
            .padding(.vertical, Space.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Divider() }
            .readingWidth()
            .alert("Edit the queued message", isPresented: .init(get: { editing != nil }, set: { if !$0 { editing = nil } }), presenting: editing) { queued in
                TextField("Queued message", text: $edited)
                Button("Save") {
                    let text = edited.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await chat.editQueued(queued.id, text: text, with: client) }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    /// A queued message: its words (and the device it came from), then Send now, Edit and Remove.
    private func row(_ queued: QueuedMessage) -> some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text("\(queued.text)\(Text(queued.by.map { " · from \($0)" } ?? "").foregroundStyle(.tertiary))")
                .font(.caption)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 3)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.s2) { actions(queued) }
                VStack(alignment: .leading, spacing: Space.s1) { actions(queued) }
            }
        }
        .padding(.leading, Space.s4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queue.item.\(queued.id)")
    }

    @ViewBuilder private func actions(_ queued: QueuedMessage) -> some View {
        Button("Send now") { Task { await chat.sendQueued(queued.id, with: client) } }
            .font(.caption.weight(.semibold))
            .frame(minHeight: Metrics.touch)
            .accessibilityIdentifier("queue.send.\(queued.id)")
        Button("Edit") {
            edited = queued.text
            editing = queued
        }
        .font(.caption)
        .frame(minHeight: Metrics.touch)
        .accessibilityIdentifier("queue.edit.\(queued.id)")
        Button("Remove") { Task { await chat.removeQueued(queued.id, with: client) } }
            .font(.caption)
            .frame(minHeight: Metrics.touch)
            .accessibilityIdentifier("queue.remove.\(queued.id)")
    }
}

/// Ask on the side (the PWA's chat-aside.ts): the question, its answer apart from the chat as it comes, and Bring back,
/// which hands both to the chat after all.
struct AsideSheet: View {
    let side: SideQuestion
    let client: NodeClient
    /// What Bring back did, in words: said in the chat once the sheet has gone.
    let brought: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var typing: Bool

    var body: some View {
        @Bindable var side = side
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s3) {
                    PageNote(ComposerWords.asideNote(working: side.working))
                    TextField(ComposerWords.asidePlaceholder(working: side.working), text: $side.question, axis: .vertical)
                        .lineLimit(2...6)
                        .focused($typing)
                        .submitLabel(.send)
                        .onSubmit { side.ask(with: client) }
                        .quietField()
                        .accessibilityIdentifier("aside.question")
                    if side.asking, side.answer.isEmpty {
                        HStack(spacing: Space.s2) {
                            ProgressView().controlSize(.small)
                            Text(ComposerWords.asideAnswering)
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                    if !side.answer.isEmpty {
                        Divider()
                        MarkdownView(side.answer).font(Typeset.body).accessibilityIdentifier("aside.answer")
                    }
                    if let problem = side.problem {
                        VStack(alignment: .leading, spacing: Space.line) {
                            Text(problem.title).font(.footnote.weight(.semibold))
                            Text(problem.detail).font(.footnote)
                        }
                        .foregroundStyle(Color.danger)
                    }
                }
                .padding(Metrics.margin)
            }
            .navigationTitle("Ask on the side")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        side.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(side.asked ? "Ask again" : "Ask") { side.ask(with: client) }
                        .disabled(side.asking || side.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("aside.ask")
                }
            }
            .safeAreaInset(edge: .bottom) {
                if side.canBringBack {
                    Button {
                        Task {
                            if let words = await side.bringBack(with: client) {
                                dismiss()
                                brought(words)
                            }
                        }
                    } label: {
                        Label("Bring back", systemImage: "arrow.up").fontWeight(.semibold).foregroundStyle(Prominent.label()).frame(maxWidth: .infinity, minHeight: 34)
                    }
                    .buttonStyle(.glassProminent)
                    .padding(Metrics.margin)
                    .accessibilityIdentifier("aside.bring")
                }
            }
            .onAppear {
                // Asked at once when it came with its question ("/btw …"); otherwise the box takes the keys.
                if side.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { typing = true } else { side.ask(with: client) }
            }
        }
        .presentationDetents([.medium, .large])
        .sheetSize(width: 520, height: 520)
    }
}
