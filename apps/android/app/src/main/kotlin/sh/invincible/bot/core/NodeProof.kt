package sh.invincible.bot.core

import java.security.SecureRandom

/**
 * Which node this phone speaks to, proven (the slice 8 note's item 11; core's judgeNodeProof, request-auth.ts): asked
 * with a fresh challenge, whoami answers with the node's Ed25519 signature of it under `invincible-node/v1`, by the key
 * its id is. The first proof pins the node, and what this phone signs names it from then on (RequestAuth's v2). A node
 * that proves to be another, or whose proof fails, is asked nothing more (NodePin). A node from before, which proves
 * nothing, is spoken to as before.
 */
object NodeProof {
    const val DOMAIN = "invincible-node/v1"

    private val random = SecureRandom()

    /** core's NODE_CHALLENGE: 16 to 64 base64url characters. */
    fun isChallenge(text: String): Boolean = text.length in 16..64 && text.all { Base64Url.isCharacter(it) }

    /** A fresh challenge: 24 random bytes in base64url (core's nodeChallenge). */
    fun challenge(): String = Base64Url.encode(ByteArray(24).also { random.nextBytes(it) })

    /** What a node signs to prove, to a device that asks, that it is the node its id names. */
    fun signingInput(challenge: String): ByteArray = "$DOMAIN\n$challenge".toByteArray(Charsets.UTF_8)

    /** core's isNodeId: `n_` and 43 base64url characters, an Ed25519 public key. */
    fun isNode(id: String): Boolean = id.length == 45 && id.startsWith("n_") && id.drop(2).all { Base64Url.isCharacter(it) }

    /** What whoami's answer says of the node, against the one pinned (core's judgeNodeProof's five answers). */
    sealed interface Proven {
        /** Proven, and none pinned yet: pin it, and name it in what is signed from then on. */
        data class Pin(val node: String) : Proven
        /** Proven, and the one pinned. */
        data class Same(val node: String) : Proven
        /** Proven, but another node than the one pinned: not this phone's node. */
        data class Other(val node: String) : Proven
        /** No proof: a node from before, spoken to as before (v1), until the cutoff. */
        data object Older : Proven
        /** A proof that fails: never taken. */
        data object Failed : Proven
    }

    /** How a node's proof is checked: whether [proof] is [node]'s signature of [challenge]. */
    fun interface Checker {
        fun verify(node: String, challenge: String, proof: String): Boolean
    }

    /**
     * Ed25519's strict rule (Ed25519Strict), as core's verifyNodeProof holds it: the node's id and the proof each written
     * as base64url writes them, the id a strict key, the proof its strict signature of the challenge.
     */
    val strict = Checker { node, challenge, proof ->
        val key = if (isNode(node)) Base64Url.decode(node.drop(2)) else null
        val signature = Base64Url.decode(proof)
        key != null && signature != null && Base64Url.encode(key) == node.drop(2) && Base64Url.encode(signature) == proof &&
            Ed25519Strict.verify(signature, signingInput(challenge), key)
    }

    fun judge(pinned: String?, node: String?, proof: String?, challenge: String, check: Checker = strict): Proven {
        if (proof == null) return Proven.Older
        if (node == null || !isNode(node) || !isChallenge(challenge) || !check.verify(node, challenge, proof)) return Proven.Failed
        if (pinned == null) return Proven.Pin(node)
        return if (node == pinned) Proven.Same(node) else Proven.Other(node)
    }
}
