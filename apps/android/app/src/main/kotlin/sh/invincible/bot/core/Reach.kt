package sh.invincible.bot.core

/**
 * What this app does about its notifications when it comes to the front (core's notifyReach, held to the parity vectors
 * as the iPhone app is): hand the node this phone's subscription again, asking nothing, while they're on or were lost
 * (not turned off by you); a card with Turn on, when nobody can be reached or this phone thought itself on and was turned
 * off elsewhere; a card with Open settings, when Android blocks them; or nothing (you turned this one off while another
 * reaches you).
 */
object Reach {
    enum class Step(val word: String) { RENEW("renew"), TURN_ON("turn-on"), SETTINGS("settings"), NONE("none") }

    /** [permission]: "granted", "denied" or "undetermined", as Android's leave stands. */
    fun step(permission: String, subscribed: Boolean, lost: Boolean, reachable: Int, localOn: Boolean = false): Step {
        if (subscribed || lost) return when (permission) { "granted" -> Step.RENEW; "denied" -> Step.SETTINGS; else -> Step.TURN_ON }
        if (reachable > 0 && !localOn) return Step.NONE
        return if (permission == "denied") Step.SETTINGS else Step.TURN_ON
    }

    private val QUIET = setOf("finished", "told", "limit")

    /** A kind told quietly, as news (core's isQuietKind): the News channel, no sound, never on the icon's count. */
    fun quiet(kind: String?): Boolean = kind in QUIET

    /** "They were on until 18 Nov: ntfy (UnifiedPush)'s push service stopped taking them." (the web app's lostLine). */
    fun lostLine(at: Long, service: String, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
        val day = java.time.format.DateTimeFormatter.ofPattern("d MMM", java.util.Locale.UK).format(java.time.Instant.ofEpochMilli(at).atZone(zone))
        val who = if (service == "a push service you allowed") "the push service you allowed" else "$service's push service"
        return "They were on until $day: $who stopped taking them."
    }
}
