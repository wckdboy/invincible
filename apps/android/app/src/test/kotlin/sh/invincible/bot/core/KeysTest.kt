package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Keys and the providers they are for, as the PWA and the Apple app read them: the parity vectors' `keys`, answer for answer. */
class KeysTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["keys"]!!
    private val view = Providers.of(Json.obj("providers" to v["providers"], "presets" to v["presets"], "signIns" to v["signIns"]))

    @Test
    fun aKeyIsKnownByHowItBeginsAndASignInIsNeverTakenForOne() {
        val cases = v["detected"].list
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val key = c["key"].string!!
            assertEquals("provider of $key", c["provider"].string, Keys.providerOf(key, view))
            val want = c["signIn"].takeIf { it is Json.Obj }?.let { Providers.SignIn(it["vendor"].string!!, it["tool"].string!!, it["why"].string!!) }
            assertEquals("sign-in of $key", want, Keys.signIn(key, view))
        }
    }

    @Test
    fun aCodingPlanSaysWhoMayUseIt() {
        for (c in v["plans"].list) {
            val preset = view.presets.first { it.id == c["id"].string }
            assertEquals("plan line of ${preset.id}", c["line"].string, Keys.planLine(preset))
        }
    }

    @Test
    fun aProviderIsSetUpOnceItsKeyIsSealed() {
        val cases = v["setups"].list
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val (request, say) = Keys.setup(view, c["provider"].string!!, c["secret"].string!!, c["may"].bool!!, c["baseUrl"].string)
            val want = c["request"].takeIf { it is Json.Obj }
            assertEquals("request for ${c["provider"].string}", want?.canonical(), request?.json()?.canonical())
            assertEquals("say for ${c["provider"].string}", c["say"].string, say)
        }
    }

    @Test
    fun aNameIsWhatTheVaultTakes() {
        assertTrue(Keys.nameOk("openrouter-2"))
        assertTrue(Keys.nameOk("a.b_c:d-e"))
        assertFalse(Keys.nameOk(""))
        assertFalse(Keys.nameOk("has space"))
        assertFalse(Keys.nameOk("x".repeat(129)))
    }
}
