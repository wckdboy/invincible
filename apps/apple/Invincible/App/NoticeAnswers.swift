import Foundation
import UserNotifications

/// What a notification does on an iPhone and on a Mac alike, each from its own delegate: the buttons it shows, how it
/// shows while the app is open, and where a tap or a button leads. An approval's Approve… opens the app at its card, where
/// a yes is given with the request in front of you, behind Face ID or Touch ID (your word, 25 November 2026: never a yes
/// from a notification); its Decline is answered where it's told, signed by this device's key; a task's Ship it… opens the
/// task, its ship asked for behind the same check.
enum NoticeAnswers {
    /// The buttons, registered once at launch. The node names one in what it pushes to an iPhone (apns-send.ts
    /// APPLE_CATEGORY), and a Mac names the same one for what it collects (NotifyPayload.category); the Watch shows them too.
    static func register() {
        let approve = UNNotificationAction(identifier: Push.Button.approve, title: "Approve…", options: [.authenticationRequired, .foreground])
        let decline = UNNotificationAction(identifier: Push.Button.decline, title: "Decline", options: [.authenticationRequired, .destructive])
        let ship = UNNotificationAction(identifier: Push.Button.shipIt, title: "Ship it…", options: [.authenticationRequired, .foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: Push.Button.approval, actions: [approve, decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: Push.Button.declineOnly, actions: [decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: Push.Button.ship, actions: [ship], intentIdentifiers: []),
        ])
    }

    /// While the app is open a notification still shows, as it is often about something other than what is on screen; one
    /// about what the screen shows now is told only in the list (Push.presentation), and news never sounds.
    static func options(_ userInfo: [AnyHashable: Any], showing: Push.Destination?) -> UNNotificationPresentationOptions {
        let told = Push.presentation(Push.destination(userInfo), kind: Push.kind(userInfo), showing: showing)
        var options: UNNotificationPresentationOptions = [.list]
        if told.banner { options.insert(.banner) }
        if told.sound { options.insert(.sound) }
        return options
    }

    /// Where a tap, or one of its buttons, leads; nil: Decline, answered here without opening the app.
    static func answer(_ response: UNNotificationResponse) async -> Push.Destination? {
        let userInfo = response.notification.request.content.userInfo
        if response.actionIdentifier == Push.Button.approve, let action = Push.action(userInfo) { return .approval(action) }
        if response.actionIdentifier == Push.Button.decline, let action = Push.action(userInfo) {
            await decline(action)
            return nil
        }
        if response.actionIdentifier == Push.Button.shipIt, let task = Push.shipTask(userInfo) { return .ship(task) }
        return Push.destination(userInfo)
    }

    /// The notifications still shown whose matter was answered, dismissed, cleared or lapsed on any device: taken down.
    static func takeDown(_ tags: [String]) async {
        guard !tags.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        let shown = await center.deliveredNotifications().map { (id: $0.request.identifier, userInfo: $0.request.content.userInfo) }
        let gone = Push.withdrawn(shown, tags: Set(tags))
        if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: gone) }
    }

    /// Your no to an action, signed by this device as the Inbox's is; then a word of how it went (a failure says to open
    /// the app, where it still waits). A yes is never given here: Approve opens the app at its card.
    static func decline(_ action: String) async {
        struct Decision: Encodable { let id: String; let approve: Bool }
        let said: (title: String, body: String)
        do {
            guard let key = try DeviceKey.load(), let node = PairedNode.load(), node.device == key.device else { throw Unpaired() }
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

/// This device isn't paired with the node a notification came from (any more): its Decline can't be signed.
private struct Unpaired: LocalizedError {
    var errorDescription: String? {
        #if os(iOS)
        "This iPhone isn't paired with your node."
        #else
        "This Mac isn't paired with your node."
        #endif
    }
}

extension NotifyPayload {
    /// As a device that collects its notifications shows one (a Mac): what the node sends an iPhone for it (apns-send.ts
    /// applePayload), held to the vectors: its alert, its thread, a sound unless it's news, how it interrupts, its buttons,
    /// and ours, which Push reads. Its tag is its identifier where it shows, so a newer one about the same thing replaces it.
    var content: UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = kind
        content.userInfo = userInfo
        if let category { content.categoryIdentifier = category }
        content.sound = quiet ? nil : .default
        content.interruptionLevel = quiet ? .passive : .active
        return content
    }

    var request: UNNotificationRequest { UNNotificationRequest(identifier: tag, content: content, trigger: nil) }
}
