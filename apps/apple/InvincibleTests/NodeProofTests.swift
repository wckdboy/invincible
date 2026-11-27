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

    /// A moment before the cutoff (RequestAuth.namedFrom).
    let before = RequestAuth.namedFrom.addingTimeInterval(-0.001)

    @Test func theFirstProofPinsTheSameIsKeptAnotherAndAFailedOneAreRefusedAndANodeFromBeforeIsAsBeforeUnpinned() throws {
        let proof = try #require(vectors.nodeProofs.first)
        let judge = { (pinned: String?, node: String, said: String?) in
            NodeProof.judge(pinned: pinned, said: .init(node: node, proof: said.map { .text($0) } ?? .absent), challenge: proof.challenge, now: before, check: known)
        }
        #expect(judge(nil, proof.node, proof.proof) == .pin(proof.node))
        #expect(judge(proof.node, proof.node, proof.proof) == .same(proof.node))
        #expect(judge(proof.anotherNode, proof.node, proof.proof) == .other(proof.node))
        // A node that names another than its proof is by, or a proof of another challenge: never taken.
        #expect(judge(nil, proof.anotherNode, proof.proof) == .failed)
        #expect(NodeProof.judge(pinned: nil, said: .init(node: proof.node, proof: .text(proof.proof)), challenge: NodeProof.challenge(), now: before, check: known) == .failed)
        // One that names no node at all, or a challenge that isn't one, is refused before any check.
        #expect(judge(nil, "n_short", proof.proof) == .failed)
        #expect(NodeProof.judge(pinned: nil, said: .init(node: proof.node, proof: .text(proof.proof)), challenge: "short", now: before, check: known) == .failed)
        // A node from before offers no proof: spoken to as before while none is pinned; once one is, it fails (L7).
        #expect(judge(nil, proof.node, nil) == .older)
        #expect(judge(proof.node, proof.node, nil) == .failed)
    }

    // The review of apps-name-node, I1 and L7, and the lead's word of 27 November 2026: each whoami answer, as a node sends
    // it, malformed ones too, with a pin and without, either side of the cutoff, judged as core judges it.
    @Test func everyAnswerIsJudgedAsCoreJudgesIt() throws {
        #expect(RequestAuth.namedFrom == Date(timeIntervalSince1970: vectors.auth.namedFrom / 1000))
        #expect(vectors.judgedNodeProofs.count == 48)
        for c in vectors.judgedNodeProofs {
            let said = try JSONDecoder().decode(NodeProof.Said.self, from: Data(c.answer.utf8))
            let judged = NodeProof.judge(pinned: c.pinned, said: said, challenge: c.challenge, now: Date(timeIntervalSince1970: c.now / 1000), check: .app)
            let expected: NodeProof.Proven? = switch c.judged.kind {
            case "pin": c.judged.node.map { .pin($0) }
            case "same": c.judged.node.map { .same($0) }
            case "other": c.judged.node.map { .other($0) }
            case "older": .older
            case "false": .failed
            default: nil
            }
            #expect(judged == expected, "\(c.what), pinned: \(c.pinned != nil), at \(c.now)")
        }
    }

    // The lead's word of 27 November 2026: whoami's proof is checked under Ed25519's strict rule, as core checks it.
    @Test func theAppsCheckerTakesCoresProofsUnderTheStrictRuleAndNothingElse() throws {
        for proof in vectors.nodeProofs {
            #expect(NodeProof.Checker.app.verify(proof.node, proof.challenge, proof.proof))
            #expect(NodeProof.judge(pinned: nil, said: .init(node: proof.node, proof: .text(proof.proof)), challenge: proof.challenge, now: .now, check: .app) == .pin(proof.node))
            #expect(!NodeProof.Checker.app.verify(proof.anotherNode, proof.challenge, proof.proof))
            #expect(!NodeProof.Checker.app.verify(proof.node, NodeProof.challenge(), proof.proof))
        }
        // A node id that is the identity's point, and its "proof" (R the identity, S zero), which verifies anything under
        // ZIP-215: refused, as core refuses it.
        var identity = Data(count: 32)
        identity[0] = 1
        let weak = "n_" + identity.base64URLEncodedString()
        let forgery = (identity + Data(count: 32)).base64URLEncodedString()
        #expect(NodeProof.judge(pinned: nil, said: .init(node: weak, proof: .text(forgery)), challenge: vectors.nodeProofs[0].challenge, now: .now, check: .app) == .failed)
        // A proof written another way in base64url (its last character's unused bits set) is never taken, as core's isn't.
        let proof = vectors.nodeProofs[0]
        let last = proof.proof.last!
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let other = alphabet.first { $0 != last && Data(base64URLEncoded: String(proof.proof.dropLast()) + String($0)) == Data(base64URLEncoded: proof.proof) }
        if let other { #expect(!NodeProof.Checker.app.verify(proof.node, proof.challenge, String(proof.proof.dropLast()) + String(other))) }
    }

    // The review of apps-name-node, L4: a late first proof keeps its pin only with the pairing it was asked for.
    @Test func aLateFirstProofKeepsItsPinOnlyWhileThePairingIsStillTheOneItWasAskedFor() throws {
        let suite = "sh.invincible.bot.tests.keep-pinned"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let old = PairedNode(origin: try #require(URL(string: "http://127.0.0.1:47121")), device: "c_the-old-pairings-device", name: "old", fleet: "f_a")
        old.save(to: defaults)
        #expect(PairedNode.keep(pinned: vectors.nodeProofs[0].node, for: old, in: defaults))
        #expect(PairedNode.load(from: defaults)?.nodeId == vectors.nodeProofs[0].node)
        // Forgotten and paired anew while its first proof was on its way: that proof writes nothing over the newer one.
        let newer = PairedNode(origin: try #require(URL(string: "https://newer.example.test")), device: "c_the-new-pairings-device", name: "new", fleet: "f_b")
        newer.save(to: defaults)
        #expect(!PairedNode.keep(pinned: vectors.nodeProofs[0].anotherNode, for: old, in: defaults))
        #expect(PairedNode.load(from: defaults) == newer)
    }

    @Test func aPairingFromBeforeHasNoNodePinnedAndOneSavedSinceKeepsIt() throws {
        let before = Data(#"{"origin":"https://node.example.test","device":"c_x","name":"Phone","fleet":"f_x","nodeName":"keep"}"#.utf8)
        #expect(try JSONDecoder().decode(PairedNode.self, from: before).nodeId == nil)
        var since = try JSONDecoder().decode(PairedNode.self, from: before)
        since.nodeId = vectors.nodeProofs[0].node
        #expect(try JSONDecoder().decode(PairedNode.self, from: JSONEncoder().encode(since)).nodeId == vectors.nodeProofs[0].node)
    }
}
