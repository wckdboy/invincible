import Foundation

/*
 * What an agent is doing (core's taskStep and avatarExpression, held to them by the vectors): its face's mood comes from it
 * (Orb.Mood(expression:)), and its mark shows that as a state in its shape (AgentMark.swift). Its colour and form are its
 * mark's, no longer an orb's (O2, 26 November 2026).
 */
enum AgentOrb {
    // MARK: What an agent is doing

    /// What a running task's latest line shows (core's `taskStep`): planning is thinking, its desktop is browsing, a
    /// command's output is read, its gates and review are checking; any other is work.
    static func step(_ progress: String) -> String {
        let line = String(progress.drop { $0.isWhitespace })
        if line.hasPrefix("Plan · ") || line.hasPrefix("Thinking · ") { return "thinking" }
        if line.prefixMatch(of: #/Running · desktop(\s|$)/#) != nil { return "browsing" }
        if line.hasPrefix("Running · ") { return "working" }
        if line.prefixMatch(of: #/Exit -?\d+ · /#) != nil { return "reading" }
        let end = String(line.reversed().drop { $0.isWhitespace }.reversed())
        if line.prefixMatch(of: #/(Gate \d+\/\d+ · |Gates · |Gates before the work · |Review · |Submitted for review · )/#) != nil || end.wholeMatch(of: #/gate[sd]/#) != nil {
            return "checking"
        }
        return "working"
    }

    /// What an agent is doing, as its face shows it (core's `avatarExpression`): observable work, never a mood.
    static func expression(of person: Agent, in snapshot: TeamSnapshot, now: Double) -> String {
        let tasks = snapshot.tasks.filter { $0.assignee == person.id }
        let deliveries = snapshot.deliveries.filter { $0.agent == person.id }
        if let running = tasks.first(where: { $0.status == "running" }) { return step(running.progress) }
        if deliveries.contains(where: { $0.status == "running" }) { return "thinking" }
        if !person.enabled { return "resting" }
        let work = tasks.map { ($0.status, $0.updatedAt) } + deliveries.map { ($0.status, $0.updatedAt) }
        if tasks.contains(where: { $0.status == "proposed" }) { return "asking" }
        if work.contains(where: { $0.0 == "queued" }) { return "waiting" }
        let recent = { (at: Double) in now >= at && now - at < 30_000 }
        if work.contains(where: { ($0.0 == "failed" || $0.0 == "interrupted") && recent($0.1) }) { return "concerned" }
        if tasks.contains(where: { $0.status == "done" && $0.verified && recent($0.updatedAt) }) { return "pleased" }
        return "idle"
    }
}
