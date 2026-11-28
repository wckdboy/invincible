package sh.invincible.bot.core

/*
 * An approval in plain words, as its ask says it in a chat (I10's phone-gaps, the lead's word of 28 November 2026): "Post
 * to Forge: “Sync survives a dropped connection…”", never "Outward · forge.post POST /posts". The call itself (its
 * connector and tool, its target, every argument) is behind More, in its card. The PWA's lib/asks.ts askPlain, held to
 * the vectors (AsksVectorsTest).
 */
object Asks {
    /** What sends takes "to" ("Post to Forge"); anything else is done "on" its service ("Merge on GitHub"). */
    private val SENDS = setOf("post", "send", "publish", "upload", "push", "write", "comment", "reply", "message", "email", "share")

    /** Where an ask's words are, the first of these an argument has in words. */
    private val WORDS = listOf("text", "title", "subject", "message", "body", "content", "name", "summary")

    /** As many characters of its words as a line shows, its last an ellipsis where it was cut. */
    private const val SHOWN = 60

    private fun capital(words: String) = words.replaceFirstChar { it.uppercase() }

    /** The first line of its words, cut on a character (never inside one) at SHOWN; null where it has none. */
    private fun firstWords(args: Json?): String? {
        for (key in WORDS) {
            val value = args?.get(key)?.string ?: continue
            val line = value.trim().split("\n")[0].trim()
            if (line.isEmpty()) continue
            if (line.codePointCount(0, line.length) <= SHOWN) return line
            return line.substring(0, line.offsetByCodePoints(0, SHOWN - 1)).trimEnd() + "…"
        }
        return null
    }

    /**
     * An approval as its ask says it: what it would do (its tool's name in words, a capital first), to or on which service
     * ([label]: the connector's own name where the app knows it, else its id with a capital), and the first words it would
     * send, in quotes.
     */
    fun plain(connector: String, tool: String, args: Json?, label: String? = null): String {
        val service = label?.trim()?.ifEmpty { null } ?: capital(connector)
        val words = tool.replace(Regex("[._-]+"), " ").trim()
        val verb = words.split(" ")[0].lowercase()
        val head = "${capital(words)} ${if (verb in SENDS) "to" else "on"} $service"
        return firstWords(args)?.let { "$head: “$it”" } ?: head
    }
}
