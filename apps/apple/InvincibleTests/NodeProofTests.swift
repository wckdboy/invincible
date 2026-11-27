import Foundation
import Testing
@testable import Invincible

/// Which node this device speaks to, proven, judged as core's judgeNodeProof judges it (the slice 8 note's item 11).
struct NodeProofTests {
    let vectors = Vectors.shared
    /// A checker that holds the vectors' proofs alone: as the apps' verifier will, without its curve.
    var known: NodeProof.Checker {
        let proofs = Set(vectors.nodeProofs.map { "\($0.node) \($0.challenge) \($0.proof)" })
        return NodeProof.Checker { node, challenge, proof in proofs.contains("\(node) \(challenge) \(proof)") }
    }

    @Test func theDomainAndTheChallengeAreCores() throws {
        #expect(NodeProof.domain == vectors.auth.nodeProofDomain)
        for proof in vectors.nodeProofs {
            #expect(NodeProof.signingInput(proof.challenge) == Data(proof.signingInput.utf8))
            #expect(NodeProof.isChallenge(proof.challenge))
            #expect(NodeProof.isNode(proof.node) && NodeProof.isNode(proof.anotherNode))
        }
        let shape = try Regex(vectors.auth.nodeChallenge)
        for _ in 0..<50 {
            let challenge = NodeProof.challenge()
            #expect(NodeProof.isChallenge(challenge) && challenge.wholeMatch(of: shape) != nil, "\(challenge)")
        }
        #expect(!NodeProof.isChallenge("too-short") && !NodeProof.isChallenge(String(repeating: "A", count: 65)) && !NodeProof.isChallenge("not base64url, sixteen+"))
        #expect(!NodeProof.isNode("c_" + vectors.nodeProofs[0].node.dropFirst(2)) && !NodeProof.isNode(String(vectors.nodeProofs[0].node.dropLast())))
    }

    @Test func theFirstProofPinsTheSameIsKeptAnotherAndAFailedOneAreRefusedAndANodeFromBeforeIsAsBefore() throws {
        let proof = try #require(vectors.nodeProofs.first)
        let judge = { (pinned: String?, node: String, said: String?) in NodeProof.judge(pinned: pinned, node: node, proof: said, challenge: proof.challenge, check: known) }
        #expect(judge(nil, proof.node, proof.proof) == .pin(proof.node))
        #expect(judge(proof.node, proof.node, proof.proof) == .same(proof.node))
        #expect(judge(proof.anotherNode, proof.node, proof.proof) == .other(proof.node))
        // A node that names another than its proof is by, or a proof of another challenge: never taken.
        #expect(judge(nil, proof.anotherNode, proof.proof) == .failed)
        #expect(NodeProof.judge(pinned: nil, node: proof.node, proof: proof.proof, challenge: NodeProof.challenge(), check: known) == .failed)
        // One that names no node at all, or a challenge that isn't one, is refused before any check.
        #expect(judge(nil, "n_short", proof.proof) == .failed)
        #expect(NodeProof.judge(pinned: nil, node: proof.node, proof: proof.proof, challenge: "short", check: known) == .failed)
        // A node from before offers no proof: spoken to as before.
        #expect(judge(proof.node, proof.node, nil) == .older)
    }

    @Test func untilThisBuildCanCheckAProofEveryNodeIsSpokenToAsBefore() throws {
        let proof = try #require(vectors.nodeProofs.first)
        #expect(NodeProof.judge(pinned: nil, node: proof.node, proof: proof.proof, challenge: proof.challenge, check: .none) == .older)
        #expect(NodeProof.judge(pinned: proof.anotherNode, node: proof.node, proof: proof.proof, challenge: proof.challenge, check: .none) == .older)
    }

    @Test func aPairingFromBeforeHasNoNodePinnedAndOneSavedSinceKeepsIt() throws {
        let before = Data(#"{"origin":"https://node.example.test","device":"c_x","name":"Phone","fleet":"f_x","nodeName":"keep"}"#.utf8)
        #expect(try JSONDecoder().decode(PairedNode.self, from: before).nodeId == nil)
        var since = try JSONDecoder().decode(PairedNode.self, from: before)
        since.nodeId = vectors.nodeProofs[0].node
        #expect(try JSONDecoder().decode(PairedNode.self, from: JSONEncoder().encode(since)).nodeId == vectors.nodeProofs[0].node)
    }
}
