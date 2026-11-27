#if os(macOS)
import AppKit
import SwiftUI
import UserNotifications

/*
 * Invincible on the Mac (docs/MAC.md, M1): the iPhone and iPad app's own views, in a Mac's frame. One main window, the
 * iPad's sidebar and detail; a chat, an agent or a room in a window of its own, each back where it was at the next launch;
 * the places, a new chat and a task for the agents in the menus; Settings; and the agents in the menu bar, which
 * keeps the app running with its windows closed. With M2 it is also the node's manager (This Mac, the first run) and its
 * launcher (MacMain, the app's entry point).
 */
struct InvincibleMacApp: App {
    @NSApplicationDelegateAdaptor(MacDelegate.self) private var delegate
    private let mac = MacApp.shared

    var body: some Scene {
        Window(Primary.name, id: MacApp.main) {
            MacRoot(mac: mac)
        }
        .defaultSize(width: 1180, height: 780)
        .commands { MacCommands(mac: mac) }
        // An `invincible:` link comes here, to joining.
        .handlesExternalEvents(matching: ["invincible"])

        // Build: a workbench with the primary, T3 Code's (docs/BUILD.md).
        Window("Build", id: MacApp.build) {
            MacBuildRoot(mac: mac)
        }
        .defaultSize(width: 1360, height: 860)
        .handlesExternalEvents(matching: [])

        WindowGroup(for: PlaceWindow.self) { $window in
            MacWindowRoot(mac: mac, window: window)
        }
        .defaultSize(width: 760, height: 760)
        .handlesExternalEvents(matching: [])

        Settings {
            MacSettings(mac: mac)
        }

        MenuBarExtra {
            MenuBarAgents(mac: mac)
        } label: {
            MenuBarMark(mac: mac)
        }
        .menuBarExtraStyle(.window)
    }
}

/// What the Mac app's windows, menus and menu bar share: whether this Mac is paired (and with what), the place its main
/// window shows (kept for the next launch), and what a menu asked of it.
@MainActor @Observable final class MacApp {
    static let shared = MacApp()
    /// The main window's id.
    static let main = "main"
    /// The Build window's id (docs/BUILD.md).
    static let build = "build"

    let app = AppModel()
    /// The first run, on a Mac that isn't a node and an app that isn't paired.
    let firstRun = FirstRun()
    /// This Mac as a node.
    let thisMac = ThisMac()
    /// What its agents' VMs need (`invincible sandbox setup`): the first run's step 3, and This Mac's.
    let vmSetup = VMSetup()
    var place: Place = MacApp.keptPlace() {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(place), forKey: Self.placeKey) }
    }
    /// The agents are being given a task (⇧⌘N).
    var giving = false
    /// Search, or ask (⌘K): the palette over the main window.
    var searching = false
    /// A new chat was asked for (⌘N): the primary's message box takes the keys.
    var composerWanted = false
    /// An invite an `invincible:` link handed over, for the join screen.
    var handed: String?
    private var loop: Task<Void, Never>?

    private static let placeKey = "sh.invincible.bot.mac.place"

    var session: Session? {
        if case .paired(let session) = app.phase { session } else { nil }
    }

    private static func keptPlace() -> Place {
        UserDefaults.standard.data(forKey: placeKey).flatMap { try? JSONDecoder().decode(Place.self, from: $0) } ?? .home
    }

    /// Whether the app starts itself as it launches (reads this Mac's device key, reads and may restart This Mac's node,
    /// keeps the live stream open): not while a test hosts it. A test makes its own key, session and node (MacShots), so a
    /// test run never reads the key, the pairing or the node of the Mac it runs on.
    static func startsItself(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment["XCTestConfigurationFilePath"] == nil
    }

    /// Reads this Mac's key, then keeps the node's live stream open while the app runs, windows or not (the menu bar shows
    /// the agents), and reads this Mac's own node again (the sidebar's foot shows it): every 5 s in front, every 15 behind.
    /// A node the app runs is restarted onto a new release once, at launch.
    func run() {
        guard loop == nil else { return }
        app.start()
        if case .unpaired = app.phase { firstRun.active = FirstRun.wanted(paired: false) }
        Task {
            await thisMac.refresh()
            await thisMac.restartIfNewRelease()
        }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                // The node's live stream, open while the app runs (the menu bar shows the agents): nothing is asked of the
                // node while nothing changes.
                if let session = self?.session, !session.liveOn { session.live(true) }
                // Its notifications, while the node tells this Mac (MacNotices): followed on the stream.
                if let session = self?.session { await MacNotices.shared.start(session) }
                await self?.thisMac.refresh()
                try? await Task.sleep(for: .seconds(NSApplication.shared.isActive ? 5 : 15))
            }
        }
    }

    /// Back in front: the chat on screen as the node holds it now (an answer it was watching may have gone on).
    func cameBack() async {
        guard let session else { return }
        await MacNotices.shared.cameBack(session)
        await session.chat.resume(with: session.client)
        if !session.linkUp { await session.refresh() }
    }

    /// A new chat with the primary, in the main window.
    func newChat() {
        guard let session, !session.chat.answering else { return }
        place = .primary
        session.chat.startNew()
        composerWanted = true
    }
}

/// What macOS tells the app: it has started, it is in front again, and a notification is shown or answered. Closing its
/// last window leaves it in the menu bar.
final class MacDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        // An approval's Approve… and Decline, a task's Ship it…, as the iPhone's (NoticeAnswers).
        NoticeAnswers.register()
        guard MacApp.startsItself() else { return }
        MacApp.shared.run()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await MacApp.shared.cameBack() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// While the app is in front a notification still shows, but one about what its main window shows now only in the list.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let showing = await MainActor.run { MacNotices.shared.showing }
        return NoticeAnswers.options(notification.request.content.userInfo, showing: showing)
    }

    /// Approve…: the main window, at the approval's card, its yes behind Touch ID or the Mac's password. Decline: answered
    /// there, signed by this Mac's key. Ship it…: the task, its ship behind the same check. Anything else: where it says.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let destination = await NoticeAnswers.answer(response) else { return }
        await MainActor.run { MacNotices.shared.opened = destination }
    }
}

/// The main window: joining until this Mac is in the fleet, the app itself after.
struct MacRoot: View {
    let mac: MacApp

    var body: some View {
        Group {
            if mac.firstRun.active {
                FirstRunView(mac: mac, run: mac.firstRun)
            } else {
                switch mac.app.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .unpaired where NodeHome.standard.exists:
                    LocalNodeOpen(mac: mac, run: mac.firstRun)
                case .unpaired:
                    JoinView(app: mac.app, handed: mac.handed)
                        .frame(maxWidth: 600)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .paired(let session):
                    MacPlaces(mac: mac, session: session)
                case .broken(let why):
                    KeyUnreadable(why: why) { mac.app.start() }
                }
            }
        }
        .frame(minWidth: 820, minHeight: 560)
        .tint(.ink)
        .formStyle(.grouped)
        .onOpenURL { url in
            if let link = Joining.handed(url) { mac.handed = link }
        }
    }
}

/// A window of its own: a chat, an agent or a room, while this Mac is paired.
struct MacWindowRoot: View {
    let mac: MacApp
    let window: PlaceWindow?

    var body: some View {
        Group {
            if let session = mac.session, let window {
                PlaceWindowView(session: session, window: window)
            } else {
                ContentUnavailableView("Not in a fleet", systemImage: "person.2.slash", description: Text("Join your fleet in Invincible's window first."))
            }
        }
        .frame(minWidth: 480, minHeight: 420)
        .tint(.ink)
        .formStyle(.grouped)
    }
}

/// The menus: a new chat, a task for the agents and Search or Ask (⌘K) in File, and Home and the four places in View.
struct MacCommands: Commands {
    let mac: MacApp
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { Updates.shared.check() }
                .disabled(!Updates.shared.canCheck)
        }
        CommandGroup(replacing: .newItem) {
            Button("New Chat") {
                mac.newChat()
                front()
            }
            .keyboardShortcut("n")
            .disabled(mac.session == nil || mac.session?.chat.answering == true)
            Button("Give the agents a Task…") {
                mac.giving = true
                front()
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Search or Ask…") {
                mac.searching = true
                front()
            }
            .keyboardShortcut("k")
            .disabled(mac.session == nil)
            .disabled(mac.session?.can("fleet:admin") != true || mac.session?.rows.isEmpty != false)
            Divider()
            Button("Build with \(Primary.name)") {
                openWindow(id: MacApp.build)
                NSApplication.shared.activate()
            }
            .keyboardShortcut("b", modifiers: [.command, .shift])
            .disabled(mac.session == nil)
        }
        CommandGroup(before: .sidebar) {
            place("Home", .home, "0")
            place(Primary.name, .primary, "1")
            place("Agents", .agents, "2")
            place("Needs you", .inbox, "3")
            place("More", .more, "4")
            Divider()
        }
    }

    private func place(_ name: String, _ place: Place, _ key: KeyEquivalent) -> some View {
        Button(name) {
            mac.place = place
            front()
        }
        .keyboardShortcut(key)
        .disabled(mac.session == nil)
    }

    /// The main window, in front.
    private func front() {
        openWindow(id: MacApp.main)
        NSApplication.shared.activate()
    }
}
#endif
