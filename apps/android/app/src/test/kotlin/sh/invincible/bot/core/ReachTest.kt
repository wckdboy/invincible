package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** What the app does about its notifications when it comes to the front, held to core's notifyReach and isQuietKind. */
class ReachTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    @Test fun everyCaseIsCoresOwnWord() {
        val cases = v["notifyReach"].list
        assertEquals(36, cases.size)
        for (c in cases) {
            val step = Reach.step(c["permission"].string!!, c["subscribed"].bool == true, c["lost"].bool == true, c["reachable"].int!!, c["localOn"].bool == true)
            assertEquals(c.toString(), c["step"].string, step.word)
        }
    }

    @Test fun newsIsToldQuietlyAsEveryDeviceTellsIt() {
        val kinds = v["notifyQuiet"].list
        assertEquals(9, kinds.size)
        for (k in kinds) assertEquals(k.toString(), k["quiet"].bool == true, Reach.quiet(k["kind"].string))
        assertEquals(false, Reach.quiet(null))
    }

    @Test fun aLostSubscriptionIsSaidAsTheWebAppSaysIt() {
        // 18 November 2026, noon UTC.
        assertEquals("They were on until 18 Nov: ntfy (UnifiedPush)'s push service stopped taking them.", Reach.lostLine(1_795_003_200_000, "ntfy (UnifiedPush)", java.time.ZoneOffset.UTC))
        assertEquals("They were on until 18 Nov: the push service you allowed stopped taking them.", Reach.lostLine(1_795_003_200_000, "a push service you allowed", java.time.ZoneOffset.UTC))
    }
}
