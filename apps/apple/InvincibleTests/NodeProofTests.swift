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

    // The lead's word of 27 November 2026: whoami's proof is checked under Ed25519's strict rule, as core checks it.
    @Test func theAppsCheckerTakesCoresProofsUnderTheStrictRuleAndNothingElse() throws {
        for proof in vectors.nodeProofs {
            #expect(NodeProof.Checker.app.verify(proof.node, proof.challenge, proof.proof))
            #expect(NodeProof.judge(pinned: nil, node: proof.node, proof: proof.proof, challenge: proof.challenge, check: .app) == .pin(proof.node))
            #expect(!NodeProof.Checker.app.verify(proof.anotherNode, proof.challenge, proof.proof))
            #expect(!NodeProof.Checker.app.verify(proof.node, NodeProof.challenge(), proof.proof))
        }
        // A node id that is the identity's point, and its "proof" (R the identity, S zero), which verifies anything under
        // ZIP-215: refused, as core refuses it.
        var identity = Data(count: 32)
        identity[0] = 1
        let weak = "n_" + identity.base64URLEncodedString()
        let forgery = (identity + Data(count: 32)).base64URLEncodedString()
        #expect(NodeProof.judge(pinned: nil, node: weak, proof: forgery, challenge: vectors.nodeProofs[0].challenge, check: .app) == .failed)
        // A proof written another way in base64url (its last character's unused bits set) is never taken, as core's isn't.
        let proof = vectors.nodeProofs[0]
        let last = proof.proof.last!
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let other = alphabet.first { $0 != last && Data(base64URLEncoded: String(proof.proof.dropLast()) + String($0)) == Data(base64URLEncoded: proof.proof) }
        if let other { #expect(!NodeProof.Checker.app.verify(proof.node, proof.challenge, String(proof.proof.dropLast()) + String(other))) }
    }

    @Test func aPairingFromBeforeHasNoNodePinnedAndOneSavedSinceKeepsIt() throws {
        let before = Data(#"{"origin":"https://node.example.test","device":"c_x","name":"Phone","fleet":"f_x","nodeName":"keep"}"#.utf8)
        #expect(try JSONDecoder().decode(PairedNode.self, from: before).nodeId == nil)
        var since = try JSONDecoder().decode(PairedNode.self, from: before)
        since.nodeId = vectors.nodeProofs[0].node
        #expect(try JSONDecoder().decode(PairedNode.self, from: JSONEncoder().encode(since)).nodeId == vectors.nodeProofs[0].node)
    }
}
