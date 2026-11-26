package sh.invincible.bot.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Joining as the Apple app's JoiningTests hold it, on the vectors' invite and device: what is sent, and what stops it. */
class JoiningTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["pairing"]
    private val invite = Invite.decode(v["token"].string!!)
    private val device = v["device"].string!!

    private class Stand(var answers: MutableList<Pair<Int, String>>) : PairTransport {
        val sent = ArrayList<Pair<String, Json.Obj>>()
        override suspend fun post(path: String, body: Json.Obj): Pair<Int, ByteArray> {
            sent += path to body
            val (status, text) = answers.removeAt(0)
            if (status == -1) throw Joining.Stop.Unreachable("no answer")
            return status to text.toByteArray()
        }
    }

    @Test fun askingSendsTheFieldsAndTheirProofAndChecksTheNodesCode() = runBlocking<Unit> {
        val stand = Stand(mutableListOf(200 to """{"status":"pending","sas":"${v["sas"].string}"}"""))
        val joining = Joining(invite, device, stand)
        assertEquals(v["sas"].string, joining.code)
        joining.ask("Invincible app on iPhone")
        val (path, body) = stand.sent.single()
        assertEquals("/link/pair/request", path)
        assertEquals(setOf("invite", "device", "name", "kind", "proof"), body.fields.keys)
        assertEquals(v["proofs"][0]["proof"].string, body["proof"].string)
        assertEquals("client", body["kind"].string)
    }

    @Test fun aNodeWithAnotherCodeStopsItThere() {
        val stand = Stand(mutableListOf(200 to """{"status":"pending","sas":"000 000"}"""))
        val e = assertThrows(Joining.Stop.Ended::class.java) { runBlocking { Joining(invite, device, stand).ask("x") } }
        assertTrue(e.message!!.contains("different code"))
    }

    @Test fun refusalsSayWhatTheyMean() {
        fun asked(status: Int, error: String): Exception =
            assertThrows(Exception::class.java) { runBlocking { Joining(invite, device, Stand(mutableListOf(status to """{"error":"$error"}"""))).ask("x") } }
        assertTrue(asked(409, "device already enrolled") is Joining.Stop.AlreadyEnrolled)
        assertTrue(asked(409, "invite already used") is Joining.Stop.AlreadyUsed)
        assertTrue(asked(404, "no such invite").let { it is Joining.Stop.Ended && it.message!!.contains("expired") })
        assertTrue(asked(400, "kind must be client") is Joining.Stop.Refused)
        assertTrue(asked(503, "busy") is Joining.Stop.Unreachable)
    }

    @Test fun anApprovalCountsOnlyWithItsProofAndForTheInvitesFleet() = runBlocking<Unit> {
        val good = """{"status":"approved","fleet":"${invite.f}","approval":"${v["approvalProof"].string}"}"""
        assertTrue(Joining(invite, device, Stand(mutableListOf(200 to good))).approved())
        val forged = """{"status":"approved","fleet":"${invite.f}","approval":"${v["statusProof"].string}"}"""
        assertThrows(Joining.Stop.Ended::class.java) { runBlocking { Joining(invite, device, Stand(mutableListOf(200 to forged))).approved() } }
        val elsewhere = """{"status":"approved","fleet":"another-fleet","approval":"${v["approvalProof"].string}"}"""
        assertThrows(Joining.Stop.Ended::class.java) { runBlocking { Joining(invite, device, Stand(mutableListOf(200 to elsewhere))).approved() } }
        assertThrows(Joining.Stop.Ended::class.java) { runBlocking { Joining(invite, device, Stand(mutableListOf(200 to """{"status":"rejected"}"""))).approved() } }
    }

    @Test fun waitingAsksEveryOneAndAHalfSecondsAndBacksOffWhenNothingAnswers() = runBlocking<Unit> {
        val approved = """{"status":"approved","fleet":"${invite.f}","approval":"${v["approvalProof"].string}"}"""
        val stand = Stand(mutableListOf(200 to """{"status":"pending"}""", -1 to "", -1 to "", 200 to """{"status":"pending"}""", 200 to approved))
        val slept = ArrayList<Long>()
        Joining(invite, device, stand).approval(sleep = { slept += it })
        assertEquals(listOf(1500L, 3000L, 6000L, 1500L), slept)
        assertEquals(v["statusProof"].string, stand.sent[0].second["proof"].string)
    }

    @Test fun theRequestsGoWhereTheLinkWasMadeForOrForABareInviteWhereItSays() {
        assertEquals("http://127.0.0.1:7778", Joining.origin(v["url"].string!!, invite))
        assertEquals(invite.e, Joining.origin(v["token"].string!!, invite))
        assertEquals("https://keep.example.org", Joining.origin("https://keep.example.org/some/where?x=1#pair=" + v["token"].string, invite))
        assertNull(Joining.origin("ftp://keep.example/#pair=" + v["token"].string, invite))
        assertEquals("https://keep.example.org/#pair=" + v["token"].string, Joining.handed("invincible:https://keep.example.org/#pair=" + v["token"].string))
        assertEquals(v["token"].string, Joining.handed("invincible://pair#pair=" + v["token"].string))
        assertNull(Joining.handed("invincible://pair#pair=gi1.nothing"))
        assertNull(Joining.handed("https://keep.example/#pair=" + v["token"].string))
    }
}
