package sh.invincible.bot.core

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parity vectors (apps/apple/InvincibleTests/Fixtures/core-vectors.json, written by apps/apple/scripts/vectors.ts and
 * checked against packages/core before they are written): what the Apple app is held to, this app is held to, byte
 * for byte. Every key in them is fake (the scalar is 0x11 × 32, the invite's secret says what it is).
 */
class VectorsTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    private val params: ECParameterSpec =
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)

    private fun publicKey(point: ByteArray): PublicKey {
        require(point.size == 65 && point[0] == 0x04.toByte())
        val x = BigInteger(1, point.copyOfRange(1, 33))
        val y = BigInteger(1, point.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }

    private fun verifies(key: PublicKey, message: ByteArray, raw: ByteArray): Boolean =
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(message)
            verify(EcdsaSignature.derFromRaw(raw))
        }

    /** The fake scalar's key, signing as a phone's Keystore key would. */
    private val signer = object : Signer {
        val key = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(v["identity"]["scalarHex"].string!!, 16), params))
        override val device = v["identity"]["device"].string!!
        override fun sign(message: ByteArray): ByteArray =
            Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(message)
                EcdsaSignature.rawFromDer(sign())
            }
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    @Test fun base64urlIsCoresBothWays() {
        for (c in v["base64url"]["encode"].list) assertEquals(c["b64u"].string, Base64Url.encode(hexBytes(c["hex"].string!!)))
        for (c in v["base64url"]["decode"].list) {
            val want = c["hex"].string
            val got = Base64Url.decode(c["text"].string!!)
            if (want == null) assertNull(c["text"].string, got) else assertEquals(c["text"].string, want, hex(got!!))
        }
    }

    @Test fun theHeadersAndTheDomainAreCores() {
        val auth = v["auth"]
        assertEquals(auth["domain"].string, RequestAuth.DOMAIN)
        assertEquals(listOf(RequestAuth.DEVICE, RequestAuth.TS, RequestAuth.NONCE, RequestAuth.SIG), listOf("device", "ts", "nonce", "sig").map { auth["headers"][it].string })
        assertEquals(auth["maxSkewMs"].long, RequestAuth.MAX_SKEW_MS)
    }

    @Test fun theDeviceIdIsThePublicPointAsJavaEncodesIt() {
        val point = Base64Url.decode(v["identity"]["publicKey"].string!!)!!
        // Android's Keystore hands the public key over as X.509 (SubjectPublicKeyInfo): the id is read from that.
        val spki = publicKey(point).encoded
        assertEquals(91, spki.size)
        assertEquals(v["identity"]["device"].string, RequestAuth.deviceOf(spki))
    }

    @Test fun everyRequestIsSignedOverExactlyWhatCoreChecks() {
        val key = publicKey(Base64Url.decode(v["identity"]["publicKey"].string!!)!!)
        for (r in v["requests"].list) {
            val body = r["body"].string!!.toByteArray(Charsets.UTF_8)
            val method = r["method"].string!!
            assertEquals(r["bodySha256"].string, RequestAuth.bodyHash(body))
            val input = RequestAuth.signingInput(method, r["path"].string!!, r["ts"].string!!, r["nonce"].string!!, body)
            assertEquals(r["signingInput"].string, String(input, Charsets.UTF_8))
            // Core's signature, its high-S twin (also accepted) and its DER form, which the node refuses but the Keystore makes.
            val raw = Base64Url.decode(r["signature"].string!!)!!
            assertTrue(verifies(key, input, raw))
            assertTrue(verifies(key, input, Base64Url.decode(r["signatureHighS"].string!!)!!))
            assertArrayEquals(raw, EcdsaSignature.rawFromDer(Base64Url.decode(r["signatureDer"].string!!)!!))
            // This app's own headers: the same device, time and nonce, and a signature of its own that verifies.
            val headers = RequestAuth.headers(signer, method, r["path"].string!!, body, r["ts"].string!!, r["nonce"].string!!)
            for (name in listOf(RequestAuth.DEVICE, RequestAuth.TS, RequestAuth.NONCE)) assertEquals(r["headers"][name].string, headers[name])
            val mine = Base64Url.decode(headers[RequestAuth.SIG]!!)!!
            assertEquals(64, mine.size)
            assertTrue(verifies(key, input, mine))
            assertFalse(verifies(key, input + byteArrayOf(0), mine))
        }
    }

    // The slice 8 note's item 11: a request names the node it is for, last, so another node refuses it.
    @Test fun aRequestForANodeIsSignedOverCoresBytesWithTheNodeLast() {
        assertEquals(v["auth"]["domainNamed"].string, RequestAuth.DOMAIN_NAMED)
        val key = publicKey(Base64Url.decode(v["identity"]["publicKey"].string!!)!!)
        val requests = v["requestsForNode"].list
        assertTrue(requests.isNotEmpty())
        for (r in requests) {
            val body = r["body"].string!!.toByteArray(Charsets.UTF_8)
            val method = r["method"].string!!
            val path = r["path"].string!!
            val input = RequestAuth.signingInput(method, path, r["ts"].string!!, r["nonce"].string!!, body, r["node"].string!!)
            assertEquals(r["signingInput"].string, String(input, Charsets.UTF_8))
            // Core's own signature verifies here over those bytes, and not over the same request for no node.
            val raw = Base64Url.decode(r["signature"].string!!)!!
            assertTrue(verifies(key, input, raw))
            assertFalse(verifies(key, RequestAuth.signingInput(method, path, r["ts"].string!!, r["nonce"].string!!, body), raw))
            val headers = RequestAuth.headers(signer, method, path, body, r["ts"].string!!, r["nonce"].string!!, r["node"].string!!)
            assertTrue(verifies(key, input, Base64Url.decode(headers[RequestAuth.SIG]!!)!!))
        }
    }

    @Test fun aNonceIsSixteenCharactersOfBase64url() {
        val n = RequestAuth.nonce()
        assertEquals(16, n.length)
        assertNotNull(Base64Url.decode(n))
    }

    @Test fun canonicalJsonIsCores() {
        for (c in v["canonical"].list) assertEquals(c["canonical"].string, c["value"]!!.canonical())
    }

    @Test fun anInviteReadsAsCoreReadsIt() {
        val p = v["pairing"]
        val invite = Invite.decode(p["token"].string!!)
        assertEquals(p["invite"]["f"].string, invite.f)
        assertEquals(p["secretText"].string, String(invite.secret, Charsets.UTF_8))
        assertEquals(invite, Invite.decode(p["url"].string!!))
        for (c in p["decode"].list) {
            val want = c["invite"]
            val text = c["text"].string!!
            if (want == null || want == Json.Null) {
                assertThrows(text, Invite.Refused::class.java) { Invite.decode(text) }
            } else {
                val got = Invite.decode(text)
                assertEquals(text, listOf("e", "f", "i", "s", "k").map { want[it].string }, listOf(got.e, got.f, got.i, got.s, got.k))
            }
        }
    }

    @Test fun theProofsAndTheCodeAreCores() {
        val p = v["pairing"]
        val invite = Invite.decode(p["token"].string!!)
        val device = p["device"].string!!
        for (c in p["proofs"].list) {
            val fields = PairingMath.requestFields(invite.i, device, c["name"].string!!)
            assertEquals(c["canonical"].string, fields.canonical())
            assertEquals(c["proof"].string, PairingMath.requestProof(invite.secret, fields))
        }
        assertEquals(p["sas"].string, PairingMath.sas(invite.secret, invite.f, device))
        for (c in p["codes"].list) assertEquals(c["sas"].string, PairingMath.sas(invite.secret, c["fleet"].string!!, c["device"].string!!))
        assertEquals(p["statusProof"].string, PairingMath.statusProof(invite.secret, invite.i, device))
        val approval = PairingMath.approvalProof(invite.secret, invite.i, device, invite.f)
        assertEquals(p["approvalProof"].string, approval)
        assertTrue(PairingMath.proofMatches(approval, p["approvalProof"].string!!))
        assertFalse(PairingMath.proofMatches(approval, PairingMath.approvalProof(invite.secret, invite.i, device, "another-fleet")))
        assertFalse(PairingMath.proofMatches(approval, "not base64url!"))
    }

    private fun hexBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
