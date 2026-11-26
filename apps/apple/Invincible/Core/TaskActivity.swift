import Foundation
#if os(iOS)
import ActivityKit
#endif

/*
 * A task's proof on the Lock Screen and in the Dynamic Island (I10, 26 November 2026; core's live-activity.ts). This file
 * is the app's and its widgets' both: how a task stands (`TaskActivityState`, the activity's content-state, as the node
 * says it to Apple and the app to itself), its words, and the activity's attributes.
 */

/// How a task stands on its Live Activity: fixed words and counts only (core's ActivityState, read strictly there).
struct TaskActivityState: Codable, Hashable, Sendable {
    /// queued · running · review · interrupted · ended
    var phase: String
    /// Each gate, in order: waiting · running · passed · failed.
    var gates: [String]
    /// The reviewer: waits · reading · passed · sent-back (nil: none yet, or none to come).
    var review: String?
    /// Once it has ended: proven · reviewed · failed · rejected · gave-up · stopped · unverified.
    var verdict: String?
    /// The gate that failed, counted from 1.
    var gate: Int?
    /// When it was said, in milliseconds since 1970.
    var at: Double

    var ended: Bool { phase == "ended" }
    /// It went wrong: the one thing said in red.
    var failed: Bool { verdict == "failed" || verdict == "rejected" || verdict == "gave-up" }

    private static let verdictWords = ["proven": "Proven", "reviewed": "Reviewed, not proven", "failed": "Failed", "rejected": "Sent back", "gave-up": "Gave up", "stopped": "Stopped", "unverified": "Not verified"]

    /// What its Lock Screen says under its title (the web lib's activityLine).
    var line: String {
        switch phase {
        case "queued": return "Queued"
        case "interrupted": return "Interrupted: it needs you"
        case "review": return "The reviewer is reading it"
        case "running":
            if let at = gates.firstIndex(of: "running") { return "Gate \(at + 1) of \(gates.count)" }
            return review == "sent-back" ? "Back to the work" : "Working"
        default:
            if verdict == "failed", let gate { return "Failed · gate \(gate)" }
            return Self.verdictWords[verdict ?? ""] ?? "Ended"
        }
    }

    /// The word its Dynamic Island says beside its orb (the web lib's activityShort).
    var short: String {
        switch phase {
        case "queued": return "Queued"
        case "interrupted": return "Needs you"
        case "review": return "Review"
        case "running": return gates.isEmpty ? "Working" : "\(gates.filter { $0 == "passed" }.count)/\(gates.count)"
        default:
            if verdict == "reviewed" { return "Reviewed" }
            if verdict == "unverified" { return "Unverified" }
            return Self.verdictWords[verdict ?? ""] ?? "Ended"
        }
    }
}

extension TaskActivityState {
    /// How its agent's mark stands beside it, still, as a Live Activity is (MarkState): at work while it runs or is reviewed,
    /// asking you when it was cut short for you, pale while queued; once it ended, its bottom slat red and loose where it
    /// went wrong, else at rest.
    var markState: MarkState {
        switch phase {
        case "queued": .queued
        case "interrupted": .needs
        case "running", "review": .working
        default: failed ? .failed : .done
        }
    }
}

#if os(iOS)
/// A task's Live Activity, as the app starts it: what doesn't change (given on this device: its title never goes to Apple,
/// and the node's pushes carry none) and how it stands.
struct TaskActivityAttributes: ActivityAttributes {
    typealias ContentState = TaskActivityState
    /// The task, by id: a tap opens its thread.
    let task: String
    let title: String
    /// Its agent's name, and its mark: its colour (its light form, "#rrggbb", one of the eight) and its form (0 to 11). One
    /// an app from before the marks started has no form, and its colour is its orb's: it is drawn as a disc of it.
    let agentName: String
    let colour: String
    var form: Int? = nil
}
#endif
