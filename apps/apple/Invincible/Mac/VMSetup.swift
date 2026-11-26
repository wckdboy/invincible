#if os(macOS)
import Foundation
import Observation
import SwiftUI

/// Giving this Mac its agents' VMs (docs/MAC.md, *Give its agents VMs*), as the first run's step 3 and This Mac do it:
/// the node's own `invincible sandbox setup`, run as this app. It runs with no terminal, so what only root may do (installing
/// Apple's container and the sandbox firewall) is asked for by macOS's own password prompt, once; the rest runs as you.
/// Its JSON lines are read as they come, each a step's state and what it says. `status` reads them changing nothing.
@MainActor @Observable final class VMSetup {
    enum Step: String, CaseIterable, Decodable, Sendable {
        case container, firewall, service, node, image, vm

        var title: String {
            switch self {
            case .container: "Apple's container"
            case .firewall: "The sandbox firewall"
            case .service: "Its service and kernel"
            case .node: "The node"
            case .image: "The sandbox image"
            case .vm: "A VM, to be sure"
            }
        }
    }

    enum State: String, Decodable, Sendable { case done, todo, working, failed, skipped }

    /// A line of `invincible sandbox setup --json`.
    struct Line: Decodable, Equatable, Sendable {
        let step: Step
        let state: State
        let said: String

        /// What it says, as a sentence begins.
        var words: String { said.prefix(1).uppercased() + said.dropFirst() }
    }

    let bundle: NodeBundle
    private(set) var lines: [Step: Line] = [:]
    /// What went wrong that no line says (the CLI didn't run, or ended saying something else).
    private(set) var problem: String?
    private(set) var running = false
    /// Read at least once.
    private(set) var read = false
    /// Shown as given (`show`), not read from this Mac.
    private var given = false

    init(bundle: NodeBundle = .main) { self.bundle = bundle }

    /// Every step holds.
    var holds: Bool { Step.allCases.allSatisfy { lines[$0]?.state == .done } }
    var failed: Bool { lines.values.contains { $0.state == .failed } || problem != nil }

    /// A line the CLI printed, read; nil for anything else it printed.
    nonisolated static func line(_ text: String) -> Line? {
        guard text.hasPrefix("{") else { return nil }
        return try? JSONDecoder().decode(Line.self, from: Data(text.utf8))
    }

    /// What holds and what doesn't, changing nothing (`invincible sandbox setup status`). A build without the node has
    /// nothing to ask, and says so.
    func status() async {
        guard !given, !running else { return }
        guard bundle.carriesNode else {
            (problem, read) = ("This build of Invincible carries no node to set this Mac up with: invincible sandbox setup does it in Terminal.", true)
            return
        }
        await follow(["sandbox", "setup", "status", "--json"])
    }

    /// Everything that doesn't hold, done: once you press Set Up, as you watch.
    func setUp() {
        guard !given, !running, bundle.carriesNode else { return }
        Task { await follow(["sandbox", "setup", "--json"]) }
    }

    /// Runs the CLI, taking its lines in the order it says them, then what its end says.
    private func follow(_ arguments: [String]) async {
        running = true
        problem = nil
        defer { (running, read) = (false, true) }
        let (said, saying) = AsyncStream<Line>.makeStream()
        let bundle = bundle
        let ran = Task.detached { () -> Result<Ran, any Error> in
            defer { saying.finish() }
            do {
                return .success(try await bundle.cli(arguments) { text in
                    if let line = VMSetup.line(text) { saying.yield(line) }
                })
            } catch {
                return .failure(error)
            }
        }
        for await line in said { lines[line.step] = line }
        switch await ran.value {
        case .success(let ended):
            // Ending unwell, every line says why already, unless none did.
            if !ended.succeeded, !lines.values.contains(where: { $0.state == .failed || $0.state == .skipped || $0.state == .todo }) { problem = ended.lastLine }
        case .failure(let error):
            problem = error.localizedDescription
        }
    }

    /// Shown as given rather than read from this Mac: for its pictures (MacShots) and previews.
    func show(_ given: [Line]) {
        lines = Dictionary(given.map { ($0.step, $0) }, uniquingKeysWith: { $1 })
        (read, self.given) = (true, true)
    }
}

/// The steps, each in its row: a tick when it holds, a ring when it doesn't yet, a spinner while it is done, a mark when
/// it failed (it says why), a dash when it waits for another.
struct VMSetupRows: View {
    let setup: VMSetup

    /// What Set Up asks of you, said before you press it.
    static let footer = "Set Up asks for your password once, for what only an administrator may install: Apple's container (its signed release, checked against the one Apple published) and the sandbox firewall. The rest runs as you. Not now is fine: agents work on your other nodes until then."

    var body: some View {
        ForEach(VMSetup.Step.allCases, id: \.self) { step in
            let line = setup.lines[step]
            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                mark(line?.state)
                    .frame(width: Metrics.iconColumn - Space.s1)
                VStack(alignment: .leading, spacing: Space.line) {
                    Text(step.title)
                    Text(line?.words ?? (setup.read ? "" : "Looking…"))
                        .font(.callout)
                        .foregroundStyle(line?.state == .failed ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private func mark(_ state: VMSetup.State?) -> some View {
        switch state {
        case .done?: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Holds")
        case .working?: ProgressView().controlSize(.small).accessibilityLabel("Being done")
        case .failed?: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange).accessibilityLabel("Failed")
        case .skipped?: Image(systemName: "minus.circle").foregroundStyle(.secondary).accessibilityLabel("Waits")
        case .todo?, nil: Image(systemName: "circle").foregroundStyle(.secondary).accessibilityLabel("Not yet")
        }
    }
}
#endif
