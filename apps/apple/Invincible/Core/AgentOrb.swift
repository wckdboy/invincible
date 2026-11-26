import Foundation

/*
 * An agent as an orb (core's avatar.ts, held to it by the vectors; your word, 25 November 2026: "drop the agent avatars,
 * and just use custom/procedurally generated colored particle orbs"): a sphere of glyphs in a colour of its own, the one
 * you chose for it or one of 24 its handle picks, the same on every device, moving as its work goes. Its colours are
 * here; its sphere is OrbSphere.swift's, and AgentFace draws it. What an agent is doing (core's taskStep and
 * avatarExpression) is here too: its orb's mood comes from it (Orb.Mood(expression:)). A look from the drawings (a saved
 * profile of v 1) colours nothing any more.
 */
enum AgentOrb {
    /// The 24 colours an agent's orb is, when you chose none for it (core's AGENT_TINTS): OKLCH lightness 0.76 and chroma
    /// 0.15 (less where a screen can't show it), every 15 degrees round the hue circle from 10.
    static let tints = [
        "#fe879c", "#ff8a83", "#ff8d65", "#f99549", "#ed9e2f", "#dca81c", "#c8b222", "#afbc3a", "#91c456", "#6eca73", "#41ce90", "#0cceac",
        "#0dcbc3", "#11c8d8", "#04c4ed", "#3abeff", "#6fb6fe", "#8bafff", "#a2a8fe", "#b89ffe", "#ce94f8", "#e08ee5", "#ef89cf", "#fa86b6",
    ]
    /// Each tint's name, as the colour picker says it (core's AGENT_TINT_NAMES).
    static let tintNames = [
        "Rose", "Coral", "Salmon", "Orange", "Amber", "Gold", "Mustard", "Olive", "Lime", "Green", "Jade", "Mint",
        "Teal", "Turquoise", "Cyan", "Sky", "Azure", "Cornflower", "Periwinkle", "Lavender", "Violet", "Orchid", "Pink", "Blush",
    ]

    /// An agent's orb's colours (core's AgentColors): its tint, the tint lit (45 % of the way to white) and in shadow
    /// (52 % of the way to black), a second colour a few of its points are (the tint three to six steps on round the
    /// circle from its own), and whether you chose its tint.
    struct Colors: Equatable, Sendable {
        let tint: String
        let light: String
        let deep: String
        let second: String
        let chosen: Bool
    }

    /// The colour you chose for an agent's orb (core's isOrbProfile: exactly `{ v: 2, color }`, the colour six hex digits),
    /// lowercased; nil for anything else, a look from the drawings among it.
    static func chosenColor(_ profile: JSONValue?) -> String? {
        guard case .object(let p)? = profile, p.count == 2, p["v"] == .number(2), case .string(let color)? = p["color"], isHex(color) else { return nil }
        return color.lowercased()
    }

    /// A colour as six hex digits after a `#`, as the node takes one.
    static func isHex(_ text: String) -> Bool { text.wholeMatch(of: #/#[0-9a-fA-F]{6}/#) != nil }

    /// Each channel `t` of the way from one colour to another (core's blendHex: sRGB as whole numbers, `c + (to - c) * t`,
    /// rounded half up), so every app comes to the same colour.
    static func blend(_ from: String, _ to: String, _ t: Double) -> String {
        "#" + [1, 3, 5].map { at in
            let c = channel(from, at)
            let mixed = Int((c + (channel(to, at) - c) * t).rounded(.toNearestOrAwayFromZero))
            let hex = String(mixed, radix: 16)
            return hex.count < 2 ? "0" + hex : hex
        }.joined()
    }

    /// Which of the 24 tints is nearest a colour (core's nearestTint: by the sum of each channel's difference squared; the
    /// first, on a tie).
    static func nearestTint(_ color: String) -> Int {
        let rgb = { (hex: String) in [1, 3, 5].map { channel(hex, $0) } }
        let mine = rgb(color.lowercased())
        var best = 0, bestApart = Double.infinity
        for (n, tint) in tints.enumerated() {
            let theirs = rgb(tint)
            let apart = (mine[0] - theirs[0]) * (mine[0] - theirs[0]) + (mine[1] - theirs[1]) * (mine[1] - theirs[1]) + (mine[2] - theirs[2]) * (mine[2] - theirs[2])
            if apart < bestApart { (best, bestApart) = (n, apart) }
        }
        return best
    }

    /// An agent's orb's colours (core's agentColors): the colour you chose for it, else the tint its handle picks (its
    /// FNV-1a seed, core's handleSeed, which is Orb.seed), and the second colour its seed picks a few tints on.
    static func colors(id: String, profile: JSONValue?) -> Colors {
        let seed = Orb.seed(id)
        let chosen = chosenColor(profile)
        let at = chosen.map(nearestTint) ?? Int(seed % UInt32(tints.count))
        let tint = chosen ?? tints[at]
        let second = tints[(at + 3 + Int((seed >> 8) % 4)) % tints.count]
        return Colors(tint: tint, light: blend(tint, "#ffffff", 0.45), deep: blend(tint, "#000000", 0.52), second: second, chosen: chosen != nil)
    }

    /// A channel of a six-digit colour, from the hex digits at `at` (as parseInt reads them).
    private static func channel(_ hex: String, _ at: Int) -> Double {
        Double(Int(hex.dropFirst(at).prefix(2), radix: 16) ?? 0)
    }

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

    /// What an agent is doing, as its orb shows it (core's `avatarExpression`): observable work, never a mood.
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
