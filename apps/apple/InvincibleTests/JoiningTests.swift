import Foundation
import Testing
@testable import Invincible

/// Joining a fleet as `apps/web/src/pair.ts` does: ask, check the node's code is ours, wait, and trust an approval only
/// with its proof. The node here is scripted; its proofs are the ones core made.
struct JoiningTests {
    let vectors = Vectors.shared
    var pairing: Vectors.Pairing { vectors.pairing }

    /// A node that answers each POST from a script, and remembers what it was sent.
    final class ScriptedNode: PairTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var answers: [(Int, String)]
        private(set) var sent: [(path: String, body: [String: String])] = []
        init(_ answers: [(Int, String)]) { self.answers = answers }
        func post(_ path: String, _ body: [String: String]) async throws -> (status: Int, body: Data) {
            let (status, text) = lock.withLock {
                sent.append((path, body))
                return answers.removeFirst()
            }
            if status == 0 { throw Joining.Stop.unreachable("No answer from the node") }
            return (status, Data(text.utf8))
        }
    }

    func joining(_ node: ScriptedNode) -> Joining {
        Joining(invite: pairing.invite, device: pairing.device, transport: node)
    }

    @Test func itAsksWithItsFieldsAndProofAndGoesOnWhenTheCodesMatch() async throws {
        let node = ScriptedNode([(200, #"{"status":"pending","sas":"\#(pairing.sas)"}"#)])
        let join = joining(node)
        #expect(join.code == pairing.sas)
        try await join.ask(name: pairing.proofs[0].name)
        let sent = try #require(node.sent.first)
        #expect(sent.path == "/link/pair/request")
        #expect(sent.body == ["invite": pairing.invite.i, "device": pairing.device, "name": pairing.proofs[0].name, "kind": "client", "proof": pairing.proofs[0].proof])
    }

    @Test func itStopsWhenTheNodeComputedAnotherCode() async {
        let node = ScriptedNode([(200, #"{"status":"pending","sas":"000 000"}"#)])
        await #expect(throws: Joining.Stop.ended("The node computed a different code. Stopping here, to be safe.")) { try await joining(node).ask(name: "Invincible app on iPhone") }
    }

    @Test func whatTheNodeRefusesIsSaidAsThePWASaysIt() async {
        let cases: [((Int, String), Joining.Stop)] = [
            ((409, #"{"error":"device already enrolled"}"#), .alreadyEnrolled),
            ((409, #"{"error":"invite already used"}"#), .alreadyUsed),
            ((409, #"{"error":"invite was used by two devices: possible interception; create a new invite"}"#), .ended("invite was used by two devices: possible interception; create a new invite")),
            ((404, #"{"error":"invite unknown or expired"}"#), .ended("This invite has expired or is no longer valid.")),
            ((403, #"{"error":"invalid invite proof"}"#), .ended("This invite has expired or is no longer valid.")),
            ((400, #"{"error":"invalid input"}"#), .refused("invalid input")),
            ((502, "<html>"), .unreachable("Invincible's node isn't answering (502). It may be restarting.")),
            ((0, ""), .unreachable("No answer from the node")),
        ]
        for (answer, stop) in cases {
            await #expect(throws: stop) { try await joining(ScriptedNode([answer])).ask(name: "Invincible app on iPhone") }
        }
    }

    @Test func anApprovalCountsOnlyWithItsProofForItsFleet() async throws {
        let approved = #"{"status":"approved","fleet":"\#(pairing.invite.f)","approval":"\#(pairing.approvalProof)"}"#
        let node = ScriptedNode([(200, approved)])
        #expect(try await joining(node).status() == .approved)
        #expect(node.sent.first?.path == "/link/pair/status")
        #expect(node.sent.first?.body == ["invite": pairing.invite.i, "device": pairing.device, "proof": pairing.statusProof])

        let unverified = Joining.Stop.ended("The approval could not be verified. Stopping here, to be safe.")
        let forged = #"{"status":"approved","fleet":"\#(pairing.invite.f)","approval":"\#(pairing.statusProof)"}"#
        let elsewhere = #"{"status":"approved","fleet":"\#(String(repeating: "A", count: 43))","approval":"\#(pairing.approvalProof)"}"#
        let bare = #"{"status":"approved","fleet":"\#(pairing.invite.f)"}"#
        for answer in [forged, elsewhere, bare] {
            await #expect(throws: unverified) { try await joining(ScriptedNode([(200, answer)])).status() }
        }
    }

    @Test func aDeclineOrAnExpiredInviteEndsIt() async throws {
        #expect(try await joining(ScriptedNode([(200, #"{"status":"pending"}"#)])).status() == .pending)
        await #expect(throws: Joining.Stop.ended("The pairing was declined on the node.")) { try await joining(ScriptedNode([(200, #"{"status":"rejected"}"#)])).status() }
        await #expect(throws: Joining.Stop.ended("This invite has expired or is no longer valid.")) { try await joining(ScriptedNode([(404, #"{"error":"no such request"}"#)])).status() }
    }

    @Test func waitingAsksAgainAndRidesOutALostConnection() async throws {
        let approved = #"{"status":"approved","fleet":"\#(pairing.invite.f)","approval":"\#(pairing.approvalProof)"}"#
        let node = ScriptedNode([(200, #"{"status":"pending"}"#), (0, ""), (0, ""), (200, #"{"status":"pending"}"#), (200, approved)])
        let slept = Recorded<Duration>()
        let retrying = Recorded<Bool>()
        try await joining(node).approval(sleep: { slept.add($0) }, onRetry: { retrying.add($0) })
        // As the PWA waits: 1.5 s between answers, and 1.5 s × 2ⁿ (at most 10 s) after the nth lost one in a row.
        #expect(slept.values == [.milliseconds(1500), .milliseconds(3000), .milliseconds(6000), .milliseconds(1500)])
        #expect(retrying.values == [false, true, true, false])
        #expect(node.sent.count == 5)
    }

    @Test func requestsGoWhereTheLinkWasOpenedOrElseToTheInvitesEndpoint() throws {
        #expect(Joining.origin(for: pairing.url, invite: pairing.invite)?.absoluteString == "http://127.0.0.1:7778")
        #expect(Joining.origin(for: "  https://keep.example.ts.net/#pair=\(pairing.token)\n", invite: pairing.invite)?.absoluteString == "https://keep.example.ts.net")
        #expect(Joining.origin(for: pairing.token, invite: pairing.invite)?.absoluteString == "http://127.0.0.1:7777")
        #expect(Joining.origin(for: "ftp://keep.example.ts.net/#pair=\(pairing.token)", invite: pairing.invite) == nil)
    }

    /// An `invincible:` link (the Mac opens these) hands over the invite link it carries, which keeps its address, or else the
    /// invite alone, whose node is where it says; nothing else is taken for one.
    @Test func aPrimaryLinkHandsOverTheInviteItCarries() throws {
        let link = { (text: String) in try #require(URL(string: text)) }
        #expect(Joining.handed(try link("invincible:\(pairing.url)")) == pairing.url)
        #expect(Joining.handed(try link("invincible://pair#pair=\(pairing.token)")) == pairing.token)
        #expect(Joining.handed(try link("invincible:\(pairing.token)")) == pairing.token)
        #expect(Joining.handed(try link("INVINCIBLE://\(pairing.token)")) == pairing.token)
        let handed = try #require(Joining.handed(try link("invincible://pair#pair=\(pairing.token)")))
        #expect(Joining.origin(for: handed, invite: try Invite.decode(handed))?.absoluteString == "http://127.0.0.1:7777")
        #expect(Joining.handed(try link("invincible://pair")) == nil)
        #expect(Joining.handed(try link("invincible://pair#pair=gi1.bm90LWFuLWludml0ZQ")) == nil)
        #expect(Joining.handed(try link("https://keep.example.ts.net/#pair=\(pairing.token)")) == nil)
    }
}

final class Recorded<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [Value] = []
    func add(_ value: Value) { lock.withLock { kept.append(value) } }
    var values: [Value] { lock.withLock { kept } }
}
