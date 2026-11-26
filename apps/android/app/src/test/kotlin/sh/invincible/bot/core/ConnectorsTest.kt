package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where a connector's key or sign-in stands, as the PWA and the Apple app say it: the parity vectors' `connectorStates`. */
class ConnectorsTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["connectorStates"]!!

    @Test
    fun eachStateIsSaidAsEverySurfaceSaysIt() {
        val cases = v.list
        assertTrue(cases.size >= 18)
        for (c in cases) {
            val want = c["state"].takeIf { it is Json.Obj }?.let { Connectors.State(it["label"].string!!, it["tone"].string!!) }
            assertEquals("${c["key"].string} / ${c["signIn"].string}", want, Connectors.state(c["key"].string!!, c["signIn"].string))
        }
    }

    @Test
    fun aConnectorIsReadAsTheNodeListsIt() {
        val c = Connector.of(Json.parse("""{"id":"gmail","label":"Gmail","kind":"google","installed":true,"key":"ready","needsOrigin":false,"tools":[{"name":"mail_send","description":"Send","class":"outward","asks":true}],"access":{"only":"primary","allowed":["Operator"]},"oauth":{"provider":"google","account":"me@example.com"},"private":true}"""))
        assertEquals("google", c.signIn)
        assertEquals("me@example.com", c.account)
        assertEquals(listOf("Operator"), c.allowed)
        assertEquals("outward · asks you first", Connectors.classLine(c.tools.single()))
        assertEquals(Connectors.State("signed in", "ok"), Connectors.state(c.key, c.signIn))
        assertEquals("https://node.example/oauth/callback", Connectors.callback("https://node.example/"))
    }
}
