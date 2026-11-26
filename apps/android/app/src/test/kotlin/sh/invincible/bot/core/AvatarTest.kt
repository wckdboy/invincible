package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An agent's orb's colours, as core gives them (packages/core/src/avatar.ts, through the parity vectors' `agentOrbs`):
 * the colour you chose for it, or one of the 24 its handle picks, lit and shadowed to the same whole channel, and the
 * same second colour, on every device.
 */
class AvatarTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["agentOrbs"]!!

    @Test fun theTwentyFourTintsAndTheirNamesAreCores() {
        assertEquals(24, Avatar.AGENT_TINTS.size)
        assertEquals(v["tints"].list.map { it.string }, Avatar.AGENT_TINTS)
        assertEquals(v["names"].list.map { it.string }, Avatar.AGENT_TINT_NAMES)
    }

    @Test fun everyAgentsOrbIsTheColourCoreGivesIt() {
        val agents = v["agents"].list
        assertTrue(agents.size >= 10)
        for (k in agents) {
            val want = k["colors"]
            val got = Avatar.agentColors(k["id"].string!!, k["avatar"])
            assertEquals(
                k.text(),
                listOf(want["tint"].string, want["light"].string, want["deep"].string, want["second"].string, want["chosen"].bool),
                listOf(got.tint, got.light, got.deep, got.second, got.chosen),
            )
        }
        // A drawing's profile (v 1) and a malformed one colour nothing: the handle's colour, as with none at all.
        assertTrue(agents.any { it["avatar"]["v"].double == 1.0 && it["colors"]["chosen"].bool == false })
        assertTrue(agents.any { it["avatar"]["v"].string == "2" && it["colors"]["chosen"].bool == false })
    }

    @Test fun aHandlesSeedIsCoresAndTheOrbsOwn() {
        for (s in v["seeds"].list) {
            assertEquals(s["id"].string, s["seed"].long, Avatar.handleSeed(s["id"].string!!))
            assertEquals(s["id"].string, OrbMotion.seed(s["id"].string!!), Avatar.handleSeed(s["id"].string!!))
        }
    }

    @Test fun aBlendIsCoresToTheChannel() {
        for (b in v["blends"].list) assertEquals(b.text(), b["blend"].string, Avatar.blendHex(b["from"].string!!, b["to"].string!!, b["t"].double!!))
    }

    @Test fun theNearestTintIsCores() {
        for (c in v["nearest"].list) assertEquals(c["color"].string, c["at"].int, Avatar.nearestTint(c["color"].string!!))
    }

    @Test fun aColourYouChooseIsSavedAsTheNodeTakesIt() {
        // Untouched, the avatar is left out and what is saved stays; a swatch is { v: 2, color }; its handle's colour is null.
        assertNull(Avatar.edited("#3abeff", touched = false))
        assertNull(Avatar.edited(null, touched = false))
        assertEquals("""{"v":2,"color":"#3abeff"}""", Avatar.edited("#3ABEFF", touched = true)!!.text())
        assertEquals(Json.Null, Avatar.edited(null, touched = true))
        assertEquals("""{"id":"ada","name":"Ada"}""", Json.obj("id" to "ada", "name" to "Ada", "avatar" to Avatar.edited("#3abeff", touched = false)).text())
        assertEquals("""{"id":"ada","name":"Ada","avatar":null}""", Json.obj("id" to "ada", "name" to "Ada", "avatar" to Avatar.edited(null, touched = true)).text())
        // What is chosen is what the orb is drawn in.
        val saved = Avatar.edited(Avatar.AGENT_TINTS[15], touched = true)
        assertTrue(Avatar.isOrbProfile(saved))
        assertEquals(Avatar.AGENT_TINTS[15], Avatar.agentColors("ada", saved).tint)
        assertEquals(Avatar.agentColors("ada"), Avatar.agentColors("ada", Json.Null))
    }

    @Test fun onlyAColourYouChoseIsOne() {
        assertEquals("#3abeff", Avatar.chosen(Json.parse("""{"v":2,"color":"#3ABEFF"}""")))
        for (other in listOf(
            """{"v":1,"form":"round","color":"#be7153","accent":"#6b4536","eyes":"oval","accessory":"none","temperament":"calm"}""",
            """{"v":2,"color":"#3abeff","form":"round"}""", """{"v":"2","color":"#3abeff"}""", """{"v":2,"color":"blue"}""",
            """{"v":2,"color":"#3abeff\n"}""", """{"v":2.5,"color":"#3abeff"}""", """[2,"#3abeff"]""", """{"look":"coder"}""", "null",
        )) {
            assertNull(other, Avatar.chosen(Json.parse(other)))
            assertFalse(other, Avatar.isOrbProfile(Json.parse(other)))
        }
        assertNull(Avatar.chosen(null))
    }
}
