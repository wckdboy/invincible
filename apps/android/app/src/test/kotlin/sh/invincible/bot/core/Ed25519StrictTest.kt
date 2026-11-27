package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A node's Ed25519 signature under the strict rule, answered as core answers it on every one of RFC 8032's test vectors
 * and Wycheproof's (the lead's word of 27 November 2026: TS, Swift and Kotlin answer alike).
 */
class Ed25519StrictTest {
    private val vectors = Fixture.vectors["ed25519"].list

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test fun everyVectorIsAnsweredAsCoreAnswersIt() {
        assertEquals(5 + 210, vectors.size)
        for (v in vectors) {
            val source = v["source"].string!!
            val key = bytes(v["key"].string!!)
            val sig = bytes(v["sig"].string!!)
            val msg = bytes(v["msg"].string!!)
            assertEquals(source, v["valid"].bool, Ed25519Strict.verify(sig, msg, key))
            assertEquals("$source key", v["keyStrict"].bool, Ed25519Strict.isStrictPoint(key))
            assertEquals("$source R", v["rStrict"].bool, sig.size == 64 && Ed25519Strict.isStrictPoint(sig.copyOfRange(0, 32)))
        }
    }

    @Test fun theRuleTakesEveryRFCVectorAndWycheproofsValidOnesAndNothingElse() {
        val rfc = vectors.filter { it["source"].string!!.startsWith("RFC 8032") }
        assertEquals(5, rfc.size)
        assertTrue(rfc.all { it["valid"].bool == true })
        assertEquals(5 + 117, vectors.count { it["valid"].bool == true })
    }
}
