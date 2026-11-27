import CryptoKit
import Foundation
import Testing
@testable import Invincible

/// Every request is signed as `packages/core/src/request-auth.ts` verifies it, checked against what core itself made.
struct RequestAuthTests {
    let vectors = Vectors.shared

    @Test func base64URLEncodesAsCoreDoes() throws {
        for item in vectors.base64url.encode {
            let bytes = try #require(Data(hex: item.hex))
            #expect(bytes.base64URLEncodedString() == item.b64u, "\(item.hex)")
        }
    }

    @Test func base64URLDecodesWhatCoreDecodesAndRefusesTheRest() {
        for item in vectors.base64url.decode {
            #expect(Data(base64URLEncoded: item.text)?.hex == item.hex, "\(item.text)")
        }
    }

    @Test func theHeaderNamesAndDomainAreCores() {
        #expect(RequestAuth.domain == vectors.auth.domain)
        #expect(RequestAuth.domainNamed == vectors.auth.domainNamed)
        #expect(RequestAuth.Header.device == vectors.auth.headers["device"])
        #expect(RequestAuth.Header.ts == vectors.auth.headers["ts"])
        #expect(RequestAuth.Header.nonce == vectors.auth.headers["nonce"])
        #expect(RequestAuth.Header.sig == vectors.auth.headers["sig"])
    }

    @Test func theDeviceIdIsCPlusTheUncompressedPublicKey() throws {
        let key = try P256.Signing.PrivateKey(rawRepresentation: #require(Data(hex: vectors.identity.scalarHex)))
        #expect(key.publicKey.x963Representation.base64URLEncodedString() == vectors.identity.publicKey)
        #expect(DeviceID.client(publicKey: key.publicKey.x963Representation) == vectors.identity.device)
        #expect(DeviceID.isClient(vectors.identity.device))
        #expect(!DeviceID.isClient("n_" + vectors.identity.device.dropFirst(2)))
        #expect(!DeviceID.isClient(String(vectors.identity.device.dropLast())))
    }

    @Test func theSigningInputIsCoresByteForByte() {
        for request in vectors.requests {
            let input = RequestAuth.signingInput(method: request.method, path: request.path, ts: request.ts, nonce: request.nonce, body: Data(request.body.utf8))
            #expect(input == Data(request.signingInput.utf8), "\(request.method) \(request.path)")
            #expect(RequestAuth.bodyHash(Data(request.body.utf8)) == request.bodySha256)
        }
    }

    // The slice 8 note's item 11: a request names the node it is for, last, so another node refuses it.
    @Test func aRequestForANodeIsSignedOverCoresBytesWithTheNodeLast() throws {
        let key = try P256.Signing.PrivateKey(rawRepresentation: #require(Data(hex: vectors.identity.scalarHex)))
        #expect(!vectors.requestsForNode.isEmpty)
        for request in vectors.requestsForNode {
            let body = Data(request.body.utf8)
            #expect(RequestAuth.signingInput(method: request.method, path: request.path, ts: request.ts, nonce: request.nonce, body: body, node: request.node) == Data(request.signingInput.utf8), "\(request.method) \(request.path)")
            // Core's own signature verifies here, over those bytes and no others: not the same request for no node.
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: #require(Data(base64URLEncoded: request.signature)))
            #expect(key.publicKey.isValidSignature(signature, for: Data(request.signingInput.utf8)))
            #expect(!key.publicKey.isValidSignature(signature, for: RequestAuth.signingInput(method: request.method, path: request.path, ts: request.ts, nonce: request.nonce, body: body)))
            // And the headers this device sends for it are signed over exactly them.
            let headers = try RequestAuth.headers(signer: FakeSigner(key: key), method: request.method, path: request.path, body: body, ts: request.ts, nonce: request.nonce, node: request.node)
            let sig = try #require(headers[RequestAuth.Header.sig].flatMap { Data(base64URLEncoded: $0) })
            #expect(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: sig), for: Data(request.signingInput.utf8)))
        }
    }

    @Test func aDERSignatureBecomesTheRawRSThatCoreVerifies() throws {
        for request in vectors.requests {
            let der = try #require(Data(base64URLEncoded: request.signatureDer))
            #expect(try RequestAuth.rawSignature(fromDER: der).base64URLEncodedString() == request.signature)
        }
    }

    @Test func coresSignaturesVerifyHereUnderTheSameKey() throws {
        let publicKey = try P256.Signing.PublicKey(x963Representation: #require(Data(base64URLEncoded: vectors.identity.publicKey)))
        for request in vectors.requests {
            let input = Data(request.signingInput.utf8)
            for encoded in [request.signature, request.signatureHighS] {
                let signature = try P256.Signing.ECDSASignature(rawRepresentation: #require(Data(base64URLEncoded: encoded)))
                #expect(publicKey.isValidSignature(signature, for: input), "\(request.path)")
            }
        }
    }

    @Test func theHeadersCarryTheDeviceTimeNonceAndRawSignature() throws {
        let key = try P256.Signing.PrivateKey(rawRepresentation: #require(Data(hex: vectors.identity.scalarHex)))
        let signer = FakeSigner(key: key)
        for request in vectors.requests {
            let headers = try RequestAuth.headers(signer: signer, method: request.method, path: request.path, body: Data(request.body.utf8), ts: request.ts, nonce: request.nonce)
            #expect(headers[RequestAuth.Header.device] == request.headers["x-invincible-device"])
            #expect(headers[RequestAuth.Header.ts] == request.ts)
            #expect(headers[RequestAuth.Header.nonce] == request.nonce)
            // ECDSA here is randomized, so the signature differs from core's; it must still be 64 raw bytes that verify.
            let sig = try #require(headers[RequestAuth.Header.sig].flatMap { Data(base64URLEncoded: $0) })
            #expect(sig.count == 64)
            #expect(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: sig), for: Data(request.signingInput.utf8)))
        }
    }

    @Test func timestampsAreMillisecondsAndNoncesAreSixteenCharacters() {
        #expect(RequestAuth.timestamp(Date(timeIntervalSince1970: 1_763_200_000.123_9)) == "1763200000123")
        let nonce = RequestAuth.newNonce()
        #expect(nonce.count == 16)
        #expect(nonce.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        #expect(RequestAuth.newNonce() != nonce)
    }
}

/// Signs with a CryptoKit key, as a device key does: DER from the signer, raw r||s on the wire.
struct FakeSigner: RequestSigner {
    let key: P256.Signing.PrivateKey
    var device: String { DeviceID.client(publicKey: key.publicKey.x963Representation) }
    func sign(_ message: Data) throws -> Data {
        try RequestAuth.rawSignature(fromDER: key.signature(for: message).derRepresentation)
    }
}
