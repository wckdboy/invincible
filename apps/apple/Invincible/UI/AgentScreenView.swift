import SwiftUI

/**
 * An agent's screen, watched and taken over (the PWA's desktop viewer): a picture of its desktop, asked for about every
 * two seconds while it is on screen and the app is in front, and what you do there. A tap on the picture clicks at that
 * place on the agent's screen; text is typed (and never written to the ledger); a key, an address and scrolling are one
 * press each. Each thing done brings back the screen as it then is.
 */
struct AgentScreenView: View {
    let session: Session
    let of: ScreenOf

    /// Whose screen: an agent's (or its own VM's), by its seat; or a Mac's own, by its node.
    enum ScreenOf {
        case seat(VMSeat)
        case mac(node: String, name: String)

        var name: String {
            switch self {
            case .seat(let seat): seat.name
            case .mac(_, let name): name
            }
        }
    }

    init(session: Session, agent: VMSeat) {
        self.init(session: session, of: .seat(agent))
    }

    init(session: Session, of: ScreenOf) {
        self.session = session
        self.of = of
    }

    private var agent: (name: String, id: String) {
        switch of {
        case .seat(let seat): (seat.name, seat.id)
        case .mac(let node, let name): (name, node)
        }
    }
    @State private var shot: DesktopShot?
    @State private var picture: PlatformImage?
    @State private var status = "Looking…"
    @State private var problem: String?
    @State private var noDesktop = false
    @State private var sending = false
    /// What was asked last: each look or thing done waits for the one before it, so none is dropped.
    @State private var queue: Task<Void, Never>?
    @State private var address = ""
    @State private var typed = ""
    @State private var hidden = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                screen
                Text(status).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if noDesktop {
                    Label("\(agent.name)'s VM has no desktop just now. Make it again with a desktop from a terminal or the PWA: its work in /work stays.", systemImage: "display.trianglebadge.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(Color.danger)
                } else if let problem {
                    VStack(alignment: .leading, spacing: Space.s2) {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
                        Button("Try again") { Task { await act(nil) } }.buttonStyle(.bordered)
                    }
                }
                controls
            }
            .padding(Metrics.margin)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("\(agent.name)'s screen")
        // Its keys and the screen itself are pressed between what you type: they keep the keyboard.
        .holdsKeyboard()
        .inlineTitle()
        .hidingTabBar()
        // Asked again while you're watching, and only then.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                if problem == nil, !noDesktop, !sending { await act(nil) }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var screen: some View {
        GeometryReader { box in
            ZStack {
                RoundedRectangle(cornerRadius: Metrics.innerRadius, style: .continuous).fill(.black.opacity(0.85))
                if let picture {
                    Image(platformImage: picture)
                        .resizable()
                        .interpolation(.medium)
                        .scaledToFit()
                        .accessibilityLabel("\(agent.name)'s screen")
                        .accessibilityHint("A tap clicks at that place on it")
                } else {
                    ProgressView().tint(.white)
                }
            }
            .clipShape(.rect(cornerRadius: Metrics.innerRadius, style: .continuous))
            .contentShape(.rect)
            .onTapGesture(coordinateSpace: .local) { location in
                guard let shot else { return }
                // The picture is drawn to fit the box: the tap is read against where it is drawn.
                let drawn = fitted(width: shot.width, height: shot.height, in: box.size)
                if let point = Desktop.point(tap: location, shown: drawn, screen: (shot.width, shot.height)) {
                    Task { await act(.click(x: point.x, y: point.y)) }
                }
            }
        }
        .aspectRatio(CGFloat(shot?.width ?? 16) / CGFloat(shot?.height ?? 10), contentMode: .fit)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var controls: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            fieldRow {
                TextField("An address to open", text: $address)
                    .keyboard(.url)
                    .capitals(.never)
                    .autocorrectionDisabled()
                    .quietField()
                    .submitLabel(.go)
                    .onSubmit(open)
            } button: {
                Button(action: open) { buttonLabel("Open") }.buttonStyle(.bordered).disabled(Desktop.address(address) == nil)
            }
            fieldRow {
                Group {
                    if hidden {
                        SecureField("Text to type on \(agent.name)'s screen", text: $typed)
                    } else {
                        TextField("Text to type on \(agent.name)'s screen", text: $typed)
                    }
                }
                .capitals(.never)
                .autocorrectionDisabled()
                .quietField()
                .submitLabel(.send)
                .onSubmit(type)
            } button: {
                Button(action: type) { buttonLabel("Type") }.buttonStyle(.bordered).disabled(typed.isEmpty)
            }
            Toggle("Hide what I type", isOn: $hidden).font(.footnote)
            // The keys scroll from one edge of the screen to the other, starting at the page's margin.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.s2) {
                    ForEach(Desktop.keys, id: \.key) { each in
                        Button(each.label) { Task { await act(.key(each.key)) } }.buttonStyle(.bordered).controlSize(.small)
                    }
                    Button { Task { await act(.scroll(up: true, times: 3)) } } label: { Label("Scroll up", systemImage: "arrow.up") }
                        .buttonStyle(.bordered).controlSize(.small)
                    Button { Task { await act(.scroll(up: false, times: 3)) } } label: { Label("Scroll down", systemImage: "arrow.down") }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            .contentMargins(.horizontal, Metrics.margin, for: .scrollContent)
            .padding(.horizontal, -Metrics.margin)
            .disabled(shot == nil)
            Text("What you type goes to \(agent.name)'s screen and nowhere else: it isn't kept here, and the ledger says only that something was typed.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// A field and the button that sends what's in it: as tall as each other, and the buttons of every row as wide, so the
    /// fields end at one edge.
    private func fieldRow(@ViewBuilder field: () -> some View, @ViewBuilder button: () -> some View) -> some View {
        HStack(spacing: Space.s2) {
            field()
            button()
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func buttonLabel(_ words: String) -> some View {
        Text(words).frame(minWidth: Space.s10 + Space.s2, maxHeight: .infinity)
    }

    private func open() {
        guard let where_ = Desktop.address(address) else { return }
        Task { await act(.open(where_)) }
    }

    private func type() {
        let text = typed
        typed = ""
        guard !text.isEmpty else { return }
        Task { await act(.type(text)) }
    }

    /// One look, or one thing done and then the screen as it is: in turn, never two at once, and never dropped.
    private func act(_ action: DesktopAction?) async {
        let before = queue
        let turn = Task { @MainActor in
            await before?.value
            await send(action)
        }
        queue = turn
        await turn.value
    }

    private func send(_ action: DesktopAction?) async {
        sending = true
        defer { sending = false }
        if action != nil { status = "Sending…" }
        struct Ask: Encodable { let id: String; let action: DesktopAction? }
        struct OnMac: Encodable { let on: String; let action: DesktopAction? }
        do {
            let next: DesktopShot = switch of {
            case .seat(let seat): try await session.client.post("/api/team/desktop", Ask(id: seat.id, action: action), as: DesktopShot.self)
            case .mac(let node, _): try await session.client.post("/api/screen/desktop", OnMac(on: node, action: action), as: DesktopShot.self)
            }
            guard let data = Desktop.picture(next), let image = PlatformImage(data: data) else {
                problem = "The desktop sent a picture this app doesn't show."
                return
            }
            (shot, picture, problem, noDesktop) = (next, image, nil, false)
            status = "Seen just now · \(next.width)×\(next.height)"
        } catch {
            // Nothing more is asked until you ask: a refusal is said once, not every two seconds.
            if Desktop.saysNoDesktop(error) { noDesktop = true } else { problem = error.localizedDescription }
            status = shot == nil ? "Not seen" : "As it was last seen"
        }
    }

    /// Where a picture of this size is drawn when fitted into the box.
    private func fitted(width: Int, height: Int, in size: CGSize) -> CGRect {
        let scale = min(size.width / CGFloat(width), size.height / CGFloat(height))
        let drawn = CGSize(width: CGFloat(width) * scale, height: CGFloat(height) * scale)
        return CGRect(origin: CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2), size: drawn)
    }
}
