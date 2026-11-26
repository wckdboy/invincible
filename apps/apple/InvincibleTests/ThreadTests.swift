import Foundation
import Testing
@testable import Invincible

/// A chat on screen is the PWA's, turn for turn (`apps/web/src/lib/turns.ts`): a kept chat as it stands, a turn's stream
/// applied event by event, a turn attached to while it runs and rebuilt from the node's replay, and a watch cut short.
struct ThreadTests {
    let vectors = Vectors.shared

    @Test(arguments: Vectors.shared.threads.map(\.name))
    func aChatReadsAsThePWAShowsIt(_ name: String) throws {
        let scenario = try #require(vectors.threads.first { $0.name == name })
        var thread = ChatThread(kept: scenario.messages, role: scenario.role)
        if let question = scenario.question { thread.begin(question: question, role: scenario.role) }
        for event in scenario.events {
            switch event {
            case .null: thread.end()
            case .string(let cut): thread.fail(cut)
            default: thread.apply(try #require(ChatEvent(json: event.text), "\(name): \(event.text)"))
            }
        }
        let shown = thread.turns.map { turn in
            Vectors.Thread.Turn(
                role: turn.role.rawValue,
                content: turn.content,
                status: turn.status.rawValue,
                error: turn.error,
                sid: turn.sid,
                steps: turn.steps.map { .init(text: $0.text, detail: $0.detail, state: $0.state.rawValue, tool: $0.tool) },
                look: turn.look
            )
        }
        #expect(shown == scenario.turns)
    }

    @Test func aWatchThatWasLeftEndsNothing() {
        // Nothing is being written: ending or failing changes nothing on screen.
        var thread = ChatThread(kept: vectors.threads[0].messages, role: "planner")
        let before = thread
        thread.end()
        thread.fail("gone")
        #expect(thread == before)
    }
}

/// A tool's step as the work log shows it: its command and what came back, from the step's detail (lib/turns.ts' form).
struct WorkLogTests {
    @Test func aCommandAndWhatCameBack() {
        let ran = WorkLog.parts(#"{"command":"bun test test/auth","timeoutSec":120} → 14 pass, 0 fail"#)
        #expect(ran.command == "bun test test/auth")
        #expect(ran.answer == "14 pass, 0 fail")
        // A command of several lines shows its first; a step still running has no answer yet.
        #expect(WorkLog.parts(#"{"command":"cd /work\ngit status"}"#).command == "cd /work")
        #expect(WorkLog.parts(#"{"command":"ls"}"#).answer == nil)
    }

    @Test func aToolWithoutACommandShowsNone() {
        #expect(WorkLog.parts(#"{"query":"redirects"} → 3 results"#).command == nil)
        #expect(WorkLog.parts(nil).command == nil)
        #expect(WorkLog.parts("not json").command == nil)
    }
}
