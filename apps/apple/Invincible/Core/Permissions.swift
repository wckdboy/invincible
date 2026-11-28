import Foundation

/*
 * What Settings' Providers and Permissions show, read-only in this build (the lead's ruling of 28 November 2026; adding
 * and editing come next): your seats (`GET /api/seats`, core's seats.ts SeatView), your rules on the commands the work
 * runs (`GET /api/rules`, core's rules.ts RuleView, worded as the web's lib/rules.ts `ruleParts`), and the hand-offs one
 * node may make to another's agents without asking you (`GET /api/fabric/grants`, core's fabric.ts HandoffGrantView).
 */

/// A seat: an account you hold with a vendor, serving the agents you chose.
struct SeatView: Decodable, Sendable, Identifiable {
    struct State: Decodable, Sendable {
        /// ready, signing-in, resting, signed-out.
        let `is`: String
    }

    let id: String
    let kind: String
    let vendor: String
    let label: String
    let plan: String?
    let state: State
    let runs: Int

    /// Its kind, as the web says it (lib/seats.ts' SEAT_KIND_WORDS).
    var kindWords: String {
        switch kind {
        case "claude-subscription": "Claude plan"
        case "chatgpt-codex", "chatgpt-siwc": "ChatGPT plan"
        case "mistral-vibe": "Mistral plan"
        case "plan": "Coding plan"
        case "api": "API key"
        default: kind
        }
    }

    /// Where it stands, in a few words.
    var stateWords: String {
        switch state.is {
        case "ready": plan.map { "Signed in · \($0)" } ?? "Signed in"
        case "signing-in": "Signing in"
        case "resting": "Spent: back later"
        default: "Signed out"
        }
    }
}

/// A rule of yours on the commands its work runs (a tripwire, a check, one that tells you).
struct RuleView: Decodable, Sendable, Identifiable {
    struct Rule: Decodable, Sendable, Equatable {
        /// halt, refuse, check, tell.
        let does: String
        let words: [String]
        var contains: String? = nil
        var run: String? = nil
    }

    let name: String
    /// nil: a newer node's rule this one doesn't understand (kept, not applied here).
    let rule: Rule?
    let setAt: Double

    var id: String { name }
}

/// A grant in force: one node may hand tasks to another's agents at once, within its terms.
struct HandoffGrantView: Decodable, Sendable, Identifiable {
    struct Node: Decodable, Sendable { let id: String; let name: String }
    struct Terms: Decodable, Sendable {
        let agents: [String]
        var budgetUsdPerDay: Double? = nil
    }

    let from: Node
    let to: Node
    /// nil: written by a newer node, not understood here.
    let terms: Terms?
    let at: Double

    var id: String { "\(from.id)>\(to.id)" }
}

enum Permissions {
    /// What a rule does, and when, in a sentence (the web's lib/rules.ts `ruleParts`, its globs and text as written).
    static func sentence(_ rule: RuleView.Rule) -> String {
        var out: String = switch rule.does {
        case "check": "Runs \(rule.run ?? "") after a command that succeeds, when "
        case "tell": "Tells you when a command has run, when "
        case "halt": "Halts the work when "
        default: "Refuses the command when "
        }
        if !rule.words.isEmpty {
            out += "a word matches "
            for (i, glob) in rule.words.enumerated() {
                if i > 0 { out += i == rule.words.count - 1 ? " or " : ", " }
                out += glob
            }
        }
        if let contains = rule.contains { out += rule.words.isEmpty ? "it holds “\(contains)”" : " and it holds “\(contains)”" }
        return out + "."
    }

    /// A grant's terms in a line: whose agents, and its day's budget.
    static func terms(_ grant: HandoffGrantView) -> String {
        guard let terms = grant.terms else { return "Written by a newer node: not understood here." }
        let agents = terms.agents.isEmpty ? "any of its agents" : terms.agents.joined(separator: ", ")
        let budget = terms.budgetUsdPerDay.map { String(format: " · up to $%.2f a day", $0) } ?? ""
        return "To \(agents)\(budget)"
    }
}
