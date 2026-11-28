package sh.invincible.bot.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

/**
 * When something happened, in the web's words (apps/web/src/lib/time.ts relativeTime), so a phone says it as the web
 * does: "just now" under 45 s, "12 min ago", "3 h ago", "yesterday", a weekday within the week ("Wed"), else a short date
 * ("Nov 18", with its year where it isn't this one's). Ahead of now: "in a moment", "in 5 min", "in 2 h", "in 3 d".
 */
object RelativeTime {
    private const val MIN = 60_000L
    private const val HOUR = 60 * MIN
    private const val DAY = 24 * HOUR

    fun of(ms: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val delta = now - ms
        val future = delta < 0
        val gap = abs(delta)
        fun wrap(s: String) = if (future) "in $s" else "$s ago"
        if (gap < 45_000) return if (future) "in a moment" else "just now"
        if (gap < HOUR) return wrap("${max(1L, round(gap.toDouble() / MIN))} min")
        if (gap < DAY) return wrap("${round(gap.toDouble() / HOUR)} h")
        if (future) return if (gap < 7 * DAY) "in ${round(gap.toDouble() / DAY)} d" else shortDate(ms, now, zone, locale)
        if (day(ms, zone) == day(now - DAY, zone)) return "yesterday"
        if (gap < 6 * DAY) return day(ms, zone).dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
        return shortDate(ms, now, zone, locale)
    }

    /** A date in short: its month and day, and its year where it isn't now's (the web's shortDate). */
    fun shortDate(ms: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val date = day(ms, zone)
        return date.format(DateTimeFormatter.ofPattern(if (date.year == day(now, zone).year) "MMM d" else "MMM d, yyyy", locale))
    }

    private fun day(ms: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()

    /** JavaScript's Math.round: a half rounds up. */
    private fun round(x: Double): Long = floor(x + 0.5).toLong()
}
