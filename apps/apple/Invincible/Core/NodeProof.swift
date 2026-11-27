import Foundation

/**
 * Which node this device speaks to, proven (the slice 8 note's item 11; core's `judgeNodeProof`, request-auth.ts): asked
 * with a fresh challenge, whoami answers with the node's Ed25519 signature of it under `invincible-node/v1`, by the key
 * its id is. The first proof pins the node, and what this device signs names it from then on (RequestAuth's v2). A node
 * that proves to be another, or whose proof fails, is asked nothing more (NodePin). A node from before, which proves
 * nothing, is spoken to as before while none is pinned and until the cutoff; past either, giving no proof fails.
 */
enum NodeProof {
    static let domain = "invincible-node/v1"

    /// core's NODE_CHALLENGE: 16 to 64 base64url characters.
    static func isChallenge(_ text: String) -> Bool {
        (16...64).contains(text.utf8.count) && text.utf8.allSatisfy(Base64URL.isCharacter)
    }

    /// A fresh challenge: 24 random bytes in base64url (core's nodeChallenge).
    static func challenge() -> String {
        var random = SystemRandomNumberGenerator()
        return Data((0..<24).map { _ in UInt8.random(in: .min ... .max, using: &random) }).base64URLEncodedString()
    }

    /// What a node signs to prove, to a device that asks, that it is the node its id names.
    static func signingInput(_ challenge: String) -> Data { Data("\(domain)\n\(challenge)".utf8) }

    /// core's isNodeId: `n_` and 43 base64url characters, an Ed25519 public key.
    static func isNode(_ id: String) -> Bool {
        id.hasPrefix("n_") && id.utf8.count == 45 && id.utf8.dropFirst(2).allSatisfy(Base64URL.isCharacter)
    }

    /// What whoami's answer says of the node, against the one pinned (core's judgeNodeProof's five answers).
    enum Proven: Equatable, Sendable {
        /// Proven, and none pinned yet: pin it, and name it in what is signed from then on.
        case pin(String)
        /// Proven, and the one pinned.
        case same(String)
        /// Proven, but another node than the one pinned: not this device's node.
        case other(String)
        /// No proof, none pinned, and before the cutoff: a node from before, spoken to as before (v1).
        case older
        /// A proof that fails: never taken.
        case failed
    }

    /// How a node's proof is checked: whether `proof` is `node`'s signature of `challenge`.
    struct Checker: Sendable {
        let verify: @Sendable (_ node: String, _ challenge: String, _ proof: String) -> Bool

        /// Ed25519's strict rule (Ed25519Strict), as core's verifyNodeProof holds it: the node's id and the proof each
        /// written as base64url writes them, the id a strict key, the proof its strict signature of the challenge.
        static let strict = Checker { node, challenge, proof in
            let id = String(node.dropFirst(2))
            guard isNode(node), let key = Data(base64URLEncoded: id), key.base64URLEncodedString() == id,
                  let signature = Data(base64URLEncoded: proof), signature.base64URLEncodedString() == proof else { return false }
            return Ed25519Strict.verify(signature: signature, message: signingInput(challenge), publicKey: key)
        }

        /// The app's own: what its sessions and its pairing check proofs with.
        static let app = strict
    }

    /// What a whoami answer says of which node it is, read as core reads it (judgeNodeProof): its `node`, when it is a
    /// string, and its `proof`: absent, a string, or something that is no proof at all (null, a number). So every app
    /// judges the same bytes alike (the parity vectors' judgedNodeProofs; the review of apps-name-node, I1).
    struct Said: Decodable, Sendable, Equatable {
        enum Proof: Sendable, Equatable {
            case absent
            case text(String)
            case malformed
        }

        let node: String?
        let proof: Proof

        init(node: String?, proof: Proof) {
            self.node = node
            self.proof = proof
        }

        init(from decoder: any Decoder) throws {
            let fields = try decoder.container(keyedBy: Field.self)
            node = try? fields.decode(String.self, forKey: .node)
            if !fields.contains(.proof) {
                proof = .absent
            } else if let text = try? fields.decode(String.self, forKey: .proof) {
                proof = .text(text)
            } else {
                proof = .malformed
            }
        }

        private enum Field: String, CodingKey {
            case node, proof
        }
    }

    /// core's judgeNodeProof, answered when `now`: a proof that holds pins the node or finds it the same or another; one
    /// that fails, or an answer whose proof is no proof, is never taken. An answer that gives no proof is a node from
    /// before only while none is pinned and before the cutoff (RequestAuth.namedFrom); else it fails too (the review of
    /// apps-name-node, L7; the lead's word of 27 November 2026).
    static func judge(pinned: String?, said: Said, challenge: String, now: Date, check: Checker) -> Proven {
        guard case .text(let proof) = said.proof else {
            return said.proof == .absent && pinned == nil && now < RequestAuth.namedFrom ? .older : .failed
        }
        guard let node = said.node, isNode(node), isChallenge(challenge), check.verify(node, challenge, proof) else { return .failed }
        guard let pinned else { return .pin(node) }
        return node == pinned ? .same(node) : .other(node)
    }
}
