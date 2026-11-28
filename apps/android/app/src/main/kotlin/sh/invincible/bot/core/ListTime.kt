package sh.invincible.bot.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DecimalStyle
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * When, as the list that is home says it, as a chat app's list does (apps/web/src/lib/time.ts listTime, held to its
 * vectors): today, its clock time, short ("14:05"); "Yesterday"; the weekday's name for two to six days back
 * ("Thursday"); else a numeric date ("21/11/2026"). Days are the calendar's in [zone], not 24-hour spans. [clock] and
 * [date] are patterns as the phone makes them (Android's DateFormat: its clock as it is set, 24 hours or 12, and its
 * numeric date, in its locale); one this java.time can't read is the locale's own short form instead. Its digits are the
 * locale's own (Egyptian Arabic's ٠-٩), as the web's and the iPhone's are.
 */
class ListTime(private val zone: ZoneId, private val locale: Locale, clock: String, date: String) {
    private val digits = DecimalStyle.of(locale)
    private val clock = (pattern(clock) ?: DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)).withDecimalStyle(digits)
    private val date = (pattern(date) ?: DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale)).withDecimalStyle(digits)

    // (The weekday's name as it stands alone, as the web's and the iPhone's formats give it.)
    private val weekday = DateTimeFormatter.ofPattern("cccc", locale)

    fun of(ms: Long, now: Long): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone)
        return when (ChronoUnit.DAYS.between(at.toLocalDate(), Instant.ofEpochMilli(now).atZone(zone).toLocalDate())) {
            0L -> clock.format(at)
            1L -> "Yesterday"
            in 2L..6L -> weekday.format(at)
            else -> date.format(at)
        }
    }

    private fun pattern(p: String): DateTimeFormatter? = runCatching { DateTimeFormatter.ofPattern(p, locale) }.getOrNull()
}
