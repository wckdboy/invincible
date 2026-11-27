import Foundation
import Testing
@testable import Invincible

/// A task's thread says each thing once (I10, 26 November 2026): the verdict is its proof's alone, so the agent's bare
/// claim of it ("Verified.") isn't shown beside it, and a reason that only says the verdict again ("Gave up · It gave
/// up.") is left out; and it offers one answer in full, the rest in its menu.
struct TaskThreadTests {
    private func task(_ status: String, verified: Bool = false, changes: Bool = false, shipped: Bool = false, fix: Bool = false) throws -> TeamTask {
        var json: [String: Any] = [
            "id": "task-aaaaaaaaaaaa", "room": "room-a", "assignee": "tester", "title": "Speed up the ledger", "goal": "Make it fast.",
            "dependsOn": [String](), "status": status, "verified": verified, "progress": "", "error": NSNull(), "updatedAt": 1,
            "changes": changes ? ["files": 2, "artifact": "art-1"] as [String: Any] : NSNull(),
        ]
        if shipped { json["shipped"] = ["url": "https://example.invalid/pr/1", "pr": 1] }
        if fix { json["fix"] = ["branch": "invincible/fix"] }
        return try JSONDecoder().decode(TeamTask.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func anAgentsBareClaimIsNotShownBesideItsProof() {
        for claim in ["Verified.", "verified", "Done.", "DONE", "Proven!", "Passed.", "Complete.", "Finished.", " Verified. "] {
            #expect(TaskCard.saidBesideProof(claim) == nil, "\(claim)")
        }
        // What says more than the verdict is the agent's own account, shown as its words.
        let account = "The gate needs a Postgres this VM does not have: `bun test db/` exits 1 before any work."
        #expect(TaskCard.saidBesideProof(account) == account)
        #expect(TaskCard.saidBesideProof("Verified: the importer reads both forms now.") == "Verified: the importer reads both forms now.")
        #expect(TaskCard.saidBesideProof(nil) == nil)
        #expect(TaskCard.saidBesideProof("  ") == nil)
    }

    @Test func aReasonThatOnlySaysTheVerdictAgainIsLeftOut() {
        #expect(TaskCard.because("It gave up.", verdict: "Gave up") == nil)
        #expect(TaskCard.because("Stopped.", verdict: "Stopped") == nil)
        #expect(TaskCard.because("Not verified: its gates or the independent review did not pass.", verdict: "Not verified") == "Its gates or the independent review did not pass.")
        #expect(TaskCard.because("bun test db/ exited 1 at the end", verdict: "Failed · gate 1") == "bun test db/ exited 1 at the end")
        #expect(TaskCard.because(nil, verdict: "Proven") == nil)
        #expect(TaskCard.because("", verdict: "Failed") == nil)
    }

    @Test func oneAnswerInFullAndTheRestInItsMenu() throws {
        let cases: [(TeamTask, TaskCard.Action?, [TaskCard.Action])] = [
            (try task("proposed"), .approve, [.decline]),
            (try task("queued"), nil, [.stop]),
            (try task("running"), nil, [.stop]),
            (try task("done", verified: true, changes: true), .ship, [.again]),
            (try task("done", verified: true, changes: true, shipped: true), nil, [.again]),
            (try task("done", verified: true, changes: true, fix: true), nil, [.again]),
            (try task("done", verified: true), nil, [.again]),
            (try task("done"), .again, []),
            (try task("failed"), .again, [.resume]),
            (try task("stopped"), .resume, [.again]),
            (try task("interrupted"), .resume, [.again]),
        ]
        for (task, prominent, rest) in cases {
            let split = TaskCard.answers(task)
            #expect(split.prominent == prominent, "\(task.status) verified \(task.verified)")
            #expect(split.rest == rest, "\(task.status) verified \(task.verified)")
        }
    }
}

/// Where a task's details stand on a wide screen: a column beside the thread only where both have room (DetailsRoom). On
/// 27 November 2026 a Mac's smallest window left the thread 190 points beside the column, its message box a word a line.
struct DetailsRoomTests {
    @Test func aThreadKeepsItsDetailsBesideItOnlyWhereBothHaveRoom() {
        // A Mac's smallest window, beside its sidebar (530 points for the page): no room, the column there or gone.
        #expect(!DetailsRoom.roomy(content: 190, column: 340))
        #expect(!DetailsRoom.roomy(content: 530, column: nil))
        // Its default window (890 for the page): room, the column there or not.
        #expect(DetailsRoom.roomy(content: 550, column: 340))
        #expect(DetailsRoom.roomy(content: 890, column: nil))
        // The thread's and the column's least, exactly: room. Not measured yet: room, so a wide screen doesn't flash a sheet.
        #expect(DetailsRoom.roomy(content: DetailsRoom.thread, column: DetailsRoom.column))
        #expect(DetailsRoom.roomy(content: 0, column: nil))
    }
}
