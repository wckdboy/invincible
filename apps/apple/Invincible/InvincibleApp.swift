#if os(iOS)
import SwiftUI
import UIKit

@main
struct InvincibleApp: App {
    /// Apple's token for notifications, and the notification you tapped (PushCenter).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    /// Whether this device is paired, and with what: one for every window (an iPad has several).
    @State private var app = AppModel()
    /// The main window's group, which New Window opens another of.
    static let main = "main"

    init() {
        // A count of what needs you is in the primary's red, as everything that needs you is.
        UITabBarItem.appearance().badgeColor = UIColor(named: "Danger")
    }

    var body: some Scene {
        WindowGroup(id: Self.main) {
            RootView(app: app)
        }
        .commands { PadCommands() }
        // A chat, an agent or a room in a window of its own (an iPad's).
        WindowGroup(for: PlaceWindow.self) { $window in
            PlaceWindowRoot(app: app, window: window)
        }
    }
}
#endif
