import Foundation
import Observation

/// A side question (the PWA's chat-aside.ts): something you ask about the work in hand without changing its course,
/// answered apart, from what the chat holds and what its running turn has said and done so far, without its tools. The
/// working turn never sees it, and it joins nothing, unless you bring it back.
@MainActor @Observable final class SideQuestion {
    /// What it's about: a kept chat, or the turn under way in a chat the node doesn't keep yet.
    enum About: Sendable, Equatable { case conversation(String), turn(String) }

    let about: About
    /// It was asked while the chat's turn was under way (its note and its suggestion say what it's answered from).
    let working: Bool
    var question: String
    private(set) var answer = ""
    private(set) var asking = false
    /// It has been answered (or failed) at least once: its button asks again.
    private(set) var asked = false
    /// What went wrong, under its title (ComposerWords.asideFailed, or bringBackFailed).
    private(set) var problem: (title: String, detail: String)?
    /// Its id on the node, once the node has said it: what Bring back names.
    private(set) var key: String?
    private var answering: Task<Void, Never>?

    init(about: About, working: Bool, question: String = "") {
        (self.about, self.working, self.question) = (about, working, question)
    }

    /// It can be brought back: answered, with words, and not being answered again.
    var canBringBack: Bool { key != nil && !asking && !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Asks it (again): the answer streams in apart from the chat.
    func ask(with client: NodeClient) {
        let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !asking else { return }
        (answer, problem, key, asking) = ("", nil, nil, true)
        struct Ask: Encodable, Sendable { var conversation: String?; var turn: String?; let question: String }
        let body: Ask = switch about {
        case .conversation(let id): Ask(conversation: id, question: question)
        case .turn(let id): Ask(turn: id, question: question)
        }
        answering = Task {
            var failed: String?
            do {
                for try await event in client.events("/api/turns/aside", body) {
                    switch event {
                    case .aside(let id): key = id
                    case .text(let text): answer += text
                    case .error(let error): failed = error
                    default: break
                    }
                }
            } catch is CancellationError {
            } catch {
                failed = error.localizedDescription
            }
            if let failed {
                key = nil
                problem = (ComposerWords.asideFailed, failed)
            }
            (asking, asked) = (false, true)
        }
    }

    /// Hands it to the chat after all: the turn under way is steered with it, or it joins the kept chat. The words of what
    /// it did (ComposerWords.broughtBack), or nil when it couldn't (its problem says why).
    func bringBack(with client: NodeClient) async -> String? {
        guard let key else { return nil }
        struct Bring: Encodable { let aside: String }
        struct Brought: Decodable { let how: String }
        do {
            return ComposerWords.broughtBack(try await client.post("/api/turns/aside/bring", Bring(aside: key), as: Brought.self).how)
        } catch {
            problem = (ComposerWords.bringBackFailed, error.localizedDescription)
            return nil
        }
    }

    func cancel() { answering?.cancel() }
}
