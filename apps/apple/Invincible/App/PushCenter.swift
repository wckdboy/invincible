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
        await NoticeAnswers.takeDown(tags)
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
    var errorDescription: String? {
        switch self {
        case .declined: "Notifications are off for Invincible in the iPhone's Settings: turn them on there, then here."
        }
    }
}

/// What iOS tells the app about notifications: Apple's token for this install, and a notification shown or tapped.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // An approval from its notification, here and on the Watch: Approve opens the app at its card, the whole request in
        // front of you and a yes behind Face ID there; Decline is answered where it's told, behind the iPhone's own unlock.
        // A task's work that can be shipped: Ship it opens the app at the task, its ship behind Face ID (NoticeAnswers).
        NoticeAnswers.register()
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
        let showing = await MainActor.run { PushCenter.shared.showing }
        return NoticeAnswers.options(notification.request.content.userInfo, showing: showing)
    }

    /// Approve: the app, at the approval's card. Decline: answered there, without opening the app. Ship it: the app, at the
    /// task, its ship asked for behind Face ID there. Anything else: where it says (NoticeAnswers.answer).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let destination = await NoticeAnswers.answer(response) else { return }
        await MainActor.run { PushCenter.shared.opened = destination }
    }
}
#endif
