import SwiftUI

/// Everything that needs you, in one place (the PWA's Inbox): devices asking to join, calls the primary's policy made it ask
/// your approval for, keys it asked for, facts it noticed about you, and what the node noticed for you. Nothing here happens
/// without your say.
struct InboxView: View {
    let session: Session
    @State private var open: ActionView?
    /// The card was opened from its notification's Approve: its yes is given behind Face ID.
    @State private var guarded = false

    /// When you put the card that says it can't reach this device away (Not now, for a week).
    @AppStorage("reach-put-away") private var reachPutAway: Double = 0

    /// Whether the card that says it can't reach this device is at the top (iPhone and iPad only).
    private var reachShown: Bool {
        #if os(iOS)
        (PushCenter.shared.reach == .turnOn || PushCenter.shared.reach == .settings) && Date.now.timeIntervalSince1970 - reachPutAway >= 7 * 24 * 3600
        #else
        false
        #endif
    }
    /// Why an approval declined from its row wasn't (the row has no room to say it).
    @State private var declineTrouble: String?

    var body: some View {
        GroupedList {
            #if os(iOS)
            if reachShown {
                Section { ReachCard(session: session).listRowInsets(EdgeInsets()) }
            }
            #endif
            if !session.pairings.isEmpty {
                Section {
                    ForEach(session.pairings) { pairing in
                        JoinRequestRow(session: session, pairing: pairing)
                    }
                } header: {
                    Text("Devices asking to join")
                } footer: {
                    Text("Let one in only if it shows the same code.")
                }
            }
            if !session.questions.isEmpty {
                Section {
                    ForEach(session.questions) { question in
                        QuestionRow(session: session, question: question)
                    }
                } header: {
                    Text("Services ask you")
                } footer: {
                    Text("An MCP server asked you something in the middle of a call of \(Primary.name)'s. Only you answer it; what you send goes to that service alone.")
                }
            }
            if !session.screenSessions.isEmpty {
                Section {
                    ForEach(session.screenSessions) { screen in
                        ScreenSessionRow(session: session, screen: screen)
                    }
                } header: {
                    Text("Its use of a Mac itself")
                } footer: {
                    Text("Nothing of the Mac is \(Primary.name)'s until you let it, and only for the minutes asked. You can watch it and end it any time.")
                }
            }
            if !session.waiting.isEmpty {
                Section {
                    ForEach(session.waiting) { action in
                        Button {
                            guarded = false
                            open = action
                        } label: { ApprovalRow(action: action) }
                            .tint(.primary)
                            // A no from the row; a yes is only ever given in the approval itself.
                            .inboxSwipe("Decline", when: session.can("fleet:admin")) {
                                Task {
                                    do { try await session.decide(action, approve: false) } catch { declineTrouble = error.localizedDescription }
                                }
                            }
                    }
                } header: {
                    Text("Waiting for your approval")
                } footer: {
                    Text("Nothing leaves until you approve it. Unanswered, it's a no.")
                }
            }
            if !session.requests.isEmpty {
                Section {
                    ForEach(session.requests) { request in
                        KeyRequestRow(session: session, request: request)
                    }
                } header: {
                    Text("Keys \(Primary.name) asked for")
                } footer: {
                    Text("It'll learn that a key exists, never what it is. One you dismiss is back only if it asks again.")
                }
            }
            if !session.facts.isEmpty {
                Section {
                    ForEach(session.facts) { fact in
                        FactRow(session: session, fact: fact)
                    }
                } header: {
                    Text("Facts it noticed about you")
                } footer: {
                    Text("Each goes with every answer it gives once you keep it, in your words if you like. Until then it is only a note of \(Primary.name)'s.")
                }
            }
            if !session.notices.isEmpty {
                Section {
                    ForEach(session.notices) { notice in
                        NoticeRow(session: session, notice: notice)
                    }
                } header: {
                    Text("Noticed")
                } footer: {
                    Text("The heartbeat's findings, and what your rules tell you. One you dismiss stays quiet until it changes.")
                }
            }
        }
        .overlay {
            if !session.inboxLoaded {
                ProgressView()
            } else if session.inboxCount == 0 && !reachShown {
                ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("Approvals, \(Primary.name)'s asks to use a Mac, keys it asks for, facts it noticed about you, what your rules tell you and devices asking to join wait here."))
            }
        }
        .navigationTitle("Inbox")
        .refreshable { await session.refresh() }
        .sheet(item: $open) { action in
            ApprovalSheet(session: session, action: action, guarded: guarded)
        }
        // An approval its notification's Approve asked to see: its card, once the Inbox has it.
        .task(id: session.approvalToOpen) {
            guard let id = session.approvalToOpen else { return }
            if !session.waiting.contains(where: { $0.id == id }) { await session.reread(["actions"], force: true) }
            session.approvalToOpen = nil
            guard let action = session.waiting.first(where: { $0.id == id }) else { return }
            guarded = true
            open = action
        }
        .alert("Couldn't decline it", isPresented: Binding(get: { declineTrouble != nil }, set: { if !$0 { declineTrouble = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(declineTrouble ?? "")
        }
    }
}

extension View {
    /// How an item leaves the Inbox, in its row's own word (Dismiss, Decline, Drop, Not now, End now): a swipe on an iPhone
    /// or an iPad, a right click on a Mac. Never a yes: letting anything in or out stays a deliberate press.
    @ViewBuilder
    func inboxSwipe(_ title: String, systemImage: String = "xmark", when allowed: Bool = true, action: @escaping () -> Void) -> some View {
        if allowed {
            #if os(iOS)
            swipeActions(edge: .trailing, allowsFullSwipe: true) {
                // In red, as a swipe that takes a row away is on an iPhone (a row's own tint would make it ink).
                Button(role: .destructive, action: action) { Label(title, systemImage: systemImage) }
                    .tint(Color.danger)
            }
            #else
            contextMenu {
                Button(role: .destructive, action: action) { Label(title, systemImage: systemImage) }
            }
            #endif
        } else {
            self
        }
    }
}

/// A row of the Inbox: what it is about, in the primary's red, in a column of its own, and everything else beside it, so
/// every row's words start at one edge whatever its icon.
struct InboxRow<Content: View>: View {
    let symbol: String
    /// It opens: a chevron at its end, as a row that leads somewhere has.
    var opens = false
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Image(systemName: symbol)
                .foregroundStyle(Color.danger)
                .frame(width: Metrics.iconColumn)
            VStack(alignment: .leading, spacing: Space.s3) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
            if opens {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, Space.s1)
    }
}

/// The buttons a row of the Inbox answers with: side by side, or one above the other when the words are too big for that.
struct InboxButtons<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s3) { content }
            VStack(alignment: .leading, spacing: Space.s2) { content }
        }
    }
}

/// An approval in a line: what it calls, why, who asked, and until when.
struct ApprovalRow: View {
    let action: ActionView

    var body: some View {
        InboxRow(symbol: Approval.symbol(action.kind), opens: true) {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text("\(action.connector).\(action.tool)").font(.headline.monospaced())
                if let why = action.why, !why.isEmpty { Text(why).font(.subheadline) }
                // Its time left counts down: in figures of one width, so the line doesn't shift as it does.
                Text("Asked by \(Approval.askedBy(action.by)) · expires in \(Text(Date(timeIntervalSince1970: action.expires / 1000), style: .relative))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The changes an approval would send (its kept work's changes.patch), to read before you answer.
struct KeptChanges: View {
    let session: Session
    let artifact: String
    @State private var text: String?
    @State private var problem: String?
    /// More than this is cut: a patch that big is read in full from Artifacts.
    private static let shown = 200_000

    var body: some View {
        Group {
            if let text { CodeLines(text: text, lang: "diff") }
            else if let problem { ContentUnavailableView("Couldn't read the changes", systemImage: "exclamationmark.triangle", description: Text(problem)) }
            else { ProgressView() }
        }
        .navigationTitle("The changes")
        .inlineTitle()
        .task { await load() }
    }

    private func load() async {
        struct Ask: Encodable { let id: String; let path: String }
        do {
            let data = try await session.client.bytes("/api/artifacts/file", Ask(id: artifact, path: "changes.patch"))
            let start = String(decoding: data.prefix(Self.shown), as: UTF8.self)
            text = data.count > Self.shown ? start + "\n… (cut here: \(data.count) bytes in all, in \(artifact))" : start
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// An approval in full: what it sends and where, who asked and why. Approving asks once more, and a delete is approved
/// only by typing what it deletes.
struct ApprovalSheet: View {
    let session: Session
    let action: ActionView
    /// Opened from its notification's Approve: the yes is given behind Face ID (or the passcode), the request in front of
    /// you (your word, 25 November 2026).
    var guarded = false
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var typed = ""
    @State private var busy = false
    @State private var problem: String?
    /// Your own words in its texts, before your yes: what you've typed, by argument.
    @State private var editing = false
    @State private var drafts: [String: String] = [:]

    private var destructive: Bool { action.kind == "delete" }
    private var node: String { session.nodeName(of: action.node) }
    /// The texts it carries, which you may change before your yes (never a delete's: what it deletes is typed to approve it).
    private var texts: [String: String] {
        guard !destructive else { return [:] }
        return action.args.compactMapValues { if case .string(let text) = $0 { text } else { nil } }
    }
    /// Only what you changed goes.
    private var edits: [String: String] { drafts.filter { texts[$0.key] != nil && texts[$0.key] != $0.value } }

    var body: some View {
        NavigationStack {
            GroupedList {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: Space.s1) {
                            Text("\(action.connector).\(action.tool)").font(.headline.monospaced())
                            Text(Approval.classLine(action.kind)).font(.subheadline).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: Approval.symbol(action.kind)).foregroundStyle(Color.danger)
                    }
                    if let why = action.why, !why.isEmpty { Text(why) }
                }
                if !action.args.isEmpty {
                    Section {
                        ForEach(action.args.keys.sorted(), id: \.self) { key in
                            VStack(alignment: .leading, spacing: Space.s1) {
                                Text(key).font(.caption.monospaced()).foregroundStyle(.secondary)
                                if editing, let text = texts[key] {
                                    TextField(key, text: Binding(get: { drafts[key] ?? text }, set: { drafts[key] = $0 }), axis: .vertical)
                                        .font(.body.monospaced())
                                        .lineLimit(2...12)
                                } else {
                                    Text(drafts[key] ?? action.args[key]?.text ?? "").font(.body.monospaced()).textSelection(.enabled)
                                }
                            }
                        }
                    } header: {
                        Text("What it sends")
                    } footer: {
                        if !edits.isEmpty { Text("Your version is what \(node) sends. The request as it was asked is declined, saying which it became.") }
                    }
                }
                if let work = Approval.work(action.args) {
                    Section {
                        NavigationLink { KeptChanges(session: session, artifact: work) } label: { Label("Read the changes", systemImage: "doc.plaintext") }
                    } footer: {
                        Text("The work this sends, kept with its SHA-256s: what changes.patch says it changes.")
                    }
                }
                Section {
                    LabeledContent("Where it goes") { Text(action.target).font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                    LabeledContent("Asked by", value: Approval.askedBy(action.by))
                    LabeledContent("Sent from", value: node)
                    LabeledContent("Expires in") { Text(Date(timeIntervalSince1970: action.expires / 1000), style: .relative).monospacedDigit() }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
                }
                if !session.can("fleet:admin") {
                    Section { Text("This device can't answer approvals (it has no fleet:admin scope).").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle(destructive ? "Delete?" : "Send?")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if session.can("fleet:admin") && !texts.isEmpty {
                    ToolbarItem(placement: .primaryAction) { Button(editing ? "Done" : "Edit") { editing.toggle() } }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if session.can("fleet:admin") {
                    HStack(spacing: Space.s3) {
                        Button(role: .destructive) {
                            Task { await decide(false) }
                        } label: {
                            Text("Decline").frame(maxWidth: .infinity, minHeight: 34)
                        }
                        .buttonStyle(.glass)
                        Button {
                            typed = ""
                            confirming = true
                        } label: {
                            Text(destructive ? "Approve delete…" : "Approve…").fontWeight(.semibold).foregroundStyle(Prominent.label()).frame(maxWidth: .infinity, minHeight: 34)
                        }
                        .buttonStyle(.glassProminent)
                    }
                    .disabled(busy)
                    .padding(Metrics.margin)
                }
            }
            .alert(destructive ? "Approve this delete?" : edits.isEmpty ? "Approve and send?" : "Approve and send as edited?", isPresented: $confirming) {
                if destructive {
                    TextField(Approval.deleteName(connector: action.connector, tool: action.tool, target: action.target, args: action.args), text: $typed)
                        .capitals(.never)
                        .autocorrectionDisabled()
                }
                Button(destructive ? "Approve delete" : edits.isEmpty ? "Approve and send" : "Approve and send as edited", role: destructive ? .destructive : nil) {
                    Task {
                        if guarded {
                            if let refused = await DeviceOwner.confirm("Approve \(action.connector).\(action.tool)") {
                                problem = refused
                                return
                            }
                        }
                        await decide(true)
                    }
                }
                .disabled(destructive && typed != Approval.deleteName(connector: action.connector, tool: action.tool, target: action.target, args: action.args))
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(destructive
                    ? "\(node) deletes \(action.target) once, as soon as you approve. It can't be brought back. Type its name to approve."
                    : "\(node) sends \(edits.isEmpty ? "it" : "your version") to \(action.target) once, as soon as you approve. It can't be called back, and if it fails it isn't retried.")
            }
        }
        .sheetSize(width: 560, height: 600)
    }

    private func decide(_ approve: Bool) async {
        busy = true
        defer { busy = false }
        do {
            try await session.decide(action, approve: approve, edits: approve && !edits.isEmpty ? edits : nil)
            dismiss()
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// A key the primary asked for: what for, and a secure field that seals it into the vault from here.
struct KeyRequestRow: View {
    let session: Session
    let request: SecretRequestView
    @State private var value = ""
    @State private var sealing = false
    @State private var dismissing = false
    @State private var problem: String?

    var body: some View {
        InboxRow(symbol: "key.fill") {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text("\(Primary.name) asks for \(Text(request.name).font(.body.monospaced()).bold())")
                Text(request.purpose).font(.subheadline)
                if let asked = hlcDate(request.requestedAt) {
                    Text("Asked \(Text(asked, style: .relative)) ago").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if session.can("vault:write") {
                HStack(spacing: Space.s2) {
                    // (No password content type: an API key is no password of yours for AutoFill to keep. iOS still
                    // offers its Passwords bar on any secure field.)
                    FormField("Paste the key", text: $value, secure: true)
                        .capitals(.never)
                        .autocorrectionDisabled()
                        .quietField()
                        .submitLabel(.done)
                        .onSubmit(seal)
                        .accessibilityIdentifier("key-\(request.name)")
                    Button(action: seal) {
                        Group {
                            if sealing { ProgressView().tint(Color.onAccent) } else { Text("Seal").fontWeight(.semibold).foregroundStyle(Prominent.label(dimmed: value.isEmpty)) }
                        }
                        .frame(maxHeight: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(value.isEmpty || sealing)
                }
                .fixedSize(horizontal: false, vertical: true)
                // One that no longer matters, or that you won't give.
                Button("Dismiss") { Task { await dismiss() } }
                    .buttonStyle(.glass)
                    .disabled(dismissing || sealing)
                    .accessibilityLabel("Dismiss: \(request.name)")
            } else {
                Text("This device can't fill key requests (it has no vault:write scope).").font(.footnote).foregroundStyle(.secondary)
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        }
        .inboxSwipe("Dismiss", when: session.can("vault:write")) { Task { await dismiss() } }
    }

    private func dismiss() async {
        dismissing = true
        defer { dismissing = false }
        do {
            try await session.dismiss(request)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    private func seal() {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // The field is cleared before anything is sent: the key is never shown back.
        value = ""
        guard !key.isEmpty, !sealing else { return }
        sealing = true
        problem = nil
        Task {
            defer { sealing = false }
            do {
                try await session.seal(request, value: key)
            } catch {
                problem = "\(error.localizedDescription). Paste it again."
            }
        }
    }
}

/// A fact about you it proposed: keep it as it put it, or in your words, or drop it.
struct FactRow: View {
    let session: Session
    let fact: Fact
    @State private var rewording = false
    @State private var words = ""
    @State private var problem: String?

    var body: some View {
        InboxRow(symbol: "person.text.rectangle") {
            Text(fact.text)
            if session.can("mind:write") {
                InboxButtons {
                    Button {
                        Task { await act { try await session.keep(fact) } }
                    } label: {
                        Text("Keep").fontWeight(.semibold).foregroundStyle(Prominent.label())
                    }
                    .buttonStyle(.glassProminent)
                    Button("In my words") {
                        words = fact.text
                        rewording = true
                    }
                    .buttonStyle(.glass)
                    Button("Drop", role: .destructive) { Task { await act { try await session.drop(fact) } } }
                        .buttonStyle(.glass)
                }
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        }
        .inboxSwipe("Drop", systemImage: "trash", when: session.can("mind:write")) { Task { await act { try await session.drop(fact) } } }
        .alert("In your words", isPresented: $rewording) {
            TextField("About you", text: $words)
            Button("Keep") {
                let said = words.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !said.isEmpty else { return }
                Task { await act { try await session.keep(fact, text: said) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It goes with every answer it gives.")
        }
    }

    private func act(_ work: () async throws -> Void) async {
        do {
            try await work()
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// Something the node noticed for you: what it is, in the node's words (a command as written), where it came from and
/// when; yours to dismiss.
struct NoticeRow: View {
    let session: Session
    let notice: NoticeView
    @State private var dismissing = false
    @State private var problem: String?

    var body: some View {
        InboxRow(symbol: Notices.symbol(notice)) {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text(notice.title).font(.headline)
                ForEach(Array(notice.body.split(separator: "\n").enumerated()), id: \.offset) { _, line in
                    if line.hasPrefix("$ ") {
                        Text(line).font(.footnote.monospaced()).textSelection(.enabled)
                    } else {
                        Text(line).font(.subheadline)
                    }
                }
                Text("\(Notices.from(notice.source)) · \(Text(Date(timeIntervalSince1970: notice.at / 1000), style: .relative)) ago")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if session.can("fleet:admin") {
                Button("Dismiss") {
                    Task { await dismiss() }
                }
                .buttonStyle(.glass)
                .disabled(dismissing)
                .accessibilityLabel("Dismiss: \(notice.title)")
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        }
        .inboxSwipe("Dismiss", when: session.can("fleet:admin")) { Task { await dismiss() } }
    }

    private func dismiss() async {
        dismissing = true
        defer { dismissing = false }
        do {
            try await session.dismiss(notice)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// Its ask to use a Mac itself (docs/MAC.md, M4), or its session there: what for (its words), for how long, and your
/// answer; while it runs, watching it and ending it.
/// An MCP server's question, mid-call: its words, quoted as its own, a field for each thing it asks, then Send or No.
struct QuestionRow: View {
    let session: Session
    let question: QuestionView
    @State private var texts: [String: String] = [:]
    @State private var yeses: [String: Bool] = [:]
    @State private var picked: [String: Set<String>] = [:]
    @State private var problem: String?
    @State private var sending = false

    var body: some View {
        InboxRow(symbol: "questionmark.bubble") {
            Text("\(question.label) asks you").font(.headline)
            Text(question.message).font(.subheadline)
            ForEach(question.fields, id: \.name) { field in
                VStack(alignment: .leading, spacing: Space.s1) {
                    input(field)
                    if let description = field.description { Text(description).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Text("Its call waits for your answer until \(Text(Date(timeIntervalSince1970: question.expires / 1000), style: .time)). A service's own form: never a password or a key.")
                .font(.footnote).foregroundStyle(.secondary)
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
            if session.can("fleet:admin") {
                InboxButtons {
                    Button("No") { Task { await send(false) } }.buttonStyle(.bordered)
                    Button("Send") { Task { await send(true) } }.buttonStyle(.borderedProminent)
                }
                .disabled(sending)
            }
        }
        .onAppear(perform: fillDefaults)
    }

    @ViewBuilder private func input(_ field: QuestionField) -> some View {
        let label = field.required ? field.title : "\(field.title) (optional)"
        switch field.kind {
        case "yes-no":
            Toggle(label, isOn: Binding(get: { yeses[field.name] ?? false }, set: { yeses[field.name] = $0 }))
        case "one":
            Picker(label, selection: Binding(get: { texts[field.name] ?? "" }, set: { texts[field.name] = $0 })) {
                Text("Choose…").tag("")
                ForEach(field.options ?? [], id: \.value) { Text($0.title).tag($0.value) }
            }
        case "many":
            Text(label).font(.subheadline)
            ForEach(field.options ?? [], id: \.value) { option in
                Toggle(option.title, isOn: Binding(get: { picked[field.name]?.contains(option.value) ?? false }, set: { on in
                    var chosen = picked[field.name] ?? []
                    if on { chosen.insert(option.value) } else { chosen.remove(option.value) }
                    picked[field.name] = chosen
                }))
            }
        case "number":
            TextField(label, text: Binding(get: { texts[field.name] ?? "" }, set: { texts[field.name] = $0 })).keyboard(.decimal)
        default:
            TextField(label, text: Binding(get: { texts[field.name] ?? "" }, set: { texts[field.name] = $0 }))
                .capitals(.never)
                .autocorrectionDisabled()
        }
    }

    /// What the server suggested, filled in once.
    private func fillDefaults() {
        for field in question.fields where texts[field.name] == nil && yeses[field.name] == nil && picked[field.name] == nil {
            switch field.default {
            case .string(let text): texts[field.name] = text
            case .number(let number): texts[field.name] = number.rounded() == number ? String(Int(number)) : String(number)
            case .bool(let yes): yeses[field.name] = yes
            case .array(let values): picked[field.name] = Set(values.compactMap { value -> String? in
                if case .string(let text) = value { return text }
                return nil
            })
            default: break
            }
        }
    }

    private func send(_ accept: Bool) async {
        var content: [String: QuestionAnswer] = [:]
        for field in question.fields {
            let text = (texts[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            switch field.kind {
            case "yes-no": content[field.name] = .yes(yeses[field.name] ?? false)
            case "many": if let chosen = picked[field.name], !chosen.isEmpty { content[field.name] = .several(chosen.sorted()) }
            case "number":
                guard !text.isEmpty else { continue }
                guard let number = Double(text.replacingOccurrences(of: ",", with: ".")) else { problem = "\(field.title): a number is needed."; return }
                content[field.name] = .number(number)
            default: if !text.isEmpty { content[field.name] = .text(text) }
            }
        }
        sending = true
        defer { sending = false }
        do {
            try await session.answer(question: question, accept: accept, content: content)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

struct ScreenSessionRow: View {
    let session: Session
    let screen: ScreenSessionView
    @State private var confirming = false
    @State private var problem: String?

    private func clock(_ ms: Double) -> Text {
        Text(Date(timeIntervalSince1970: ms / 1000), style: .time)
    }

    var body: some View {
        InboxRow(symbol: "desktopcomputer") {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text(screen.state == "allowed" ? "\(Primary.name) is using \(screen.nodeName) itself" : "\(Primary.name) asks to use \(screen.nodeName) itself").font(.headline)
                Text(screen.why).font(.subheadline)
                Group {
                    if screen.state == "allowed", let until = screen.until {
                        Text("Until \(clock(until)), or until you end it.")
                    } else {
                        Text("For \(screen.minutes) minutes, if you let it. Answer by \(clock(screen.answerBy)).")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if session.can("fleet:admin") {
                InboxButtons {
                    if screen.state == "allowed" {
                        NavigationLink {
                            AgentScreenView(session: session, of: .mac(node: screen.node, name: screen.nodeName))
                        } label: {
                            Text("Watch")
                        }
                        .buttonStyle(.glass)
                        Button("End now", role: .destructive) { Task { await act { try await session.end(screen: screen) } } }
                            .buttonStyle(.glass)
                    } else {
                        Button("Not now") { Task { await act { try await session.decide(screen: screen, allow: false) } } }
                            .buttonStyle(.glass)
                        Button {
                            confirming = true
                        } label: {
                            Text("Let it…").fontWeight(.semibold).foregroundStyle(Prominent.label())
                        }
                        .buttonStyle(.glassProminent)
                    }
                }
            } else {
                Text("This device can't answer (it has no fleet:admin scope).").font(.footnote).foregroundStyle(.secondary)
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        }
        .inboxSwipe(screen.state == "allowed" ? "End now" : "Not now", systemImage: screen.state == "allowed" ? "stop.fill" : "xmark", when: session.can("fleet:admin")) {
            Task {
                await act {
                    if screen.state == "allowed" { try await session.end(screen: screen) } else { try await session.decide(screen: screen, allow: false) }
                }
            }
        }
        .alert("Let \(Primary.name) use \(screen.nodeName) itself?", isPresented: $confirming) {
            Button("Let it, for \(screen.minutes) minutes") { Task { await act { try await session.decide(screen: screen, allow: true) } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("For \(screen.minutes) minutes from now it sees its screen, uses its apps and runs commands as its user, held to your rules. That account holds the node's keys: let it only for work you want done that way.")
        }
    }

    private func act(_ work: () async throws -> Void) async {
        do {
            try await work()
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// A device asking to join: its name and the code it shows. Let it in only if the codes match.
struct JoinRequestRow: View {
    let session: Session
    let pairing: PairingView
    @State private var confirming = false
    @State private var problem: String?

    var body: some View {
        InboxRow(symbol: pairing.kind == "node" ? "server.rack" : "iphone") {
            VStack(alignment: .leading, spacing: Space.line) {
                Text(pairing.name).font(.headline)
                Text(pairing.kind == "node" ? "A machine" : "A phone or browser").font(.caption).foregroundStyle(.secondary)
            }
            Text(pairing.sas).font(.system(.title, design: .monospaced).weight(.semibold))
            if pairing.conflict {
                Label("Two devices used this invite: it may have been intercepted. Nothing on it can be approved.", systemImage: "exclamationmark.octagon.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.danger)
            } else if session.can("fleet:admin") {
                InboxButtons {
                    Button("Decline", role: .destructive) { Task { await answer(false) } }
                        .buttonStyle(.glass)
                    Button {
                        confirming = true
                    } label: {
                        Text("Let it in…").fontWeight(.semibold).foregroundStyle(Prominent.label())
                    }
                    .buttonStyle(.glassProminent)
                }
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        }
        .inboxSwipe("Decline", when: !pairing.conflict && session.can("fleet:admin")) { Task { await answer(false) } }
        .alert("Let \(pairing.name) in?", isPresented: $confirming) {
            Button("Let it in") { Task { await answer(true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only if its screen shows \(pairing.sas). A different code means someone else holds the invite.")
        }
    }

    private func answer(_ approve: Bool) async {
        do {
            try await session.answer(pairing, approve: approve)
        } catch {
            problem = error.localizedDescription
        }
    }
}
