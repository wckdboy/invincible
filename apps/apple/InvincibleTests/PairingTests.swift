import Foundation
import Testing
@testable import Invincible

/// Pairing as the PWA (`apps/web/src/pair.ts`) and the joining client (`packages/link/src/client.ts`) do it, checked
/// against what `packages/core/src/pairing.ts` itself computed.
struct PairingTests {
    let vectors = Vectors.shared
    var pairing: Vectors.Pairing { vectors.pairing }
    var secret: Data { Data(pairing.secretText.utf8) }

    @Test func anInviteIsReadAsCoreReadsItAndEverythingElseIsRefused() {
        for item in pairing.decode {
            let decoded = try? Invite.decode(item.text)
            #expect(decoded == item.invite, "\(item.text.prefix(60))")
        }
    }

    @Test func theInvitesSecretIsItsOwnBytes() throws {
        let invite = try Invite.decode(pairing.url)
        #expect(invite == pairing.invite)
        #expect(invite.secret == secret)
        #expect(invite.kind == .client)
    }

    @Test func canonicalJSONIsCoresByteForByte() {
        for item in vectors.canonical {
            #expect(CanonicalJSON.string(item.value) == item.canonical, "\(item.canonical)")
        }
    }

    @Test func theRequestsProofIsAMacOverCoresCanonicalFields() {
        for item in pairing.proofs {
            let fields = PairRequestFields(invite: pairing.invite.i, device: pairing.device, name: item.name, kind: .client)
            #expect(CanonicalJSON.string(fields.object) == item.canonical)
            #expect(PairingMath.requestProof(secret: secret, fields: fields) == item.proof)
        }
    }

    @Test func theCodeIsTheOneThePWAShowsLeadingZeroAndAll() {
        #expect(PairingMath.sas(secret: secret, fleet: pairing.invite.f, device: pairing.device) == pairing.sas)
        for code in pairing.codes {
            #expect(PairingMath.sas(secret: secret, fleet: code.fleet, device: code.device) == code.sas)
        }
        #expect(pairing.codes.contains { $0.sas.hasPrefix("0") })
    }

    @Test func theStatusAndApprovalProofsAreCores() {
        #expect(PairingMath.statusProof(secret: secret, invite: pairing.invite.i, device: pairing.device) == pairing.statusProof)
        #expect(PairingMath.approvalProof(secret: secret, invite: pairing.invite.i, device: pairing.device, fleet: pairing.invite.f) == pairing.approvalProof)
    }

    @Test func proofsMatchOnlyByteForByte() {
        let proof = pairing.approvalProof
        #expect(PairingMath.proofMatches(proof, proof))
        #expect(!PairingMath.proofMatches(proof, pairing.statusProof))
        #expect(!PairingMath.proofMatches(proof, String(proof.dropLast(2))))
        #expect(!PairingMath.proofMatches(proof, proof + "AA"))
        #expect(!PairingMath.proofMatches(proof, "not base64url!"))
        #expect(!PairingMath.proofMatches(proof, ""))
    }
}
