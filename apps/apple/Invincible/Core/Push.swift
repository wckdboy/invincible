import Foundation

/// The iPhone app's notifications, as data: which of Apple's push services this build answers to, Apple's token as the
/// node takes it, and where a tap leads. The node sends them (packages/node/src/apns-send.ts); what a payload may open
/// is core's fixed list (notify-payload.ts), and anything else opens the Inbox.
enum Push {
    /// The service this build's tokens are for. A build from Xcode carries its provisioning profile, which names it
    /// (`development`; an ad hoc build's, `production`). A build from TestFlight or the App Store carries none: Apple takes
    /// it out, and its tokens are `production`'s. The simulator carries none either, and its tokens are `development`'s.
    /// (A TestFlight build once said `development` here, so its node asked the wrong service and dropped the iPhone.)
    static func environment(profile: Data?, simulator: Bool) -> String {
        guard let profile else { return simulator ? "development" : "production" }
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              entitlements["aps-environment"] as? String == "production"
        else { return "development" }
        return "production"
    }

    /// Apple's token for this install, as the node takes it: lowercase hex.
    static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }

    enum Destination: Equatable, Sendable {
        case inbox
        /// The primary's chat: the kept one named, or its latest.
        case chat(String?)
        case overview
        case settings
        /// An approval's card, in full, from its notification's Approve: a yes is given only with the request in front of
        /// you, and behind Face ID (your word, 25 November 2026).
        case approval(String)
    }

    /// iOS's leave to show notifications, as core's notifyReach takes it.
    enum Permission: String, Sendable {
        case granted, denied, undetermined
    }

    /// What the app does about its notifications when it opens (core's notifyReach, held to the vectors): hand Apple's
    /// token to the node again, asking nothing (Apple's advice: tokens change); a card with Turn on; a card with Open
    /// Settings; or nothing.
    enum Reach: String, Equatable, Sendable {
        case renew
        case turnOn = "turn-on"
        case settings
        case none
    }

    static func reach(permission: Permission, subscribed: Bool, lost: Bool, reachable: Int, localOn: Bool = false) -> Reach {
        if subscribed || lost { return permission == .granted ? .renew : permission == .denied ? .settings : .turnOn }
        if reachable > 0 && !localOn { return .none }
        return permission == .denied ? .settings : .turnOn
    }

    /// A delivered notification's tag, as the node wrote it (ours: `invincible.tag`), or nil.
    static func tag(_ userInfo: [AnyHashable: Any]) -> String? {
        guard let ours = userInfo["invincible"] as? [String: Any], (ours["v"] as? Int) == 1, let tag = ours["tag"] as? String,
              tag.range(of: #"^[A-Za-z0-9._:-]{1,64}$"#, options: .regularExpression) != nil
        else { return nil }
        return tag
    }

    /// Of the notifications still shown, those whose matter was answered, dismissed, cleared or lapsed on any device (the
    /// node's `withdrawn`): their identifiers, to take down.
    static func withdrawn(_ delivered: [(id: String, userInfo: [AnyHashable: Any])], tags: Set<String>) -> [String] {
        delivered.compactMap { note in tag(note.userInfo).flatMap { tags.contains($0) ? note.id : nil } }
    }

    /// "They were on until 18 Nov: Apple's push service stopped taking them." (the web app's lostLine).
    static func lostLine(at: Double, service: String) -> String {
        let day = Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.day().month(.abbreviated).locale(Locale(identifier: "en_GB")))
        let who = service == "a push service you allowed" ? "the push service you allowed" : "\(service)'s push service"
        return "They were on until \(day): \(who) stopped taking them."
    }

    /// Where a tapped notification opens: ours names one of the node's fixed places; anything else opens the Inbox.
    /// The buttons an approval's notification shows (the node names one in its push: apns-send.ts APPLE_CATEGORY), and on
    /// the Watch too: Approve and Decline, or Decline alone for a delete, which is approved only where its name is typed.
    enum Button {
        static let approval = "approval"
        static let declineOnly = "approval-decline"
        static let approve = "approve"
        static let decline = "decline"
    }

    /// The action an approval's notification is about (the outbox's own id), or nil: read strictly, as the node writes it.
    static func action(_ userInfo: [AnyHashable: Any]) -> String? {
        guard let ours = userInfo["invincible"] as? [String: Any], (ours["v"] as? Int) == 1, ours["kind"] as? String == "approval",
              let id = ours["action"] as? String, id.range(of: #"^a_[A-Za-z0-9_-]{22}$"#, options: .regularExpression) != nil
        else { return nil }
        return id
    }

    static func destination(_ userInfo: [AnyHashable: Any]) -> Destination {
        guard let ours = userInfo["invincible"] as? [String: Any], (ours["v"] as? Int) == 1 else { return .inbox }
        switch ours["open"] as? String {
        case "chat":
            let id = ours["conversation"] as? String
            return .chat(id.flatMap { $0.range(of: #"^cv_[A-Za-z0-9_-]{22}$"#, options: .regularExpression) != nil ? $0 : nil })
        case "overview": return .overview
        case "settings": return .settings
        default: return .inbox
        }
    }
}
