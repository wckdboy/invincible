package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What Settings' Providers and Permissions say, read-only, held to the vectors the PWA's own code wrote: a seat's kind
 * and where it stands (lib/seats.ts), a rule of yours as a sentence (lib/rules.ts ruleSentence), and a hand-off grant
 * from one node to another (lib/grants.ts handoffTitle, handoffTerms).
 */
class SettingsWordsVectorsTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    @Test fun eachSeatsKindIsNamedAsThePwaNamesIt() {
        val kinds = (v["seats"]["kinds"] as Json.Obj).fields
        assertTrue(kinds.size >= 6)
        for ((kind, words) in kinds) assertEquals(kind, words["name"].string, Seats.kindName(kind))
        // (A later release's kind: named, never a failed page.)
        assertEquals(v["seats"]["unknownKind"]["name"].string, Seats.kindName("a-later-kind"))
    }

    @Test fun whereEachSeatStandsIsSaidAsThePwaSaysIt() {
        val now = v["seats"]["now"].long!!
        val cases = v["seats"]["states"].list
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val (word, tone) = Seats.state(c["state"]!!, c["plan"].string, now)
            assertEquals(c["state"]?.text(), c["words"]["word"].string, word)
            assertEquals(c["state"]?.text(), c["words"]["tone"].string, tone)
        }
    }

    @Test fun eachRuleIsSaidAsThePwaSaysIt() {
        val cases = v["permissions"]["rules"].list
        assertTrue(cases.size >= 5)
        for (c in cases) assertEquals(c["sentence"].string, Permissions.sentence(c["rule"]!!))
    }

    @Test fun eachHandOffIsSaidAsThePwaSaysIt() {
        val cases = v["permissions"]["handoffs"].list
        assertTrue(cases.size >= 3)
        for (c in cases) {
            assertEquals(c["title"].string, Permissions.handoffTitle(c["grant"]!!))
            assertEquals(c["terms"].string, Permissions.handoffTerms(c["grant"]["terms"]))
        }
    }
}
