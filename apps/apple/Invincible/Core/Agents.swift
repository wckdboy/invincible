import Foundation

/*
 * Seating and keeping agents and rooms, as the PWA's forms do it (apps/web/src/views/team-forms.ts, lib/team.ts and
 * core's avatar.ts): a new agent's handle from its name, its orb's colour as it is saved, what removing one does, and
 * the shapes the node takes. The node checks everything again; these only say it here first, the PWA's way.
 */

/// `POST /api/team/agents`: an agent as you save it (core's `AgentInput`).
struct AgentInput: Encodable, Sendable, Equatable {
    var id: String
    var name: String
    var instructions: String
    /// Nil clears it: sent as null, never left out, so an emptied field is emptied on the node too.
    var repository: String?
    var harness: String
    var role: String
    /// Its own models, in order, in place of its role's; nil: its role's (sent as null). Sent only when `sendModels`:
    /// a node too old to know them would refuse the field.
    var models: [String]? = nil
    var sendModels = false
    /// Sensitive mode (core's heldModels); nil: left as it is, and not sent (a node too old to know it would refuse it).
    var sensitive: Bool? = nil
    /// The command that starts its ACP agent in its VM (harness `acp`); nil: left as it is, and not sent.
    var acp: String? = nil
    /// Keys of yours it may use but never see; nil: none (sent as null). Sent only when `sendKeys`.
    var keys: [Agent.KeyGrant]? = nil
    var sendKeys = false
    var enabled: Bool
    var dailyTurns: Int
    /// Its glass, as you chose it in its form (the PWA's avatarEditor), or its node's choice again; nil, untouched: left
    /// as it is, and not sent (a new agent takes the one its node gives it).
    var avatar: OrbColor? = nil

    /// What you chose for an agent's look: a colour, sent as core's OrbProfile (`{ v: 2, color }`: its node snaps it to
    /// the eight and keeps its shape); its glass, colour and shape (`{ v: 4, color, shape }`, core's GlassProfile); or its
    /// node's choice again, sent as null.
    enum OrbColor: Equatable, Sendable {
        case chosen(String)
        case glass(AgentGlass)
        case handle
    }

    private struct OrbProfile: Encodable {
        var v = 2
        let color: String
    }

    private struct GlassProfile: Encodable {
        var v = 4
        let color: String
        let shape: Int
    }

    enum CodingKeys: String, CodingKey { case id, name, instructions, repository, harness, role, models, sensitive, acp, keys, enabled, dailyTurns, avatar }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(instructions, forKey: .instructions)
        try c.encode(repository, forKey: .repository)
        try c.encode(harness, forKey: .harness)
        try c.encode(role, forKey: .role)
        if sendModels { try c.encode(models, forKey: .models) }
        try c.encodeIfPresent(sensitive, forKey: .sensitive)
        try c.encodeIfPresent(acp, forKey: .acp)
        if sendKeys { try c.encode(keys, forKey: .keys) }
        try c.encode(enabled, forKey: .enabled)
        try c.encode(dailyTurns, forKey: .dailyTurns)
        switch avatar {
        case .chosen(let color)?: try c.encode(OrbProfile(color: color), forKey: .avatar)
        case .glass(let glass)?: try c.encode(GlassProfile(color: AgentMark.palette[glass.color].forms.light, shape: glass.shape), forKey: .avatar)
        case .handle?: try c.encodeNil(forKey: .avatar)
        case nil: break
        }
    }
}

/// `POST /api/team/rooms`: a room as you save it (core's `TeamRoomInput`); `id` and `direct` only when it exists.
struct RoomInput: Encodable, Sendable, Equatable {
    var id: String?
    var name: String
    var members: [String]
    var direct: Bool?
    var turnBudget: Int
}

enum Agents {
    /// The harnesses an agent can work in, as they are named to you (the PWA's HARNESS), in its order.
    static let harnesses: [(id: String, name: String)] = [("native", "Invincible"), ("opencode", "OpenCode"), ("hermes", "Hermes Agent"), ("claude", "Claude Code"), ("codex", "Codex"), ("antigravity", "Antigravity"), ("acp", "Any ACP agent")]

    /// A roster role, as far as an agent's editor needs it (`forAgents` is absent from an older node).
    struct RoleInfo: Decodable, Sendable, Equatable {
        let models: [String]
        let forAgents: Bool?

        init(models: [String], forAgents: Bool?) {
            self.models = models
            self.forAgents = forAgents
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            models = try container.decodeIfPresent([String].self, forKey: .models) ?? []
            forAgents = try container.decodeIfPresent(Bool.self, forKey: .forAgents)
        }

        private enum CodingKeys: String, CodingKey { case models, forAgents }
    }

    private static let builtInRoles = ["engineer", "planner", "reviewer", "swift"]

    /// The roles an agent may be given, engineer first: the roster's that are for agents (the planner, engineer and swift
    /// roles, then yours by name; never the reviewer or a tool's), and the one it has now. An older node says nothing of
    /// which are for agents: then the usual four and every other. The PWA's `agentRoles`.
    static func roles(roster: [String: RoleInfo], current: String?) -> [String] {
        let told = roster.values.contains { $0.forAgents != nil }
        func theirs(_ role: String) -> Bool { !told || roster[role]?.forAgents == true }
        let builtIn = told ? ["engineer", "planner", "swift"].filter { $0 == "engineer" || theirs($0) } : builtInRoles
        let others = roster.keys.filter { !builtInRoles.contains($0) && theirs($0) }.sorted()
        var seen = Set<String>()
        return (builtIn + others + (current.map { [$0] } ?? [])).filter { seen.insert($0).inserted }
    }

    /// What an agent on this role works on, in a line (the PWA's `agentRoleLine`).
    static func roleLine(role: String, spec: RoleInfo?) -> String {
        guard let spec else { return "\(role) isn't on your roster: the engineer's models do its work" }
        if spec.forAgents == false { return "It talks on the \(role)'s models; its tasks' work runs on the engineer's, since the reviewer never does the work it checks" }
        guard let first = spec.models.first else { return "\(role) has no model yet: put one on it on the Models page" }
        let more = spec.models.count > 1 ? " (then \(spec.models.count - 1) more)" : ""
        return "Its work runs on \(first)\(more); its plan and the independent review stay the planner's and the reviewer's"
    }

    /// A model you may set an agent to work on (`GET /api/team/models`): its ref, and the nodes that serve it, when a local runtime does.
    struct ModelChoice: Decodable, Sendable, Hashable, Identifiable {
        let ref: String
        let on: [String]
        var id: String { ref }
    }

    /// The most models of its own an agent works on (core's `AgentModels`).
    static let modelsMax = 8

    /// The models offered as toggles: the ones it works on first, in their order (one the node no longer offers
    /// included, so it can be turned off), then the rest as the node lists them (lib/team.ts' `agentModelChoices`).
    static func modelChoices(_ choices: [ModelChoice], own: [String] = []) -> [ModelChoice] {
        let byRef = Dictionary(choices.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
        return own.map { byRef[$0] ?? ModelChoice(ref: $0, on: []) } + choices.filter { !own.contains($0.ref) }
    }

    /// Its own models with one turned on (last, as it is tried after the others; eight at most) or off (`toggleAgentModel`).
    static func toggle(_ own: [String], _ ref: String, on: Bool) -> [String] {
        if !on { return own.filter { $0 != ref } }
        return own.contains(ref) || own.count >= modelsMax ? own : own + [ref]
    }

    /// What an agent with models of its own works on, in a line; none: its role's (`agentModelsLine`).
    static func modelsLine(own: [String], role: String, spec: RoleInfo?, sensitive: Bool = false) -> String {
        guard let first = own.first else { return "None chosen: it works on its role's models. \(roleLine(role: role, spec: spec))" }
        let more = own.count > 1 ? " (then \(own.count - 1) more, in the order you turned them on)" : ""
        // Sensitive mode (core's heldModels): every call of its work on them, and none elsewhere.
        if sensitive { return "Sensitive mode: every call of its work (its plan, its review, its conversations, its coding tool) runs on \(first)\(more) and nothing else, never a fallback" }
        return "Its work runs on \(first)\(more), in place of its role's; its plan and the independent review stay the planner's and the reviewer's"
    }

    /// What an agent works on, in a word or two: its role, and its own first model when it has some (`agentWorksOn`).
    static func worksOn(role: String, models: [String]?, sensitive: Bool = false) -> String {
        guard let first = models?.first else { return role }
        let name = first.firstIndex(of: "/").map { String(first[first.index(after: $0)...]) } ?? first
        let more = (models?.count ?? 0) > 1 ? " +\((models?.count ?? 0) - 1)" : ""
        return "\(role) · on \(name)\(more)\(sensitive ? " · sensitive mode" : "")"
    }

    /// A new agent's handle, from its name: lowercase letters, digits and hyphens, never a reserved one or one taken
    /// (lib/team.ts' `agentId`). It stays the same when the agent is renamed.
    static func handle(name: String, taken: [String]) -> String {
        let folded = String(String.UnicodeScalarView(name.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
        var cleaned = ""
        var dash = false
        for scalar in folded.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                cleaned.unicodeScalars.append(scalar)
                dash = false
            } else if !dash {
                cleaned += "-"
                dash = true
            }
        }
        cleaned = String(cleaned.drop { $0 == "-" }.reversed().drop { $0 == "-" }.reversed())
        let start = cleaned.first.map { ("a"..."z").contains($0) } == true ? cleaned : "agent-\(cleaned)"
        var base = String(start.prefix(28))
        while base.hasSuffix("-") { base.removeLast() }
        if base.isEmpty { base = "agent" }
        let used = Set(taken + ["owner", "system", "primary"])
        if !used.contains(base) { return base }
        var suffix = 2
        while used.contains("\(base)-\(suffix)") { suffix += 1 }
        return "\(base)-\(suffix)"
    }

    /// A handle as the node takes one: a lowercase letter, then at most 31 lowercase letters, digits or hyphens.
    static func isHandle(_ text: String) -> Bool { text.wholeMatch(of: #/[a-z][a-z0-9\-]{0,31}/#) != nil }

    /// What removing an agent does, said before you do it, and whether its VM goes with it (lib/team.ts' `removalPlan`).
    /// `blocked`: why this device can't (an agent with a VM goes only with it, which takes a device that may manage sandboxes).
    struct Removal: Equatable, Sendable {
        let blocked: String?
        let lines: [String]
        let destroyWorkspace: Bool
    }

    static func removal(id: String, name: String, workspace: Bool, workspaceNode: Bool, maySandbox: Bool) -> Removal {
        let lines = [
            "\(name) leaves every room and does no more work. What \(name) said stays where it was said, and its direct conversations are kept.",
            "The handle \(id) is never used again, so nothing new inherits its history.",
        ]
        if !workspace && !workspaceNode { return Removal(blocked: nil, lines: lines + ["This can't be undone."], destroyWorkspace: false) }
        if !maySandbox { return Removal(blocked: "\(name) has a VM, and removing \(name) destroys it. That takes a device that may manage sandboxes; this one may not.", lines: lines, destroyWorkspace: true) }
        let vm = workspace ? "\(name)'s VM is destroyed with it, and everything in its /work." : "A VM was being made for \(name): if there is one, it is destroyed with it, and everything in its /work."
        return Removal(blocked: nil, lines: lines + ["\(vm) This can't be undone."], destroyWorkspace: true)
    }
}
