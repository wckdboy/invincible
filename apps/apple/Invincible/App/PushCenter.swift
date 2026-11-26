#if os(iOS)
import SwiftUI
import UIKit
import UserNotifications

/// The app's side of notifications: iOS's permission (asked only when you turn them on, or from the card's Turn on),
/// Apple's token for this install (which the node keeps as this device's, handed over again at every launch while they're
/// on, since tokens change), whether it can reach this device (for the card), and the notification you tapped, for
/// MainView to follow.
@MainActor @Observable final class PushCenter {
    static let shared = PushCenter()

    /// Which of Apple's push services this build answers to (its provisioning profile says, when it carries one).
    let environment = Push.environment(profile: Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }, simulator: PushCenter.simulator)

    private static var simulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }
    private(set) var token: String?
    /// Where a tapped notification or a link asked to go, until MainView has gone there.
    var opened: Push.Destination?
    /// What the screen shows now (a task, a chat, an agent, the Inbox): a notification about that very thing is told only
    /// in the list while the app is open, never as a banner or a sound.
    var showing: Push.Destination?
    /// What the card on the primary's home and the Inbox says: nothing, Turn on, or Open Settings (Push.reach, at the last look).
    private(set) var reach: Push.Reach = .none
    /// When and through which service this device's were lost (not turned off by you), for the card's words.
    private(set) var lost: (at: Double, service: String)?
    private var waiting: [CheckedContinuation<String, any Error>] = []

    private struct Status: Decodable {
        struct Lost: Decodable { let at: Double; let service: String }
        let subscribed: Bool?
        let lost: Lost?
        let reachable: Int?
        let withdrawn: [String]?
    }
    private struct Kept: Decodable { struct Device: Decodable { let service: String }; let device: Device }

    /// iOS's leave, as it stands (never asked here).
    func permission() async -> Push.Permission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    /// When the app opens or comes back to the front: what was answered elsewhere is taken down here, and while they're on
    /// (or were lost, not turned off by you) Apple's token is handed to the node again, asking nothing; otherwise the card
    /// says how to turn them on. A convenience: a node out of reach leaves things as they were.
    func renew(_ session: Session) async {
        guard let status = try? await session.client.get("/api/notify", as: Status.self), let subscribed = status.subscribed else { return }
        await takeDown(status.withdrawn ?? [])
        let step = Push.reach(permission: await permission(), subscribed: subscribed, lost: status.lost != nil, reachable: status.reachable ?? 1)
        lost = status.lost.map { ($0.at, $0.service) }
        reach = step
        guard step == .renew else { return }
        do {
            try await handOver(session)
            if !subscribed { reach = .none }
        } catch {
            // Apple or the node didn't take it now: the next launch tries again (and the node's own notice says so if none can be reached).
        }
    }

    /// From your tap (the card's Turn on, or More → Notifications; iOS asks, if it hasn't): on, for this device. The push
    /// service it's reached through, by name.
    @discardableResult func turnOn(_ session: Session) async throws -> String {
        let service = try await handOver(session)
        reach = .none
        lost = nil
        return service
    }

    @discardableResult private func handOver(_ session: Session) async throws -> String {
        let token = try await register()
        return try await session.client.post("/api/notify/apple", ["token": token, "environment": environment], as: Kept.self).device.service
    }

    /// The notifications still shown whose matter was answered, dismissed, cleared or lapsed on any device: taken down.
    func takeDown(_ tags: [String]) async {
        guard !tags.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        let shown = await center.deliveredNotifications().map { (id: $0.request.identifier, userInfo: $0.request.content.userInfo) }
        let gone = Push.withdrawn(shown, tags: Set(tags))
        if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: gone) }
    }

    /// Asks you once (iOS's own prompt), then Apple, for this install's token.
    func register() async throws -> String {
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else { throw PushProblem.declined }
        if let token { return token }
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func registered(_ deviceToken: Data) {
        let hex = Push.hex(deviceToken)
        token = hex
        finish(.success(hex))
    }

    func failed(_ error: any Error) { finish(.failure(error)) }

    private func finish(_ result: Result<String, any Error>) {
        let continuations = waiting
        waiting = []
        for continuation in continuations { continuation.resume(with: result) }
    }
}

enum PushProblem: LocalizedError {
    case declined
    case unpaired
    var errorDescription: String? {
        switch self {
        case .declined: "Notifications are off for Invincible in the iPhone's Settings: turn them on there, then here."
        case .unpaired: "This iPhone isn't paired with your node."
        }
    }
}

/// What iOS tells the app about notifications: Apple's token for this install, and a notification shown or tapped.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // An approval from its notification, here and on the Watch: Approve opens the app at its card, the whole request in
        // front of you and a yes behind Face ID there (your word, 25 November 2026: never a yes from the lock screen
        // without the request); Decline is answered where it's told, behind the iPhone's own unlock.
        let approve = UNNotificationAction(identifier: Push.Button.approve, title: "Approve…", options: [.authenticationRequired, .foreground])
        let decline = UNNotificationAction(identifier: Push.Button.decline, title: "Decline", options: [.authenticationRequired, .destructive])
        // A task's work that can be shipped: Ship it opens the app at the task, and asks Face ID before the pull request
        // (X2: behind Face ID as Approve is).
        let ship = UNNotificationAction(identifier: Push.Button.shipIt, title: "Ship it…", options: [.authenticationRequired, .foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: Push.Button.approval, actions: [approve, decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: Push.Button.declineOnly, actions: [decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: Push.Button.ship, actions: [ship], intentIdentifiers: []),
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.registered(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushCenter.shared.failed(error)
    }

    /// While the app is open a notification still shows, as it is often about something other than what is on screen; one
    /// about what the screen shows now is told only in the list (Push.presentation), and news never sounds.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        let destination = Push.destination(userInfo)
        let kind = Push.kind(userInfo)
        let showing = await MainActor.run { PushCenter.shared.showing }
        let told = Push.presentation(destination, kind: kind, showing: showing)
        var options: UNNotificationPresentationOptions = [.list]
        if told.banner { options.insert(.banner) }
        if told.sound { options.insert(.sound) }
        return options
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        // Approve: the app, at the approval's card. Decline: answered there, without opening the app.
        if response.actionIdentifier == Push.Button.approve, let action = Push.action(userInfo) {
            await MainActor.run { PushCenter.shared.opened = .approval(action) }
            return
        }
        if response.actionIdentifier == Push.Button.decline, let action = Push.action(userInfo) {
            await Self.decline(action)
            return
        }
        // Ship it: the app, at the task, its ship asked for behind Face ID there.
        if response.actionIdentifier == Push.Button.shipIt, let task = Push.shipTask(userInfo) {
            await MainActor.run { PushCenter.shared.opened = .ship(task) }
            return
        }
        let destination = Push.destination(userInfo)
        await MainActor.run { PushCenter.shared.opened = destination }
    }

    /// Your no to an action, signed by this device as the Inbox's is; then a word of how it went (a failure says to open
    /// the app, where it still waits). A yes is never given here: Approve opens the app at its card.
    private static func decline(_ action: String) async {
        struct Decision: Encodable { let id: String; let approve: Bool }
        let said: (title: String, body: String)
        do {
            guard let key = try DeviceKey.load(), let node = PairedNode.load(), node.device == key.device else { throw PushProblem.unpaired }
            _ = try await NodeClient(origin: node.origin, signer: key).post("/api/actions/decide", Decision(id: action, approve: false), as: JSONValue.self)
            said = ("Declined", "Nothing was sent.")
        } catch {
            said = ("Not answered", "\(error.localizedDescription) It still waits in your Inbox.")
        }
        let content = UNMutableNotificationContent()
        content.title = said.title
        content.body = said.body
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "answered-\(action)", content: content, trigger: nil))
    }
}
#endif
