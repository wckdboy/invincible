package sh.invincible.bot.core

/**
 * Something shared to the primary from another app (Android's share sheet), as the web app takes it (lib/share.ts): what
 * was shared lands in a new chat's message box, unsent. The words are the other app's, and only you send them.
 */
object Share {
    /** No more of it lands in the message box than this. */
    const val MAX = 8000

    // Control characters but the line break and the tab, bidirectional overrides and isolates, zero-width characters.
    private val HIDDEN = Regex("[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")

    /** What was shared, as the message box takes it: its subject, then its text (each once); null if there's nothing. */
    fun read(subject: String?, text: String?): String? {
        fun part(s: String?) = (s ?: "").replace(Regex("\r\n?"), "\n").replace(HIDDEN, "").trim()
        val title = part(subject)
        val body = part(text)
        val parts = listOf(if (title.isNotEmpty() && !body.contains(title)) title else "", body).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null
        return parts.joinToString("\n\n").take(MAX)
    }
}
