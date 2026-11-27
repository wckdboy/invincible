import CryptoKit
import Foundation

/// Device ids are self-certifying: the id is the public key (`packages/core/src/identity.ts`). A client's is `c_` and
/// its P-256 key, uncompressed (0x04, x, y), in base64url: what WebCrypto's raw export gives the PWA.
enum DeviceID {
    static func client(publicKey: Data) -> String { "c_" + publicKey.base64URLEncodedString() }

    /// core's `isClientId`: `c_` and 87 base64url characters.
    static func isClient(_ id: String) -> Bool {
        id.hasPrefix("c_") && id.utf8.count == 89 && id.utf8.dropFirst(2).allSatisfy(Base64URL.isCharacter)
    }
}

/// What signs this device's requests: its key, which never leaves wherever it is kept.
protocol RequestSigner: Sendable {
    var device: String { get }
    /// An ECDSA P-256 / SHA-256 signature of `message`, as 64 raw bytes (r, then s).
    func sign(_ message: Data) throws -> Data
}

/**
 * Every request to a node is signed by this device's key over (method, path, time, nonce, body hash) and the node it is
 * for, as `packages/core/src/request-auth.ts` verifies it: domain-separated by `invincible-req/v2`, the parts joined by
 * newlines, the body hashed with SHA-256 into base64url, the node's id last, so another node refuses it (the slice 8
 * note's item 11). Without a node, `invincible-req/v1` and no id: what whoami's proof is asked with (NodeProof), and what
 * a node from before reads. The node verifies IEEE P1363 signatures (r || s, 64 bytes): never DER.
 */
enum RequestAuth {
    static let domain = "invincible-req/v1"
    static let domainNamed = "invincible-req/v2"
    /// core's REQUESTS_NAME_THEIR_NODE_FROM, 14 December 2026: from then a node takes a request that names no node only for
    /// whoami, and every node proves which it is, so a whoami that gives no proof is a proof that fails (NodeProof.judge).
    static let namedFrom = Date(timeIntervalSince1970: 1_797_206_400)

    enum Header {
        static let device = "x-invincible-device"
        static let ts = "x-invincible-ts"
        static let nonce = "x-invincible-nonce"
        static let sig = "x-invincible-sig"
        /// This device's time zone, beside the signature (core's ZONE_HEADER): the time it says it is in an answer to
        /// you. Only a hint; a node from before it ignores it.
        static let zone = "x-invincible-tz"
    }

    /// The bytes signed. `path` is the path and query exactly as the request carries them; `node`, the node it is for, as
    /// that node proved it (v2), or none (v1).
    static func signingInput(method: String, path: String, ts: String, nonce: String, body: Data, node: String? = nil) -> Data {
        let parts = [method.uppercased(), path, ts, nonce, bodyHash(body)] + (node.map { [$0] } ?? [])
        return Data("\(node == nil ? domain : domainNamed)\n\(parts.joined(separator: "\n"))".utf8)
    }

    static func bodyHash(_ body: Data) -> String { Data(SHA256.hash(data: body)).base64URLEncodedString() }

    /// The Security framework signs in DER (X9.62); the node reads r || s.
    static func rawSignature(fromDER der: Data) throws -> Data {
        try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation
    }

    static func headers(signer: some RequestSigner, method: String, path: String, body: Data, ts: String, nonce: String, node: String? = nil) throws -> [String: String] {
        let signature = try signer.sign(signingInput(method: method, path: path, ts: ts, nonce: nonce, body: body, node: node))
        return [Header.device: signer.device, Header.ts: ts, Header.nonce: nonce, Header.sig: signature.base64URLEncodedString()]
    }

    /// Milliseconds since 1970, as `Date.now()` gives them. The node refuses a time more than a minute from its own.
    static func timestamp(_ date: Date = .now) -> String { String(Int64((date.timeIntervalSince1970 * 1000).rounded(.down))) }

    /// 12 random bytes in base64url (core's `randomId(12)`): the node accepts each (device, nonce) once.
    static func newNonce() -> String {
        var random = SystemRandomNumberGenerator()
        return Data((0..<12).map { _ in UInt8.random(in: .min ... .max, using: &random) }).base64URLEncodedString()
    }
}
