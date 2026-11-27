#if os(macOS)
import AppKit
import UserNotifications

/*
 * The Mac's notifications: what the node tells your other devices, told here too while the app runs (its window, or only
 * the agents in the menu bar), as notifications of the Mac's own: no Apple push service, no entitlement. It collects them
 * as the Android app does. Turned on, the node keeps for this Mac what it would send it, by the same rules as every
 * device's (its kinds, quiet hours, the day's limit: POST /api/notify/collect/on), and the Mac takes them
 * (POST /api/notify/collect) when the live stream says `notify` changed, within a look of the node keeping one: nothing is
 * asked on a timer. Coming to the front it takes what was kept and lets it go, as the window shows it all. Each is shown
 * as the iPhone is sent it (NotifyPayload.content), answered as the iPhone answers it (NoticeAnswers), and what was
 * answered on another device is taken down here.
 */
@MainActor @Observable final class MacNotices {
    static let shared = MacNotices()
    /// Whether the node tells this Mac (nil: not read yet).
    private(set) var on: Bool?
    /// What the main window shows, as a notification would name it: one about that very thing is told only in the list.
    var showing: Push.Destination?
    /// Where a tapped notification, or one of its buttons, asked to go, until the main window has gone there.
    var opened: Push.Destination?
    @ObservationIgnored private weak var session: Session?
    @ObservationIgnored private var unfollow: (@MainActor () -> Void)?

    private struct Status: Decodable { let subscribed: Bool? }
    private struct Kept: Decodable { let on: Bool; let notifications: [JSONValue]; let withdrawn: [String] }
    private struct Nothing: Encodable {}

    /// Once paired: whether the node tells this Mac, and while it does, what it keeps followed. What was kept while the app
    /// wasn't running is shown unless the app is in front (then the window shows it). A node that doesn't answer is asked
    /// again at the app's next look (MacApp.run).
    func start(_ session: Session) async {
        guard self.session !== session, let status = try? await session.client.get("/api/notify", as: Status.self), self.session !== session else { return }
        self.session = session
        stopFollowing()
        on = status.subscribed ?? false
        guard on == true else { return }
        follow(session)
        await collect(session, show: !NSApplication.shared.isActive)
    }

    /// From your tap in Settings: macOS's leave (asked once), then the node keeps them for this Mac. How it reaches it.
    @discardableResult func turnOn(_ session: Session) async throws -> String {
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else { throw MacNoticeProblem.declined }
        _ = try await session.client.post("/api/notify/collect/on", Nothing(), as: JSONValue.self)
        on = true
        self.session = session
        follow(session)
        return "This Mac collects them from your node while Invincible runs, its window or the agents in the menu bar."
    }

    /// Turned off here: nothing more is collected.
    func turnedOff() {
        on = false
        stopFollowing()
    }

    /// In front again: what was kept meanwhile is taken and let go (the window shows it all), and what was answered on
    /// another device is taken down.
    func cameBack(_ session: Session) async {
        guard on == true, self.session === session else { return }
        await collect(session, show: false)
    }

    private func follow(_ session: Session) {
        stopFollowing()
        unfollow = session.follow(["notify"], every: nil) { [weak self, weak session] in
            guard let self, let session else { return }
            await self.collect(session, show: true)
        }
    }

    private func stopFollowing() {
        unfollow?()
        unfollow = nil
    }

    /// What the node kept for this Mac, handed over once: each shown (one that doesn't read as ours, as the general one),
    /// and what was answered elsewhere taken down. Its notifications turned off elsewhere, it stops.
    private func collect(_ session: Session, show: Bool) async {
        guard let kept = try? await session.client.post("/api/notify/collect", Nothing(), as: Kept.self) else { return }
        await NoticeAnswers.takeDown(kept.withdrawn)
        guard kept.on else {
            turnedOff()
            return
        }
        guard show else { return }
        let center = UNUserNotificationCenter.current()
        for raw in kept.notifications { try? await center.add((NotifyPayload.read(raw) ?? .generic).request) }
    }
}

enum MacNoticeProblem: LocalizedError {
    case declined
    var errorDescription: String? {
        "Notifications are off for Invincible in System Settings → Notifications: turn them on there, then here."
    }
}
#endif
