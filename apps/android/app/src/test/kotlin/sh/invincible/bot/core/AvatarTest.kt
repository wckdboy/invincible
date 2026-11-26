package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What an agent's avatar says beyond its mark, as core gives it (packages/core/src/avatar.ts, through the parity vectors):
 * its handle's whole number, and a colour chosen before the marks, read strictly. (The mark itself: MarkVectorsTest.)
 */
class AvatarTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["agentOrbs"]!!

    @Test fun aHandlesSeedIsCores() {
        for (s in v["seeds"].list) assertEquals(s["id"].string, s["seed"].long, Avatar.handleSeed(s["id"].string!!))
    }

    @Test fun onlyAColourChosenBeforeTheMarksIsOne() {
        assertTrue(Avatar.isOrbProfile(Json.parse("""{"v":2,"color":"#3ABEFF"}""")))
        for (other in listOf(
            """{"v":1,"form":"round","color":"#be7153","accent":"#6b4536","eyes":"oval","accessory":"none","temperament":"calm"}""",
            """{"v":2,"color":"#3abeff","form":"round"}""", """{"v":"2","color":"#3abeff"}""", """{"v":2,"color":"blue"}""",
            """{"v":2,"color":"#3abeff\n"}""", """{"v":2.5,"color":"#3abeff"}""", """[2,"#3abeff"]""", """{"look":"coder"}""", "null",
            """{"v":3,"color":"#0084ba","form":10}""",
        )) {
            assertFalse(other, Avatar.isOrbProfile(Json.parse(other)))
        }
        assertFalse(Avatar.isOrbProfile(null))
    }
}
