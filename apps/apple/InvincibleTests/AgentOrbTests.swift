import Foundation
import Testing
@testable import Invincible

/// An agent's orb's colours, as core gives them (`avatar.ts`' agentColors: the colour you chose for it, or one of 24 its
/// handle picks; your word, 25 November 2026: "drop the agent avatars, and just use custom/procedurally generated colored
/// particle orbs"), and what an agent is doing as its orb shows it (`taskStep`, `avatarExpression`): checked against
/// their own output.
struct AgentOrbTests {
    let orbs = Vectors.shared.agentOrbs
    let agents = Vectors.shared.agents

    @Test func theTwentyFourTintsAndTheirNamesAreCores() {
        #expect(AgentOrb.tints == orbs.tints)
        #expect(AgentOrb.tintNames == orbs.names)
        #expect(Set(AgentOrb.tints).count == 24)
        for tint in AgentOrb.tints { #expect(AgentOrb.isHex(tint) && tint == tint.lowercased(), "\(tint)") }
    }

    @Test func eachAgentsColoursAreCoresFromItsHandleOrTheColourYouChose() {
        #expect(!orbs.agents.isEmpty)
        for item in orbs.agents {
            let theirs = item.colors
            #expect(AgentOrb.colors(id: item.id, profile: item.avatar) == AgentOrb.Colors(tint: theirs.tint, light: theirs.light, deep: theirs.deep, second: theirs.second, chosen: theirs.chosen), "\(item.id)")
        }
        // Both are among them: colours chosen, and handles' colours (a look from the drawings among those, colouring nothing).
        #expect(orbs.agents.contains { $0.colors.chosen })
        #expect(orbs.agents.contains { !$0.colors.chosen && $0.avatar != nil })
    }

    @Test func aHandlesSeedIsFNV1aOverItsUTF16AsCoresIs() {
        #expect(!orbs.seeds.isEmpty)
        for item in orbs.seeds { #expect(Orb.seed(item.id) == item.seed, "\(item.id)") }
    }

    @Test func coloursBlendInWholeChannelsAndFindTheirNearestTintAsCoresDo() {
        #expect(!orbs.blends.isEmpty && !orbs.nearest.isEmpty)
        for item in orbs.blends { #expect(AgentOrb.blend(item.from, item.to, item.t) == item.blend, "\(item.from) → \(item.to) at \(item.t)") }
        for item in orbs.nearest { #expect(AgentOrb.nearestTint(item.color) == item.at, "\(item.color)") }
    }

    @Test func onlyAColourYouChoseColoursAnOrb() {
        #expect(AgentOrb.chosenColor(.object(["v": .number(2), "color": .string("#3ABEFF")])) == "#3abeff")
        let odd: [JSONValue?] = [
            nil, .null, .string("#3abeff"), .array([]),
            .object(["v": .number(2), "color": .string("blue")]),
            .object(["v": .number(2), "color": .string("#3abeff"), "form": .string("round")]),
            .object(["v": .string("2"), "color": .string("#3abeff")]),
            .object(["v": .number(3), "color": .string("#3abeff")]),
            .object(["v": .number(2)]),
            .object(["v": .number(1), "form": .string("round"), "color": .string("#be7153"), "accent": .string("#6b4536"), "eyes": .string("oval"), "accessory": .string("none"), "temperament": .string("calm")]),
        ]
        for profile in odd {
            #expect(AgentOrb.chosenColor(profile) == nil, "\(String(describing: profile))")
            #expect(AgentOrb.colors(id: "coder", profile: profile) == AgentOrb.colors(id: "coder", profile: nil), "\(String(describing: profile))")
        }
    }

    @Test func handlesSpreadRoundAllTwentyFourAndASecondColourIsThreeToSixOn() {
        // The same every time, and many handles reach every tint.
        #expect(AgentOrb.colors(id: "coder", profile: nil) == AgentOrb.colors(id: "coder", profile: nil))
        #expect(Set((0..<400).map { AgentOrb.colors(id: "agent-\($0)", profile: nil).tint }) == Set(AgentOrb.tints))
        for n in 0..<200 {
            let colors = AgentOrb.colors(id: "agent-\(n)", profile: nil)
            let steps = (AgentOrb.tints.firstIndex(of: colors.second)! - AgentOrb.tints.firstIndex(of: colors.tint)! + 24) % 24
            #expect((3...6).contains(steps), "agent-\(n)")
            #expect(!colors.chosen)
        }
    }

    @Test func aRunningTasksLineShowsAsCoreSays() {
        #expect(!Vectors.shared.faces.steps.isEmpty)
        for item in Vectors.shared.faces.steps { #expect(AgentOrb.step(item.line) == item.step, "\(item.line)") }
    }

    @Test func whatEachAgentAtTheAgentsIsDoingIsThePWAs() {
        let rows = Roster.rows(snapshot: agents.snapshot, asks: agents.asks, now: agents.now)
        #expect(rows.map(\.id) == agents.rows.map(\.id))
        for (row, expected) in zip(rows, agents.rows) { #expect(row.expression == expected.expression, "\(row.id)") }
    }
}
