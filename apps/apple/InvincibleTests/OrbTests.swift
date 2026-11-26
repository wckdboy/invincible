import Foundation
import Testing
@testable import Invincible

/// How a face stands, as the PWA names it (`lib/orb.ts`, `lib/orb-motion.ts`): the primary's line's tone, the tone and
/// the mood of each state the node names, and the mood of what an agent is doing, which its mark shows as a state.
struct OrbTests {
    let orb = Vectors.shared.orb

    @Test func hisLinesToneIsHisFaces() {
        let tones: [PrimaryNow.Tone] = [.neutral, .accent, .warn, .ok]
        #expect(tones.map { Orb.Tone($0) } == [.neutral, .accent, .warn, .ok])
    }

    @Test func whereHeStandsIsItsToneAsThePWAs() {
        #expect(!orb.states.isEmpty)
        for item in orb.states {
            #expect(Standing(rawValue: item.state).map { Orb.Tone($0).rawValue } == item.tone, "\(item.state)")
        }
    }

    @Test func whatAnAgentIsDoingIsItsMoodAsThePWAs() {
        let faces = Vectors.shared.faces
        #expect(!faces.moods.isEmpty)
        for item in faces.moods { #expect(Orb.Mood(expression: item.expression).rawValue == item.mood, "\(item.expression)") }
        // One it doesn't know, or none, is at rest.
        #expect(Orb.Mood(expression: "dancing") == .idle)
        #expect(Orb.Mood(expression: nil) == .idle)
    }

    @Test func aTasksThreadShowsHowItStandsInItsAgentsFaceAsTheWebDoes() {
        // (The web's markStateOfAgent(taskState(task)), for every status a task has.)
        let cases: [(String, Bool, MarkState)] = [
            ("running", false, .working), ("proposed", false, .needs), ("interrupted", false, .needs), ("queued", false, .queued),
            ("failed", false, .failed), ("stopped", false, .paused), ("done", true, .done), ("done", false, .idle), ("dancing", false, .idle),
        ]
        for (status, verified, state) in cases {
            #expect(MarkState(Orb.Mood(task: status, verified: verified)) == state, "\(status) verified \(verified)")
        }
    }

    @Test func eachStateHasThePWAsMood() {
        #expect(!orb.motion.states.isEmpty)
        for item in orb.motion.states { #expect(Orb.Mood(state: item.state).rawValue == item.mood, "\(item.state)") }
        // Where someone stands among the agents are the same as the state the node names.
        for item in orb.motion.states {
            if let standing = Standing(rawValue: item.state) { #expect(Orb.Mood(standing).rawValue == item.mood, "\(item.state)") }
        }
    }
}
