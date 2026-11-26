import Foundation
import Testing
@testable import Invincible

/// A terminal in an agent's VM: what is typed goes in order (core's terminal-input.ts, its tests ported), what it
/// shows is read, and the addresses a sign-in prints are found.
@MainActor struct TerminalTests {
    /// A request that resolves only when the test says so.
    final class Gate { var open: CheckedContinuation<Void, any Error>?; var sent: [TerminalInput] = [] }

    @Test func oneRequestAtATimeAndWhatIsTypedMeanwhileGoesNextTogetherTheLatestSizeOnly() async throws {
        let gate = Gate()
        let queue = TerminalInputQueue(send: { input in
            gate.sent.append(input)
            try await withCheckedThrowingContinuation { gate.open = $0 }
        }, failed: { _ in })
        queue.type("a")
        try await Task.sleep(for: .milliseconds(20))
        queue.type("b"); queue.resize(TerminalSize(cols: 80, rows: 24)); queue.type("c"); queue.resize(TerminalSize(cols: 100, rows: 30))
        #expect(gate.sent == [TerminalInput(data: "a")])
        gate.open?.resume(); gate.open = nil
        try await Task.sleep(for: .milliseconds(20))
        #expect(gate.sent == [TerminalInput(data: "a"), TerminalInput(data: "bc", size: TerminalSize(cols: 100, rows: 30))])
        gate.open?.resume()
    }

    @Test func aPasteLargerThanOneRequestGoesInPiecesInOrderNeverSplittingACharacter() async throws {
        var sent: [String] = []
        let queue = TerminalInputQueue(send: { input in sent.append(input.data ?? "") }, failed: { _ in })
        let paste = String(repeating: "x", count: TerminalInputQueue.maxData - 1) + "🛡️" + "tail"
        queue.type(paste)
        for _ in 0..<50 where !queue.idle || sent.joined() != paste { try await Task.sleep(for: .milliseconds(10)) }
        #expect(sent.joined() == paste)
        #expect(sent.count == 2)
        #expect(sent.allSatisfy { $0.utf16.count <= TerminalInputQueue.maxData })
    }

    @Test func aRequestThatFailsIsToldAndNothingMoreIsSent() async throws {
        struct Refused: Error {}
        var sent = 0
        var told = 0
        let queue = TerminalInputQueue(send: { _ in sent += 1; throw Refused() }, failed: { _ in told += 1 })
        queue.type("a")
        try await Task.sleep(for: .milliseconds(30))
        queue.type("b")
        try await Task.sleep(for: .milliseconds(30))
        #expect(sent == 1 && told == 1)
    }

    @Test func whatWatchingSendsIsRead() {
        #expect(TerminalEvent(json: #"{"type":"output","data":"aGk="}"#) == .output("aGk="))
        #expect(TerminalEvent(json: #"{"type":"exit","code":3}"#) == .exit(3))
        #expect(TerminalEvent(json: #"{"type":"other"}"#) == nil)
    }

    @Test func aSignInsAddressIsFoundInWhatItShowsColoursAndAll() {
        let shown = "\u{1b}[2J\u{1b}[1;1HBrowser didn't open? Use the url below to sign in:\r\n\u{1b}[36mhttps://claude.ai/oauth/authorize?code=true&client_id=fake&state=xyz\u{1b}[39m\r\n\u{1b}]0;title\u{07}Paste code here if prompted > "
        #expect(Terminals.links(in: shown).map(\.absoluteString) == ["https://claude.ai/oauth/authorize?code=true&client_id=fake&state=xyz"])
        #expect(Terminals.plain("\u{1b}[1mbold\u{1b}[0m and \u{1b}[38;5;208mcolour\u{1b}[m") == "bold and colour")
        #expect(Terminals.links(in: "Open (https://microsoft.com/devicelogin).").map(\.absoluteString) == ["https://microsoft.com/devicelogin"])
        #expect(Terminals.links(in: "nothing here, ftp://x and http:// alone").isEmpty)
    }
}
