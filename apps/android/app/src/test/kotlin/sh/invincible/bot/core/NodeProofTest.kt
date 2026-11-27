package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.invincible.bot.app.PairedNode

/** Which node this phone speaks to, proven, judged as core's judgeNodeProof judges it (the slice 8 note's item 11). */
class NodeProofTest {
    private val v = Fixture.vectors
    private val proofs = v["nodeProofs"].list

    @Test fun theDomainTheChallengeAndANodesIdAreCores() {
        assertEquals(v["auth"]["nodeProofDomain"].string, NodeProof.DOMAIN)
        val shape = Regex(v["auth"]["nodeChallenge"].string!!)
        for (p in proofs) {
            assertEquals(p["signingInput"].string, String(NodeProof.signingInput(p["challenge"].string!!), Charsets.UTF_8))
            assertTrue(NodeProof.isChallenge(p["challenge"].string!!) && NodeProof.isNode(p["node"].string!!))
        }
        repeat(50) { val challenge = NodeProof.challenge(); assertTrue(challenge, NodeProof.isChallenge(challenge) && shape.matches(challenge)) }
        assertFalse(NodeProof.isChallenge("too-short") || NodeProof.isChallenge("A".repeat(65)) || NodeProof.isChallenge("not base64url, sixteen+"))
        assertFalse(NodeProof.isNode("c_" + proofs[0]["node"].string!!.drop(2)) || NodeProof.isNode(proofs[0]["node"].string!!.dropLast(1)))
    }

    @Test fun theFirstProofPinsTheSameIsKeptAnotherAndAFailedOneAreRefusedAndANodeFromBeforeIsAsBefore() {
        val p = proofs.first()
        val node = p["node"].string!!
        val other = p["anotherNode"].string!!
        val challenge = p["challenge"].string!!
        val proof = p["proof"].string!!
        assertEquals(NodeProof.Proven.Pin(node), NodeProof.judge(null, said(Json.Str(node), Json.Str(proof)), challenge))
        assertEquals(NodeProof.Proven.Same(node), NodeProof.judge(node, said(Json.Str(node), Json.Str(proof)), challenge))
        assertEquals(NodeProof.Proven.Other(node), NodeProof.judge(other, said(Json.Str(node), Json.Str(proof)), challenge))
        // A node that names another than its proof is by, or a proof of another challenge: never taken.
        assertEquals(NodeProof.Proven.Failed, NodeProof.judge(null, said(Json.Str(other), Json.Str(proof)), challenge))
        assertEquals(NodeProof.Proven.Failed, NodeProof.judge(null, said(Json.Str(node), Json.Str(proof)), NodeProof.challenge()))
        assertEquals(NodeProof.Proven.Failed, NodeProof.judge(null, said(null, Json.Str(proof)), challenge))
        // A node from before offers no proof: spoken to as before while none is pinned (once one is, no proof is a failed
        // one: oncePinnedNoProofIsAFailedOneAndUnpinnedItIsANodeFromBefore).
        assertEquals(NodeProof.Proven.Older, NodeProof.judge(null, said(Json.Str(node), null), challenge))
        // Every one of core's proofs holds under the strict rule, and only by its own node.
        for (q in proofs) assertEquals(NodeProof.Proven.Pin(q["node"].string!!), NodeProof.judge(null, said(Json.Str(q["node"].string!!), Json.Str(q["proof"].string!!)), q["challenge"].string!!))
    }

    /** Whoami's answer as it came (core's judgeNodeProof reads it so): absent, null, a number and a string are four answers. */
    private fun said(node: Json?, proof: Json?): Json = Json.Obj(linkedMapOf<String, Json>().also { m ->
        if (node != null) m["node"] = node
        if (proof != null) m["proof"] = proof
    })

    @Test fun oncePinnedNoProofIsAFailedOneAndUnpinnedItIsANodeFromBefore() {
        val p = proofs.first()
        val node = p["node"].string!!
        val challenge = p["challenge"].string!!
        // (The review's L7, and the shared rule 3 of 27 November 2026.)
        assertEquals(NodeProof.Proven.Failed, NodeProof.judge(node, said(Json.Str(node), null), challenge))
        assertEquals(NodeProof.Proven.Older, NodeProof.judge(null, said(Json.Str(node), null), challenge))
        assertEquals(NodeProof.Proven.Same(node), NodeProof.judge(node, said(Json.Str(node), Json.Str(p["proof"].string!!)), challenge))
    }

    @Test fun aMalformedAnswerIsAFailedProofAsCoreJudgesIt() {
        val p = proofs.first()
        val node = p["node"].string!!
        val challenge = p["challenge"].string!!
        // (The review's I1: core refuses each of these; Kotlin took the first two as a node from before.)
        for (pinned in listOf(null, node)) {
            assertEquals("proof null, pinned $pinned", NodeProof.Proven.Failed, NodeProof.judge(pinned, said(Json.Str(node), Json.Null), challenge))
            assertEquals("proof 5, pinned $pinned", NodeProof.Proven.Failed, NodeProof.judge(pinned, said(Json.Str(node), Json.Num(5.0)), challenge))
            assertEquals("no node, pinned $pinned", NodeProof.Proven.Failed, NodeProof.judge(pinned, said(null, Json.Str(p["proof"].string!!)), challenge))
            assertEquals("a node that isn't a string, pinned $pinned", NodeProof.Proven.Failed, NodeProof.judge(pinned, said(Json.Num(1.0), Json.Str(p["proof"].string!!)), challenge))
        }
    }

    @Test fun theCutoffIsCores() {
        // core's REQUESTS_NAME_THEIR_NODE_FROM, Date.UTC(2026, 11, 14).
        assertEquals(java.time.Instant.parse("2026-12-14T00:00:00Z").toEpochMilli(), NodeProof.NAMED_FROM)
    }

    @Test fun aNodeIdThatIsTheIdentitysPointProvesNothingThoughItsForgeryVerifiesAnythingUnderZip215() {
        val identity = ByteArray(32).also { it[0] = 1 }
        val weak = "n_" + Base64Url.encode(identity)
        val forgery = Base64Url.encode(identity + ByteArray(32))
        assertEquals(NodeProof.Proven.Failed, NodeProof.judge(null, said(Json.Str(weak), Json.Str(forgery)), proofs.first()["challenge"].string!!))
    }

    @Test fun aPairingFromBeforeHasNoNodePinnedAndOneSavedSinceKeepsIt() {
        val before = Json.parse("""{"origin":"https://node.example.test","device":"c_x","name":"Phone","fleet":"f_x","nodeName":"keep"}""")
        assertNull(PairedNode.of(before)!!.nodeId)
        val since = PairedNode.of(before)!!.copy(nodeId = proofs.first()["node"].string)
        assertEquals(proofs.first()["node"].string, PairedNode.of(Json.parse(since.json().text()))!!.nodeId)
    }
}
