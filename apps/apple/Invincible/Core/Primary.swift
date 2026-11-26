import Foundation
import Synchronization

/// The primary: the one agent you talk to (docs/ARCHITECTURE.md §1), which plans, remembers and gives the work to the
/// agents. Its handle on the wire is core's TEAM_PRIMARY, a handle no agent can have. Its name is the node's to say, and
/// it is "Invincible" until you name it there (`GET /api/whoami`'s `primaryName`, which a node that names it sends).
/// The app is called Invincible whatever the primary is named: what it says of itself (its notifications, macOS's
/// permissions, a device's name) says "Invincible".
enum Primary {
    /// Its handle in rooms, tasks, messages and seats (core's TEAM_PRIMARY).
    static let handle = "primary"
    /// What it is called until the node names it.
    static let unnamed = "Invincible"

    private static let given = Mutex<String?>(nil)

    /// What it is called: the node's name for it, else "Invincible".
    static var name: String { given.withLock { $0 } ?? unnamed }

    /// The node's word for it, as `whoami` gave it: a name, or none (nil, or nothing but spaces: unnamed).
    static func named(_ name: String?) {
        let name = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        given.withLock { $0 = name?.isEmpty == false ? String(name!.prefix(40)) : nil }
    }
}
