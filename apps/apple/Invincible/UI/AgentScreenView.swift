import SwiftUI

/**
 * An agent's screen, watched and taken over (the PWA's desktop viewer).
 * - An agent's VM: live, the node's stream of its screen (DesktopLive) while it is on screen and the app is in front;
 *   a stream that ends is watched again a little later each time, and after a few tries in a row, or a refusal, it gives
 *   way to the picture.
 * - The picture: a Mac's own screen, or a VM's where it isn't live, asked for about every two seconds.
 * - What you do there: a tap clicks at that place on its screen; text is typed (and never written to the ledger); a key,
 *   an address and scrolling are one press each. While it is live, a thing done brings back no picture (the stream shows
 *   it); otherwise each brings back the screen as it then is.
 * - Your take-over (a VM's): your input takes the desktop over if no one has it, as Take over does; while you have it,
 *   the agent's own desktop commands wait. The row says until when, and changes when the node says so, and once at the
 *   end: nothing counts down.
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
    /// A VM's screen live, and how it stands: drawing now; its last frame what the box shows (between one stream and the
    /// next too, until it is given up); or given up for the picture (and why, when it was tried).
    @State private var live = DesktopLive()
    @State private var watching = false
    @State private var drawn = false
    @State private var pictures = false
    @State private var liveNote: String?
    /// Your take-over as the node said it last, and when it ends by this device's clock (ms).
    @State private var held: DesktopHold?
    @State private var heldEnds: Double?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                screen
                Text(status).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if case .seat = of {
                    // (There from the first frame: nothing moves when the node first says whether you have it.)
                    HStack(spacing: Space.s3) {
                        Text(holdLine).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                        Button(held == nil ? "Take over" : "Give back") { Task { await hold(held == nil) } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                if let liveNote {
                    Label(liveNote, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
                }
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
        // Asked again while you're watching, and only then (and not while it is live).
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                if problem == nil, !noDesktop, !sending, !watching { await act(nil) }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        // A VM's screen live while you're watching.
        .task(id: scenePhase == .active) { await watch() }
        // Your take-over ends by itself when nothing more is done there: said once, when it does.
        .task(id: heldEnds) {
            guard let heldEnds else { return }
            try? await Task.sleep(for: .milliseconds(max(0, heldEnds - Date.now.timeIntervalSince1970 * 1000)))
            if !Task.isCancelled { (held, self.heldEnds) = (nil, nil) }
        }
    }

    private var holdLine: String {
        guard let heldEnds else { return "While you have it, \(agent.name)'s own desktop commands wait." }
        let at = Date(timeIntervalSince1970: heldEnds / 1000).formatted(date: .omitted, time: .shortened)
        return "You have it until \(at). \(agent.name)'s desktop commands wait."
    }

    /// The size of what the box shows, in the screen's own pixels: the stream's while its frame is drawn, else the picture's.
    private var shown: (width: Int, height: Int)? {
        if drawn, let size = live.size { return size }
        return shot.map { (width: $0.width, height: $0.height) }
    }

    private var screen: some View {
        GeometryReader { box in
            ZStack {
                RoundedRectangle(cornerRadius: Metrics.innerRadius, style: .continuous).fill(.black.opacity(0.85))
                if let picture, !drawn {
                    Image(platformImage: picture)
                        .resizable()
                        .interpolation(.medium)
                        .scaledToFit()
                        .accessibilityLabel("\(agent.name)'s screen")
                        .accessibilityHint("A tap clicks at that place on it")
                } else if !drawn {
                    ProgressView().tint(.white)
                }
                // The live screen, in the same place: its layer fits it to the box as the picture is fitted.
                DesktopLiveScreen(live: live)
                    .opacity(drawn ? 1 : 0)
                    .allowsHitTesting(false)
                    .accessibilityLabel("\(agent.name)'s screen, live")
                    .accessibilityHint("A tap clicks at that place on it")
                    .accessibilityHidden(!drawn)
            }
            .clipShape(.rect(cornerRadius: Metrics.innerRadius, style: .continuous))
            .contentShape(.rect)
            .onTapGesture(coordinateSpace: .local) { location in
                guard let screen = shown else { return }
                // What is shown is drawn to fit the box: the tap is read against where it is drawn.
                let area = fitted(width: screen.width, height: screen.height, in: box.size)
                if let point = Desktop.point(tap: location, shown: area, screen: screen) {
                    Task { await act(.click(x: point.x, y: point.y)) }
                }
            }
        }
        .aspectRatio(CGFloat(shown?.width ?? 16) / CGFloat(shown?.height ?? 10), contentMode: .fit)
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
            .disabled(shown == nil)
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
        if action != nil, !watching { status = "Sending…" }
        struct Ask: Encodable { let id: String; let action: DesktopAction?; var picture: Bool? = nil }
        struct OnMac: Encodable { let on: String; let action: DesktopAction? }
        do {
            // Live, nothing comes back but whether you have it: the stream shows what was done.
            if watching, case .seat(let seat) = of {
                let done = try await session.client.post("/api/team/desktop", Ask(id: seat.id, action: action, picture: false), as: DesktopDone.self)
                heard(done.held)
                problem = nil
                return
            }
            let next: DesktopShot = switch of {
            case .seat(let seat): try await session.client.post("/api/team/desktop", Ask(id: seat.id, action: action), as: DesktopShot.self)
            case .mac(let node, _): try await session.client.post("/api/screen/desktop", OnMac(on: node, action: action), as: DesktopShot.self)
            }
            guard let data = Desktop.picture(next), let image = PlatformImage(data: data) else {
                problem = "The desktop sent a picture this app doesn't show."
                return
            }
            (shot, picture, problem, noDesktop) = (next, image, nil, false)
            if case .seat = of { heard(next.held) }
            // (A picture that comes back while it is live isn't shown over it.)
            if !watching { status = "Seen just now · \(next.width)×\(next.height)" }
        } catch {
            // Nothing more is asked until you ask: a refusal is said once, not every two seconds.
            if Desktop.saysNoDesktop(error) { noDesktop = true } else { problem = error.localizedDescription }
            status = shot == nil ? "Not seen" : "As it was last seen"
        }
    }

    /// A VM's screen live, watched again a little later each time it ends; given up for the picture after a few ends in a
    /// row (said), or at once when the node refuses it (an older node, a VM with no stream: nothing to say).
    private func watch() async {
        guard scenePhase == .active, case .seat(let seat) = of, !pictures else { return }
        struct Watch: Encodable { let id: String }
        var tries = 0
        while !Task.isCancelled, !pictures {
            var refused = false
            do {
                for try await frame in session.client.frames("/api/team/desktop/stream", Watch(id: seat.id)) {
                    try await live.show(frame)
                    if live.live, !watching, let size = live.size {
                        (watching, drawn, tries, problem, noDesktop) = (true, true, 0, nil, false)
                        status = "Live · \(size.width)×\(size.height)"
                    }
                }
            } catch {
                // A refusal (an older node, a VM with no stream) isn't mended by asking again.
                if let refusal = error as? NodeError, !refusal.unreachable, (400..<500).contains(refusal.status) || refusal.status == 501 { refused = true }
            }
            await live.ended()
            if watching {
                watching = false
                status = "As it was last seen"
            }
            if Task.isCancelled { return }
            tries += 1
            if refused || tries >= DesktopStream.liveTries {
                (pictures, drawn) = (true, false)
                if !refused { liveNote = "The live picture of \(agent.name)'s screen isn't coming through, so it is shown every two seconds instead." }
                return
            }
            try? await Task.sleep(for: .milliseconds(DesktopStream.againIn(tries)))
        }
    }

    /// You take the desktop over, or give it back: whether you have it after, as the node says.
    private func hold(_ take: Bool) async {
        guard case .seat(let seat) = of else { return }
        struct Who: Encodable { let id: String }
        struct Held: Decodable { let held: DesktopHold? }
        do {
            let answer = try await session.client.post(take ? "/api/team/desktop/take" : "/api/team/desktop/release", Who(id: seat.id), as: Held.self)
            heard(answer.held)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    /// What the node said of your take-over, and when it ends by this device's clock.
    private func heard(_ next: DesktopHold?) {
        held = next
        heldEnds = next.map { $0.ends(said: Date.now.timeIntervalSince1970 * 1000) }
    }

    /// Where a picture of this size is drawn when fitted into the box.
    private func fitted(width: Int, height: Int, in size: CGSize) -> CGRect {
        let scale = min(size.width / CGFloat(width), size.height / CGFloat(height))
        let drawn = CGSize(width: CGFloat(width) * scale, height: CGFloat(height) * scale)
        return CGRect(origin: CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2), size: drawn)
    }
}
