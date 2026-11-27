import Foundation
import Testing
@testable import Invincible

/// A loop it drafted, in Needs you: its task and what wakes it in the PWA's words (lib/loops.ts, lib/wakes.ts), held to
/// the vectors' `loops`; and the draft and a connector request read as the node sends them, and sent back as they came.
struct LoopsTests {
    @Test func aTaskIsSaidAsThePwaSaysIt() {
        for item in Vectors.shared.loops.tasks {
            #expect(Loops.describeTask(item.task) == item.words, "\(String(describing: item.task))")
        }
    }

    @Test func whatWakesItIsSaidAsThePwaSaysIt() {
        for item in Vectors.shared.loops.wakes {
            #expect(Loops.describeWakes(item.wakes, cooldownMs: item.cooldownMs) == item.words, "\(item.wakes)")
        }
    }

    @Test func aNumberIsWrittenAsJavaScriptWritesIt() {
        #expect([2, 1.5, -0.0, 1e21, 1e-7, 123, 0.1].map(Loops.jsNumber) == ["2", "1.5", "0", "1e+21", "1e-7", "123", "0.1"])
    }

    @Test func aDraftAndAConnectorRequestAreReadAsTheNodeSendsThem() throws {
        let draft = try JSONDecoder().decode(LoopDraftView.self, from: Data("""
        {"id":"ld_1","name":"standup","schedule":"0 9 * * 1-5","tz":"Europe/Copenhagen","on":null,"task":{"kind":"tell","text":"Stand up"},"wakes":[{"kind":"webhook"}],"cooldownMs":null,"label":"Stand-up","why":"You asked for it.","by":"primary","at":1,"expires":2,"replaces":false}
        """.utf8))
        #expect(Loops.describeTask(draft.task) == "Tells you: Stand up: a notice in Needs you, and your loop's name on your phone.")
        #expect(Loops.describeWakes(draft.wakes, cooldownMs: draft.cooldownMs) == "Also wakes on a webhook; a burst within 10 min is one run.")
        // Its task goes back as it came.
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.task)) as? [String: String]
        #expect(sent == ["kind": "tell", "text": "Stand up"])
        let request = try JSONDecoder().decode(ConnectorRequestView.self, from: Data("""
        {"id":"cr_1","connector":"github","access":true,"agent":"coder","label":"GitHub","why":"To open the pull request.","by":"Coder","at":1,"expires":2}
        """.utf8))
        #expect(request.access && request.label == "GitHub" && request.by == "Coder")
    }

    /// A loop it drafted and a connector asked for are decisions, as the PWA counts them: every client counts the same.
    @Test func aDraftedLoopAndAConnectorRequestAreCountedAsDecisions() {
        let now = 1_000.0
        #expect(Session.needsCount(nil, waiting: 0, pairings: 0, keys: 0, questions: [], screens: 0, loops: 0, connectors: 0, now: now) == 0)
        #expect(Session.needsCount(nil, waiting: 0, pairings: 0, keys: 0, questions: [], screens: 0, loops: 2, connectors: 1, now: now) == 3)
        // Beside the rest, and a question only while it can be answered.
        #expect(Session.needsCount(nil, waiting: 1, pairings: 1, keys: 1, questions: [now + 1, now - 1], screens: 1, loops: 1, connectors: 1, now: now) == 7)
    }
}
