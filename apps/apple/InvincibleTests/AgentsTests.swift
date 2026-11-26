import Foundation
import Testing
@testable import Invincible

/// Seating and keeping agents and rooms says what the PWA says (`lib/team.ts`, `lib/roster.ts`, core's `avatar.ts`):
/// checked against their own output.
struct AgentsTests {
    let vectors = Vectors.shared

    @Test func everyRoomsLineAndMarkAreThePWAs() {
        let rows = Roster.roomRows(snapshot: vectors.rooms.snapshot)
        #expect(rows.map(\.id) == vectors.rooms.rows.map(\.id))
        for (row, expected) in zip(rows, vectors.rooms.rows) {
            #expect(row.line == expected.line, "\(row.id)")
            #expect(row.needs == expected.needs, "\(row.id)")
        }
    }

    @Test func anAgentsOwnConversationIsNoRoomOfTheAgents() {
        #expect(!Roster.roomRows(snapshot: vectors.rooms.snapshot).contains { $0.id == "dm-ada" })
    }

    @Test func aNewAgentsHandleIsThePWAs() {
        for item in vectors.agentForms.handles {
            #expect(Agents.handle(name: item.name, taken: item.taken) == item.handle, "\(item.name)")
            #expect(Agents.isHandle(item.handle), "\(item.handle)")
        }
    }

    @Test func theRolesAnAgentMayBeGivenAreThePWAs() {
        #expect(!vectors.agentForms.roles.isEmpty)
        for item in vectors.agentForms.roles {
            #expect(Agents.roles(roster: item.roster, current: item.current) == item.roles, "\(item.current ?? "none")")
        }
        for item in vectors.agentForms.roleLines {
            #expect(Agents.roleLine(role: item.role, spec: item.spec) == item.line, "\(item.role)")
        }
    }

    @Test func anAgentsOwnModelsAreThePWAs() {
        #expect(!vectors.agentForms.modelChoices.isEmpty)
        for item in vectors.agentForms.modelChoices {
            #expect(Agents.modelChoices(item.choices, own: item.own ?? []) == item.offered, "\(item.own ?? [])")
        }
        for item in vectors.agentForms.modelToggles {
            #expect(Agents.toggle(item.own, item.ref, on: item.on) == item.after, "\(item.ref) \(item.on)")
        }
        for item in vectors.agentForms.modelLines {
            #expect(Agents.modelsLine(own: item.own, role: item.role, spec: item.spec, sensitive: item.sensitive ?? false) == item.line, "\(item.own)")
        }
        for item in vectors.agentForms.worksOn {
            #expect(Agents.worksOn(role: item.role, models: item.models, sensitive: item.sensitive ?? false) == item.words, "\(item.models ?? [])")
        }
    }

    @Test func anAgentsModelsAreSentOnlyToANodeThatKnowsThem() throws {
        var input = AgentInput(id: "ada", name: "Ada", instructions: "", repository: nil, harness: "native", role: "engineer", enabled: true, dailyTurns: 40)
        let without = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect(without?["models"] == nil)
        input.sendModels = true
        let cleared = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect(cleared?["models"] is NSNull)
        input.models = ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"]
        let chosen = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect(chosen?["models"] as? [String] == ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"])
        // Its keys are said only when they could be chosen (an older node would refuse them): then null for none.
        #expect(chosen?["keys"] == nil)
        input.sendKeys = true
        let none = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect(none?["keys"] is NSNull)
        input.keys = [.init(secret: "stripe", header: "authorization", write: false)]
        let given = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect((given?["keys"] as? [[String: Any]])?.first?["secret"] as? String == "stripe")
        // Sensitive mode is said only when it is set: left alone, nothing of it is sent.
        #expect(chosen?["sensitive"] == nil)
        input.sensitive = true
        let held = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        #expect(held?["sensitive"] as? Bool == true)
    }

    @Test func aTasksBudgetIsReadAsThePWAReadsIt() {
        #expect(!vectors.agentForms.budgets.isEmpty)
        for item in vectors.agentForms.budgets {
            switch AgentRoom.budget(from: item.text) {
            case .success(let usd):
                #expect(item.error == nil, "\(item.text)")
                #expect(usd == item.usd, "\(item.text)")
            case .failure(let error):
                #expect(error.message == item.error, "\(item.text)")
            }
        }
    }

    @Test func removingAnAgentSaysWhatThePWASays() {
        for item in vectors.agentForms.removals {
            let plan = Agents.removal(id: item.id, name: item.name, workspace: item.workspace, workspaceNode: item.workspaceNode, maySandbox: item.maySandbox)
            #expect(plan.blocked == item.plan.blocked)
            #expect(plan.lines == item.plan.lines)
            #expect(plan.destroyWorkspace == item.plan.destroyWorkspace)
        }
    }

    @Test func anAgentIsSentWithAnEmptiedRepositoryAsNull() throws {
        let input = AgentInput(id: "ada", name: "Ada", instructions: "", repository: nil, harness: "native", role: "engineer", enabled: true, dailyTurns: 40)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        #expect(json["repository"] is NSNull)
        // Its colour untouched is left out: the node keeps what it has (a new agent takes its handle's).
        #expect(Set(json.keys) == ["id", "name", "instructions", "repository", "harness", "role", "enabled", "dailyTurns"])
    }

    @Test func itsMarksColourIsSentAsCoreTakesItAndNullAsksItsNodeAgain() throws {
        // (The PWA's avatarEditor: { v: 2, color } when you chose, null to ask its node again, nothing when untouched. A node
        // before the marks keeps it as it is; one with them snaps it to the eight and keeps the agent's form.)
        var input = AgentInput(id: "ada", name: "Ada", instructions: "", repository: nil, harness: "native", role: "engineer", enabled: true, dailyTurns: 40, avatar: .chosen("#0084ba"))
        let chosen = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        let profile = try #require(chosen["avatar"] as? [String: Any])
        #expect(Set(profile.keys) == ["v", "color"])
        #expect(profile["v"] as? Int == 2)
        #expect(profile["color"] as? String == "#0084ba")
        // What was sent is what core takes as a chosen colour, and the mark it reads from it: Sky, in its handle's form.
        let sent = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: profile))
        #expect(AgentMark.chosenColor(sent) == "#0084ba")
        #expect(AgentMark.of(id: "ada", profile: sent) == AgentMark(color: 4, form: AgentMark.seeded("ada").form))
        input.avatar = .handle
        let reset = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        #expect(reset.keys.contains("avatar"))
        #expect(reset["avatar"] is NSNull)
        input.avatar = nil
        let untouched = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        #expect(untouched["avatar"] == nil)
    }
}
