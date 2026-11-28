package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** An approval in plain words, as its ask says it in a chat, held to the vectors the PWA's lib/asks.ts askPlain wrote. */
class AsksVectorsTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    @Test fun eachAskIsSaidInPlainWordsAsThePwaSaysIt() {
        val cases = v["asks"]["plain"].list
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val ask = c["ask"]
            assertEquals(c.text(), c["words"].string, Asks.plain(ask["connector"].string!!, ask["tool"].string!!, ask["args"], c["label"].string))
        }
    }

    /** Its service by the connector's own name, from the node's list (GET /api/connectors), as the PWA keeps them. */
    @Test fun eachConnectorsOwnNameIsKeptAsThePwaKeepsIt() {
        val listed = v["asks"]["listed"]
        val labels = Asks.labels(listed["connectors"].list)
        assertEquals((listed["labels"] as Json.Obj).fields.mapValues { it.value.string }, labels)
        for (c in listed["asks"].list) {
            val ask = c["ask"]
            val id = ask["connector"].string!!
            assertEquals(id, c["words"].string, Asks.plain(id, ask["tool"].string!!, ask["args"], labels[id]))
        }
    }
}
