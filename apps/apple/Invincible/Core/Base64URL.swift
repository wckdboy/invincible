import Foundation

/// base64url as `packages/core/src/bytes.ts` writes and reads it: unpadded, `-` and `_` for `+` and `/`.
extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Only A–Z, a–z, 0–9, `-` and `_`, with no padding and never a length one past a multiple of four (core's
    /// `fromB64u`); anything else is nil.
    init?(base64URLEncoded text: String) {
        guard text.utf8.allSatisfy(Base64URL.isCharacter), text.utf8.count % 4 != 1 else { return nil }
        let standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: standard + String(repeating: "=", count: (4 - text.utf8.count % 4) % 4)) else { return nil }
        self = data
    }
}

enum Base64URL {
    static func isCharacter(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"): true
        default: false
        }
    }
}
