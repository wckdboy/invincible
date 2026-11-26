import Testing
@testable import Invincible

/// Naming an agent with @ as you write: what is being typed, what it may be, and what it becomes.
struct MentionsTests {
    let seats = [Mentions.Seat(id: "ada", name: "Ada"), Mentions.Seat(id: "tester", name: "QA Tester"), Mentions.Seat(id: "primary", name: Primary.name)]

    @Test func aNameIsBeingTypedAfterAnAtThatStartsAWord() {
        #expect(Mentions.typing("@") == "")
        #expect(Mentions.typing("hi @ad") == "ad")
        #expect(Mentions.typing("line one\n@b") == "b")
        #expect(Mentions.typing("mail me at x@ad") == nil)
        #expect(Mentions.typing("@ada is here") == nil)
        #expect(Mentions.typing("no mention") == nil)
    }

    @Test func itMayBeAnAgentByHandleOrByName() {
        #expect(Mentions.matches("", in: seats).map(\.id) == ["ada", "tester", "primary"])
        #expect(Mentions.matches("t", in: seats).map(\.id) == ["tester"])
        #expect(Mentions.matches("QA", in: seats).map(\.id) == ["tester"])
        #expect(Mentions.matches("x", in: seats).isEmpty)
    }

    @Test func choosingOneWritesItsHandle() {
        #expect(Mentions.complete("hi @qa", with: seats[1]) == "hi @tester ")
        #expect(Mentions.complete("@", with: seats[2]) == "@primary ")
        #expect(Mentions.complete("nothing typed", with: seats[0]) == "nothing typed")
    }
}

/// A message quoted in your reply: one plain line of it, with who said it.
struct QuoteTests {
    @Test func aQuoteIsOneLineOfItsWordsWithoutItsMarkdown() {
        #expect(Quote.of("### What I found\n\nThree things stand out, and **one needs you**:\n\n1. The *release* is on track.") == "> What I found Three things stand out, and one needs you: The release is on track.\n\n")
        #expect(Quote.of("Done: see [the run](https://example.invalid/run).", by: "Ada") == "> Ada: Done: see the run.\n\n")
        let long = String(repeating: "word ", count: 60)
        let quoted = Quote.of(long)
        #expect(quoted.hasSuffix("…\n\n") && quoted.count <= 2 + 160 + 1 + 2)
        // A chart says nothing in a quote; code says its words.
        #expect(Quote.of("Here:\n```chart\n{\"type\":\"line\"}\n```\n```sh\nbun test\n```") == "> Here: bun test\n\n")
    }
}
