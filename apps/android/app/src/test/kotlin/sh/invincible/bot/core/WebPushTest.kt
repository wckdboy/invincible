package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Web Push as a user agent reads it: RFC 8291's own example (§5, Appendix A), byte for byte, as core's webpush.test.ts holds it. */
class WebPushTest {
    private fun b64(text: String) = Base64Url.decode(text)!!

    private val keys = WebPush.Keys(
        privateScalar = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
        publicPoint = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        auth = b64("BTBZMqHH6r4Tts7J_aSIgg"),
    )
    private val message = b64(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    )

    @Test
    fun theRfcsOwnMessageReads() {
        assertEquals("When I grow up, I want to be a watermelon", String(WebPush.decrypt(message, keys), Charsets.UTF_8))
    }

    @Test
    fun anotherSecretOrAChangedByteReadsNothing() {
        assertThrows(Exception::class.java) { WebPush.decrypt(message, WebPush.Keys(keys.privateScalar, keys.publicPoint, ByteArray(16))) }
        val changed = message.copyOf().also { it[it.size - 3] = (it[it.size - 3].toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { WebPush.decrypt(changed, keys) }
        assertThrows(Exception::class.java) { WebPush.decrypt(ByteArray(20), keys) }
    }

    @Test
    fun aFreshSubscriptionIsAP256PointAndASecret() {
        val fresh = WebPush.newKeys()
        assertEquals(65, fresh.publicPoint.size)
        assertEquals(4.toByte(), fresh.publicPoint[0])
        assertEquals(32, fresh.privateScalar.size)
        assertEquals(16, fresh.auth.size)
    }
}
