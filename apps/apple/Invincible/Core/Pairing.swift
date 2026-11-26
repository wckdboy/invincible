import CryptoKit
import Foundation

/*
 * Pairing a new device, as `packages/core/src/pairing.ts` defines it:
 *  1. A trusted node mints a one-time invite (a 32-byte secret, 10 minutes, single use).
 *  2. The joining device proves it holds the invite (an HMAC over its own fields) without ever sending the secret.
 *  3. Both sides derive a six-digit code from (secret, fleet, the joining device's key). You approve only if the codes
 *     match: someone who intercepted the invite has another key and so another code.
 *  4. The node's approval comes with a proof only the invite's holder can make, checked before it is trusted.
 */

/// An invite to join a fleet (core's `Invite`): exactly these six fields, each as core's schema has it.
struct Invite: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable { case node, client }

    let v: Int
    /// The inviting node's endpoint on the tailnet.
    let e: String
    /// The fleet the joiner must end up in (its genesis event's id).
    let f: String
    let i: String
    /// The secret, base64url. It never leaves this device.
    let s: String
    let k: Kind

    var kind: Kind { k }
    var secret: Data { Data(base64URLEncoded: s) ?? Data() }

    struct Refused: LocalizedError {
        let errorDescription: String?
    }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        // A strict object: a field core doesn't know makes it no invite at all.
        guard Set(container.allKeys.map(\.stringValue)) == ["v", "e", "f", "i", "s", "k"] else { throw Refused(errorDescription: "not an Invincible invite") }
        v = try container.decode(Int.self, forKey: Key(stringValue: "v"))
        e = try container.decode(String.self, forKey: Key(stringValue: "e"))
        f = try container.decode(String.self, forKey: Key(stringValue: "f"))
        i = try container.decode(String.self, forKey: Key(stringValue: "i"))
        s = try container.decode(String.self, forKey: Key(stringValue: "s"))
        k = try container.decode(Kind.self, forKey: Key(stringValue: "k"))
        let base64url = { (text: String) in !text.isEmpty && text.utf8.allSatisfy(Base64URL.isCharacter) }
        guard v == 1, Self.isURL(e), f.utf8.count == 43, base64url(f), base64url(i), base64url(s) else {
            throw Refused(errorDescription: "not an Invincible invite")
        }
    }

    /// What core's `z.string().url()` accepts here: an absolute URL with a scheme and a host.
    private static func isURL(_ text: String) -> Bool {
        guard let url = URLComponents(string: text), let scheme = url.scheme, !scheme.isEmpty, let host = url.host, !host.isEmpty else { return false }
        return true
    }

    /// A bare invite (`gi1.…`) or any link carrying `#pair=<invite>` (core's `decodeInvite`).
    static func decode(_ text: String) throws -> Invite {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = trimmed.firstMatch(of: #/[#&?]pair=([A-Za-z0-9._-]+)/#).map { String($0.1) } ?? trimmed
        guard token.hasPrefix("gi1."), let json = Data(base64URLEncoded: String(token.dropFirst(4))) else {
            throw Refused(errorDescription: "That isn't an Invincible invite.")
        }
        do {
            return try JSONDecoder().decode(Invite.self, from: json)
        } catch {
            throw Refused(errorDescription: "That isn't an Invincible invite.")
        }
    }
}

/// What the joining device says of itself (core's `PairRequestFields`, a client's: no box key, no endpoint).
struct PairRequestFields: Sendable {
    let invite: String
    let device: String
    let name: String
    let kind: Invite.Kind

    var object: [String: String] { ["invite": invite, "device": device, "name": name, "kind": kind.rawValue] }
}

/// Deterministic JSON as core's `canonical` writes an object of strings: keys sorted by UTF-16 code units, no
/// whitespace, each string escaped exactly as `JSON.stringify` escapes it.
enum CanonicalJSON {
    static func string(_ object: [String: String]) -> String {
        let keys = object.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        return "{" + keys.map { "\(quoted($0)):\(quoted(object[$0]!))" }.joined(separator: ",") + "}"
    }

    static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let control where control.value < 0x20: out += String(format: "\\u%04x", control.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

/// The pairing math (core's `pairing.ts`): HKDF-SHA256 from the invite's secret, then HMAC-SHA256 for each proof.
enum PairingMath {
    private static func derive(_ secret: Data, _ info: String, _ length: Int) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(), info: Data(info.utf8), outputByteCount: length)
    }

    private static func mac(_ secret: Data, _ message: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: derive(secret, "invincible/pair/v1/mac", 32))).base64URLEncodedString()
    }

    /// Proves this device holds the invite, without sending its secret.
    static func requestProof(secret: Data, fields: PairRequestFields) -> String { mac(secret, "request|\(CanonicalJSON.string(fields.object))") }

    static func statusProof(secret: Data, invite: String, device: String) -> String { mac(secret, "status|\(invite)|\(device)") }

    /// What the node sends with its approval: only the invite's holder can make it.
    static func approvalProof(secret: Data, invite: String, device: String, fleet: String) -> String { mac(secret, "approved|\(invite)|\(device)|\(fleet)") }

    /// Constant time, on the bytes; anything that isn't base64url matches nothing.
    static func proofMatches(_ expected: String, _ given: String) -> Bool {
        guard let a = Data(base64URLEncoded: expected), let b = Data(base64URLEncoded: given), a.count == b.count, !a.isEmpty else { return false }
        var difference: UInt8 = 0
        for (x, y) in zip(a, b) { difference |= x ^ y }
        return difference == 0
    }

    /// The six-digit code both screens show, as "482 913".
    static func sas(secret: Data, fleet: String, device: String) -> String {
        let bytes = derive(secret, "invincible/pair/v1/sas|\(fleet)|\(device)", 4).withUnsafeBytes { Array($0) }
        let n = (UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])) % 1_000_000
        let digits = String(format: "%06u", n)
        return "\(digits.prefix(3)) \(digits.suffix(3))"
    }
}
