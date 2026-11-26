import Foundation
import Testing
@testable import Invincible

/// An MCP server's question to you, as the node sends it (core's questions.ts), and your answer as the node takes it.
struct QuestionsTests {
    @Test func aQuestionReadsAsTheNodeSendsIt() throws {
        let json = """
        {"id":"qn_0123456789abcdef","connector":"tracker","label":"Tracker","message":"Which repository should it go in?","askedAt":1000,"expires":301000,
         "fields":[{"name":"repo","kind":"text","title":"Repository","description":"owner/name","required":true,"format":null,"minLength":null,"maxLength":100,"default":null},
                   {"name":"count","kind":"number","title":"count","description":null,"required":false,"integer":true,"minimum":1,"maximum":10,"default":3},
                   {"name":"private","kind":"yes-no","title":"Private?","description":null,"required":false,"default":true},
                   {"name":"region","kind":"one","title":"region","description":null,"required":true,"options":[{"value":"eu","title":"Europe"},{"value":"us","title":"United States"}],"default":null}]}
        """
        let question = try JSONDecoder().decode(QuestionView.self, from: Data(json.utf8))
        #expect(question.label == "Tracker")
        #expect(question.fields.map(\.kind) == ["text", "number", "yes-no", "one"])
        #expect(question.fields[0].description == "owner/name")
        #expect(question.fields[1].default == .number(3))
        #expect(question.fields[2].default == .bool(true))
        #expect(question.fields[3].options == [.init(value: "eu", title: "Europe"), .init(value: "us", title: "United States")])
    }

    @Test func yourAnswerGoesAsTheNodeTakesIt() throws {
        let answer: [String: QuestionAnswer] = ["repo": .text("wckdboy/invincible"), "private": .yes(false), "count": .number(4), "labels": .several(["bug", "docs"])]
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        #expect(sent["repo"] as? String == "wckdboy/invincible")
        #expect(sent["private"] as? Bool == false)
        #expect(sent["count"] as? Double == 4)
        #expect(sent["labels"] as? [String] == ["bug", "docs"])
    }
}
