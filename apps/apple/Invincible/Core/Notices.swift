import Foundation

/// The node's notices as the PWA's Inbox shows them (apps/web/src/views/inbox.ts): those you haven't dismissed, in the
/// node's order (alerts first, then the newest), each by how much it matters and where it came from (in the words of the
/// PWA's lib/notices.ts, held to them by the vectors).
enum Notices {
    /// Those still open.
    static func open(_ all: [NoticeView]) -> [NoticeView] { all.filter { !$0.dismissed } }

    /// How much it matters, at a glance; a rule of yours that told you, by a bell.
    static func symbol(_ notice: NoticeView) -> String {
        switch notice.severity {
        case "alert": "exclamationmark.octagon.fill"
        case "warn": "exclamationmark.triangle.fill"
        default: notice.source.hasPrefix("rule:") ? "bell.fill" : "info.circle.fill"
        }
    }

    /// Where it came from, as you'd say it: "rule:pushes" is "Your rule pushes".
    static func from(_ source: String) -> String {
        let parts = source.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        if parts.count == 2, !parts[1].isEmpty, let kind = ["rule": "Your rule", "loop": "The loop"][String(parts[0])] { return "\(kind) \(parts[1])" }
        return ["heartbeat": "The heartbeat", "ci": "CI", "compute": "Its compute"][source] ?? source
    }
}
