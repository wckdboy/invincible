import Foundation
import Testing
@testable import Invincible

/// The message box while the primary works, as the PWA has it (lib/turns.ts, the vectors' `composer`): what sending does
/// (steer or queue, by this device's choice and the other with a modifier; steer alone where nothing can be kept), a side
/// question typed into it (`/btw …`), and the words of what waits above it: steers on their way, the queue and why it's
/// held, messages that didn't reach it, and a side question's note and its Bring back.
struct ComposerTests {
    let cases = Vectors.shared.composer

    @Test func whatSendingDoesWhileItWorksIsThePWAs() throws {
        #expect(cases.actions.count == 16)
        for c in cases.actions {
            let enter = try #require(ComposerWords.Enter(rawValue: c.enter))
            #expect(ComposerWords.action(busy: c.busy, enter: enter, modifier: c.modifier, canQueue: c.canQueue).rawValue == c.action, "busy \(c.busy) enter \(c.enter) modifier \(c.modifier) canQueue \(c.canQueue)")
        }
    }

    @Test func aSideQuestionTypedIntoTheBoxIsThePWAs() {
        for c in cases.asides { #expect(ComposerWords.aside(c.text) == c.aside, "\(c.text)") }
    }

    @Test func whatWaitsAboveTheBoxSaysThePWAsWords() {
        for c in cases.steering { #expect(ComposerWords.steering(c.count) == c.line) }
        for c in cases.heads {
            let head = ComposerWords.queueHead(queued: c.queued, held: c.held, busy: c.busy)
            #expect(head.count == c.count && head.rest == c.rest, "\(c.queued) \(c.held ?? "-") \(c.busy)")
        }
        for c in cases.undelivered {
            let said = ComposerWords.undelivered(texts: c.texts, queued: c.queued)
            #expect(said.title == c.title && said.detail == c.detail)
        }
        for c in cases.placeholders { #expect(ComposerWords.placeholder(canQueue: c.canQueue) == c.words) }
        #expect(ComposerWords.filesWait == cases.filesWait)
        #expect(ComposerWords.justStarting == cases.justStarting)
        #expect(ComposerWords.notKept == cases.notKept)
    }

    @Test func aSideQuestionsWordsAreThePWAs() {
        for c in cases.asideNotes { #expect(ComposerWords.asideNote(working: c.working) == c.note) }
        for c in cases.broughtBack { #expect(ComposerWords.broughtBack(c.how) == c.words) }
        #expect(ComposerWords.nothingYet.title == cases.nothingYet.title && ComposerWords.nothingYet.detail == cases.nothingYet.detail)
        for c in cases.asidePlaceholders { #expect(ComposerWords.asidePlaceholder(working: c.working) == c.words) }
        #expect(ComposerWords.asideAnswering == cases.asideAnswering)
        #expect(ComposerWords.asideFailed == cases.asideFailed)
        #expect(ComposerWords.bringBackFailed == cases.bringBackFailed)
    }
}
