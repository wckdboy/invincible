import SwiftUI

/// Above a chat's message box, what is under way there (your word, 24 November 2026, after OpenMausBot's hand-off rows):
/// each task it gave an agent from this chat that hasn't ended, its agent's face and how it stands, opened with a tap
/// and stopped with its own Stop; and each look it set itself here, when it comes and what at, called off with Cancel.
/// Asked of the node every few seconds while a task is under way or it is answering, just after a look of its comes due
/// (so it goes from here as it takes it), else every half minute.
struct UnderwayBar: View {
    let session: Session
    let chat: ChatModel
    @State private var shown = UnderwayView.none
    @State private var opened: OpenedRoom?
    @State private var asked = 0

    private struct OpenedRoom: Identifiable { let id: String }
    private struct Asking: Equatable { let conversation: String?; let answering: Bool; let asked: Int }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(shown.tasks) { task in
                if task.id != shown.tasks.first?.id { Divider() }
                taskRow(task)
            }
            ForEach(shown.looks) { look in
                if !shown.tasks.isEmpty || look.id != shown.looks.first?.id { Divider() }
                lookRow(look)
            }
        }
        // As the message box under it is: glass.
        .glassEffect(.regular, in: .rect(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, Metrics.margin)
        .readingWidth()
        .opacity(shown.isEmpty ? 0 : 1)
        .frame(height: shown.isEmpty ? 0 : nil)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Under way in this chat")
        .task(id: Asking(conversation: chat.conversation, answering: chat.answering, asked: asked)) { await keepAsking() }
        .sheet(item: $opened) { room in
            NavigationStack { RoomView(session: session, id: room.id) }
        }
    }

    private func taskRow(_ task: UnderwayView.Task) -> some View {
        let agent = session.drawn(task.assignee)
        return HStack(spacing: Space.s2) {
            Button { opened = OpenedRoom(id: task.room) } label: {
                HStack(spacing: Space.s2) {
                    WorkerFace(id: task.assignee, profile: agent?.avatar, size: 26)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(task.name) · \(UnderwayWords.state(of: task))").font(.footnote.weight(.semibold)).lineLimit(1)
                        Text(task.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens \(task.name)'s conversation")
            if session.can("fleet:admin") {
                Button("Stop", systemImage: "stop.fill") { Task { await stop(task) } }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Stop \(task.name)'s work on this")
            }
        }
        .padding(.horizontal, Space.s3)
        .padding(.vertical, Space.s2)
    }

    private func lookRow(_ look: UnderwayView.Look) -> some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "clock").foregroundStyle(.secondary).frame(width: 26)
            Text(UnderwayWords.look(look)).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            Button("Cancel") { Task { await cancel(look) } }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .accessibilityLabel("It won't look again then")
        }
        .padding(.horizontal, Space.s3)
        .padding(.vertical, Space.s2)
    }

    /// Asked now, then again when UnderwayWords.nextAsk says: in a few seconds while a task is under way or it is answering,
    /// just after a look comes due, else in half a minute.
    private func keepAsking() async {
        guard let conversation = chat.conversation else { shown = .none; return }
        while !Task.isCancelled {
            struct Asked: Encodable { let id: String }
            if let view = try? await session.client.post("/api/conversations/underway", Asked(id: conversation), as: UnderwayView.self) {
                if view != shown { withAnimation(.snappy) { shown = view } }
            }
            try? await Task.sleep(for: UnderwayWords.nextAsk(shown, answering: chat.answering))
        }
    }

    private func stop(_ task: UnderwayView.Task) async {
        struct Control: Encodable { let task: String; let action = "stop" }
        _ = try? await session.client.post("/api/team/control", Control(task: task.id), as: JSONValue.self)
        asked += 1
    }

    private func cancel(_ look: UnderwayView.Look) async {
        struct Cancel: Encodable { let id: String }
        _ = try? await session.client.post("/api/looks/cancel", Cancel(id: look.id), as: JSONValue.self)
        asked += 1
    }
}
