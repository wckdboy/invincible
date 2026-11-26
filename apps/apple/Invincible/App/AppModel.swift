import Foundation
import Observation

/// The node this device paired with, kept in the app's defaults. Nothing in it is secret: the key is in the Keychain.
struct PairedNode: Codable, Equatable, Sendable {
    /// Where the app reaches the node: the address the invite link was made for.
    var origin: URL
    var device: String
    /// What this device is called in the fleet.
    var name: String
    var fleet: String
    var nodeName: String?
    var fleetName: String?

    private static let key = "sh.invincible.bot.paired-node"

    static func load(from defaults: UserDefaults = .standard) -> PairedNode? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(PairedNode.self, from: $0) }
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(self), forKey: Self.key)
    }

    static func forget(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}

/// Whether this device is paired, and with what: the app's one piece of state that outlives a launch (with, on an iPhone
/// or an iPad, the last team it saw: KeptTable).
@MainActor @Observable final class AppModel {
    enum Phase {
        case loading
        case unpaired
        case paired(Session)
        /// The Keychain couldn't be read: never taken for "no key", which would invite pairing over it.
        case broken(String)
    }

    private(set) var phase = Phase.loading
    /// The windows in front: the node's live stream is open while any is (keepFresh).
    @ObservationIgnored private var inFront = 0

    /// Started at once, so the first frame is the app itself (Home, from what was kept), never a spinner first.
    init(startNow: Bool = false) {
        if startNow { start() }
    }

    func start() {
        // (Each window starts it: the first that finds this device paired is the one.)
        if case .paired = phase { return }
        do {
            let key = try DeviceKey.load()
            Self.mark("key read")
            guard let key, let node = PairedNode.load(), node.device == key.device else {
                // (A team kept for a pairing that's gone goes with it.)
                KeptTable.Store.here?.forget()
                phase = .unpaired
                return
            }
            let store = KeptTable.Store.here
            let kept = store?.load(for: node)
            Self.mark("kept read")
            phase = .paired(Session(key: key, node: node, kept: kept, keeping: store))
            Self.mark("session made")
        } catch {
            phase = .broken(error.localizedDescription)
        }
    }

    func paired(key: DeviceKey, node: PairedNode) {
        node.save()
        // Another pairing's kept team goes: what is kept from now is this one's.
        KeptTable.Store.here?.forget()
        phase = .paired(Session(key: key, node: node, keeping: KeptTable.Store.here))
    }

    /// Keeps up with the node while the window that called it is in front: its live stream open for every window that is
    /// (Session.live), and nothing asked while nothing changes. Returns when this one leaves the front (its task is
    /// cancelled); the stream closes with the last.
    func keepFresh(_ session: Session) async {
        Self.mark("live start")
        inFront += 1
        if inFront == 1 { session.live(true) }
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        inFront -= 1
        if inFront == 0 { session.live(false) }
    }

    /// A moment of the launch, for the performance suite (an iPhone's and an iPad's; nothing unless it is measuring).
    private static func mark(_ what: StaticString) {
        #if os(iOS)
        PerfProbe.shared.mark(what)
        #endif
    }

    /// Deletes this device's key. It can't be recovered: pairing again makes a new device, and the old one stays in
    /// the fleet's list until it is revoked there.
    func forget() throws {
        try DeviceKey.delete()
        PairedNode.forget()
        // The agents this device kept goes with the node, after any write still under way, and none is kept after.
        if case .paired(let session) = phase { session.stopKeeping() }
        KeptTable.Store.here?.forget()
        phase = .unpaired
    }
}
