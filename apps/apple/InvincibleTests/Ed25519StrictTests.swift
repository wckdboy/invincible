import Foundation
import Testing
@testable import Invincible

/// A node's Ed25519 signature under the strict rule, answered as core answers it on every one of RFC 8032's test vectors
/// and Wycheproof's (the lead's word of 27 November 2026: TS, Swift and Kotlin answer alike).
struct Ed25519StrictTests {
    let vectors = Vectors.shared

    @Test func everyVectorIsAnsweredAsCoreAnswersIt() throws {
        #expect(vectors.ed25519.count == 5 + 210)
        for v in vectors.ed25519 {
            let sig = try #require(Data(hex: v.sig), "\(v.source)")
            let msg = try #require(Data(hex: v.msg), "\(v.source)")
            let key = try #require(Data(hex: v.key), "\(v.source)")
            // The app's check (the rule's, then CryptoKit's), and the equation checked here too.
            #expect(Ed25519Strict.verify(signature: sig, message: msg, publicKey: key) == v.valid, "\(v.source)")
            #expect(Ed25519Strict.verifyPure(signature: sig, message: msg, publicKey: key) == v.valid, "\(v.source)")
            #expect(Ed25519Strict.isStrictPoint(key) == v.keyStrict, "\(v.source) key")
            #expect((sig.count == 64 && Ed25519Strict.isStrictPoint(sig.prefix(32))) == v.rStrict, "\(v.source) R")
        }
    }

    @Test func theRuleTakesEveryRFCVectorAndWycheproofsValidOnesAndNothingElse() {
        let rfc = vectors.ed25519.filter { $0.source.hasPrefix("RFC 8032") }
        #expect(rfc.count == 5 && rfc.allSatisfy(\.valid))
        #expect(vectors.ed25519.filter(\.valid).count == 5 + 117)
    }
}
