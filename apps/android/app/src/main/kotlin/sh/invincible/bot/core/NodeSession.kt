package sh.invincible.bot.core

/**
 * A session with the node this phone is paired with, and its proof of which node it is (NodeProof): whoami, asked with a
 * fresh challenge, judged against the node pinned ([pin]); the first proof pins the node, kept with the pairing
 * ([keep]); a node that proves to be another, or whose proof fails, is asked nothing more (NodePin) and said so
 * ([refused]). The primary's name comes with whoami's answer ([named]).
 *
 * Kept apart from AppModel, which needs an Android Context, so that the JVM tests hold it to its rules.
 */
class NodeSession(
    val pin: NodePin,
    private val ask: suspend (challenge: String) -> Json,
    private val keep: (node: String) -> Unit,
    private val named: (String?) -> Unit,
    private val refused: (NodeError) -> Unit,
) {
    /** Whoami has been asked, and its proof judged, this session. */
    private var proven = false

    /** Whoami, proven, once a session and before anything else is asked. False: this phone's node isn't the one answering. */
    suspend fun prove(): Boolean {
        pin.refused?.let {
            refused(it)
            return false
        }
        if (proven) return true
        val challenge = NodeProof.challenge()
        // (Not answered: the reads after say why, and it is asked again at the next refresh.)
        val who = try {
            ask(challenge)
        } catch (e: NodeError) {
            return true
        }
        proven = true
        named(who["primaryName"].string)
        when (val said = NodeProof.judge(pin.node, who["node"].string, who["proof"].string, challenge)) {
            is NodeProof.Proven.Pin -> {
                pin.pin(said.node)
                keep(said.node)
            }
            is NodeProof.Proven.Other -> return notYours(NodeError.notYours(said.node))
            NodeProof.Proven.Failed -> return notYours(NodeError.notYours(null))
            else -> {}
        }
        return true
    }

    /** The node at this address isn't this phone's: said, and nothing more is sent there. */
    private fun notYours(why: NodeError): Boolean {
        pin.refuse(why)
        refused(why)
        return false
    }

    /** Try again, at a node that proved to be another: its proof is asked for afresh. */
    suspend fun tryAgain(): Boolean {
        pin.clear()
        proven = false
        return prove()
    }
}
