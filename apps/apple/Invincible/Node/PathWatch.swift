import Foundation
import Network

/// The network under the app (NWPathMonitor), watched while the app is in front: told when it changes in a way that can
/// leave a connection dead without a word (gone, back, or onto another interface: Wi-Fi to cellular). The first look is no
/// change. The node's live stream is then opened afresh at once (Session.networkChanged), never left to time out.
@MainActor
final class PathWatch {
    /// What of a path counts: whether it can reach anything, and over which interfaces.
    struct Seen: Equatable, Sendable {
        let satisfied: Bool
        let interfaces: Set<String>
    }

    /// Whether going from `from` to `to` can have left a connection dead: anything but the first look, and the same again.
    nonisolated static func moved(from: Seen?, to: Seen) -> Bool {
        guard let from else { return false }
        return from != to
    }

    private var monitor: NWPathMonitor?
    private var last: Seen?

    func start(_ changed: @escaping @MainActor () -> Void) {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let seen = Seen(satisfied: path.status == .satisfied, interfaces: Set(path.availableInterfaces.map(\.name)))
            Task { @MainActor in
                guard let self, self.monitor === monitor else { return }
                let moved = Self.moved(from: self.last, to: seen)
                self.last = seen
                if moved { changed() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "sh.invincible.bot.path", qos: .utility))
        self.monitor = monitor
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
        last = nil
    }
}
