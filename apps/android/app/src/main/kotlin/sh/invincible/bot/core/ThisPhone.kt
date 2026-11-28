package sh.invincible.bot.core

import java.net.URI

/**
 * What Settings says about this phone, in the web's words for a browser (apps/web/src/views/settings.ts, its "This
 * device"): its key and its fleet cut short as the web's shortId cuts an id (apps/web/src/lib/text.ts), the node it
 * talks to by name and address (its host and port, as a browser's location.host says them), and its fleet by name, or
 * "unnamed".
 */
object ThisPhone {
    /** An id cut short, as the web's shortId: its kind's two characters left off and [n] kept; a short one whole. */
    fun shortId(id: String, n: Int = 8): String = if (id.length > n + 2) id.substring(2, 2 + n) else id

    /** An address's host, and its port unless it is the scheme's own: no scheme, no path. */
    fun host(origin: String): String {
        val uri = runCatching { URI(origin.trim()) }.getOrNull()
        val host = uri?.host ?: return origin.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        val own = when (uri.scheme?.lowercase()) {
            "http" -> 80
            "https" -> 443
            else -> -1
        }
        return if (uri.port == -1 || uri.port == own) host else "$host:${uri.port}"
    }

    /** Whom it talks to: the node by name, then where. */
    fun talksTo(nodeName: String?, origin: String): String = listOfNotNull(nodeName?.trim()?.takeIf { it.isNotEmpty() }, host(origin)).joinToString(" · ")

    /** Its fleet: by name ("unnamed" with none), then its id cut short. */
    fun fleet(fleetName: String?, fleet: String): String = "${fleetName?.trim()?.takeIf { it.isNotEmpty() } ?: "unnamed"} · ${shortId(fleet, 10)}"
}
