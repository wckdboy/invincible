import Foundation

/**
 * Which node this device speaks to, proven (the slice 8 note's item 11; core's `judgeNodeProof`, request-auth.ts): asked
 * with a fresh challenge, whoami answers with the node's Ed25519 signature of it under `invincible-node/v1`, by the key
 * its id is. The first proof pins the node, and what this device signs names it from then on (RequestAuth's v2). A node
 * that proves to be another, or whose proof fails, is asked nothing more (NodePin). A node from before, which proves
 * nothing, is spoken to as before.
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
        /// No proof (a node from before), or none this build can check: spoken to as before (v1), until the cutoff.
        case older
        /// A proof that fails: never taken.
        case failed
    }

    /// How a node's proof is checked: whether `proof` is `node`'s signature of `challenge` (nil: this build can't check one).
    struct Checker: Sendable {
        let verify: @Sendable (_ node: String, _ challenge: String, _ proof: String) -> Bool?

        /// No check yet: every node is spoken to as one from before, unpinned and v1, as until now. (The apps' verifier,
        /// held to core's strict rule by the parity vectors, comes next.)
        static let none = Checker { _, _, _ in nil }

        /// The app's own: what its sessions and its pairing check proofs with.
        static let app = none
    }

    static func judge(pinned: String?, node: String, proof: String?, challenge: String, check: Checker) -> Proven {
        guard let proof else { return .older }
        guard isNode(node), isChallenge(challenge) else { return .failed }
        guard let held = check.verify(node, challenge, proof) else { return .older }
        guard held else { return .failed }
        guard let pinned else { return .pin(node) }
        return node == pinned ? .same(node) : .other(node)
    }
}
