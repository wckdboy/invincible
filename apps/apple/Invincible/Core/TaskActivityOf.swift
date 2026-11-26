import Foundation

extension TaskActivityState {
    /// How a task stands on its Live Activity, from the task and its trail (the web lib's activityOf, held to it by the
    /// vectors' liveActivities): what the app says to its own activity while it is in front.
    static func of(status: String, verified: Bool, error: String?, gates commands: [String], record: TeamTask.Record?, entries: [TrailEntry], at: Double) -> TaskActivityState {
        let proof = Steps.proof(status: status, gates: commands, entries)
        let recorded = Steps.facts(record: record)
        let facts = !entries.isEmpty ? Steps.facts(proof) : recorded ?? Steps.facts(proof)
        let said = Steps.verdict(status: status, verified: verified, error: error, record: record, facts: facts)
        // Each gate as its trail has it; where there is none, as its record does (an exit of 0 passed, any other failed).
        let gates = Array((!entries.isEmpty || recorded == nil ? proof.gates.map(\.state.rawValue) : facts.gates.map { $0.exit == nil ? "waiting" : $0.exit == 0 ? "passed" : "failed" }).prefix(16))
        let review: String? = switch proof.reviewer {
        case "passed": "passed"
        case "sent back": "sent-back"
        case "reading": "reading"
        case "waits": "waits"
        default: facts.review == "pass" ? "passed" : facts.review == "revise" ? "sent-back" : nil
        }
        if let said {
            let failing = facts.gates.firstIndex { $0.exit != nil && $0.exit != 0 }
            let gate = said.verdict == .failed ? failing.flatMap { $0 < gates.count ? $0 + 1 : nil } : nil
            return TaskActivityState(phase: "ended", gates: gates, review: review == "reading" || review == "waits" ? nil : review, verdict: said.verdict.rawValue, gate: gate, at: at)
        }
        let phase = status == "queued" ? "queued" : status == "interrupted" ? "interrupted" : proof.reviewer == "reading" ? "review" : "running"
        return TaskActivityState(phase: phase, gates: gates, review: phase == "queued" ? nil : review, verdict: nil, gate: nil, at: at)
    }
}
