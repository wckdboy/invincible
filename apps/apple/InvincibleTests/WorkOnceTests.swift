import Foundation
import Testing
@testable import Invincible

/// The work by attention is worked out once for each change of what it is drawn from, however many read it
/// (Session.attended). Until 27 November 2026 each read worked it all out again, over a busy fleet's hundred tasks on the
/// main thread. Home's line, its count of what needs you and its sections each read it, so on CI's loaded Mac one event took
/// 460 ms to be drawn (PR #89's testEventToScreen, 514 ms against 500). Against a node on this machine's loopback
/// (LocalNode) that answers the agents.
@MainActor @Suite(.serialized) struct WorkOnceTests {
    @Test func theWorkIsWorkedOutOnceAChangeHoweverManyReadIt() async throws {
        let node = try await LocalNode(.a)
        defer { node.stop() }
        node.serve(team: Data(#"{"agents":[],"rooms":[],"tasks":[],"deliveries":[]}"#.utf8))
        let tag = "sh.invincible.bot.tests.work-once"
        defer { try? DeviceKey.delete(tag: tag) }
        let key = try DeviceKey.create(tag: tag)
        let session = Session(key: key, node: PairedNode(origin: node.origin, device: key.device, name: "tests", fleet: "f_tests", nodeId: node.a))
        await session.refresh()
        try #require(session.team != nil, "the node's agents weren't read")
        // As a screen reads it in one turn: its line, its count of what needs you, its sections, each row's project.
        let first = session.workedOut
        for _ in 0..<8 {
            _ = session.attended
            _ = session.needsYou
        }
        #expect(session.workedOut - first <= 1, "worked out \(session.workedOut - first) times for one change")
        // The node's agents read again (as its stream says they moved): worked out once more, not once a read.
        await session.refresh()
        let again = session.workedOut
        for _ in 0..<8 {
            _ = session.attended
            _ = session.needsYou
        }
        #expect(session.workedOut - again <= 1, "worked out \(session.workedOut - again) times for one change")
        #expect(session.workedOut > 0, "the work was never worked out")
    }
}
