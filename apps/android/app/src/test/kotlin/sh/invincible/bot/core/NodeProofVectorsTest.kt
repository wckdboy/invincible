package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Whoami's answers as nodes send them, malformed ones too, each judged with no node pinned and with one, a moment before
 * the cutoff and at it (the vectors' `judgedNodeProofs`): NodeProof.judge gives every one the verdict core's
 * judgeNodeProof gives, as the Apple app does.
 */
class NodeProofVectorsTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())

    @Test fun eachWhoamiAnswerIsJudgedAsCoreJudgesIt() {
        val cases = v["judgedNodeProofs"].list
        assertEquals(48, cases.size)
        val apart = cases.mapNotNull { case ->
            val pinned = case["pinned"].string
            val got = when (val said = NodeProof.judge(pinned, Json.parse(case["answer"].string!!), case["challenge"].string!!, now = case["now"].long!!)) {
                is NodeProof.Proven.Pin -> "pin" to said.node
                is NodeProof.Proven.Same -> "same" to said.node
                is NodeProof.Proven.Other -> "other" to said.node
                NodeProof.Proven.Older -> "older" to null
                NodeProof.Proven.Failed -> "false" to null
            }
            val want = case["judged"]
            if (got == (want["kind"].string to want["node"].string)) null
            else "${case["what"].string}, ${if (pinned == null) "none pinned" else "pinned"}, at ${case["now"].long}: core ${want?.text()}, Kotlin $got"
        }
        // (Every case that disagrees, named: not only the first.)
        assertEquals(emptyList<String>(), apart)
    }
}
