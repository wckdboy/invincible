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
 * ("Thursday"); else a numeric date ("21/11/2026"). Days are the calendar's in [zone], not 24-hour spans, and [locale]
 * is the one it speaks (speaking: English, with the phone's region). [clock] and [date] are patterns as the phone makes
 * them there (Android's DateFormat: its clock as it is set, 24 hours or 12, and its numeric date), and [day] the date a
 * chat's mark says (its month's short name: "yMMMd"); one this java.time can't read is the locale's own form instead. Its digits are the locale's own, as the web's and the iPhone's are.
 */
class ListTime(val zone: ZoneId, private val locale: Locale, clock: String, date: String, day: String = "") {
    private val digits = DecimalStyle.of(locale)
    private val clock = (pattern(clock) ?: DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)).withDecimalStyle(digits)
    private val date = (pattern(date) ?: DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale)).withDecimalStyle(digits)
    private val day = ((if (day.isEmpty()) null else pattern(day)) ?: DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)).withDecimalStyle(digits)

    // (The weekday's name as it stands alone, as the web's and the iPhone's formats give it.)
    private val weekday = DateTimeFormatter.ofPattern("cccc", locale)

    /**
     * When a chat went on, as its small centred mark says it (lib/time.ts timeMark, held to the vectors): the day as people
     * say it, then its clock time: "Today 09:41", "Yesterday 18:20", the weekday's name within the week before ("Tuesday
     * 10:00"), else the date with its month's short name, as [day]'s pattern writes it ("21 Nov 2026 09:00").
     */
    fun mark(ms: Long, now: Long): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone)
        val time = clock.format(at)
        return when (ChronoUnit.DAYS.between(at.toLocalDate(), Instant.ofEpochMilli(now).atZone(zone).toLocalDate())) {
            0L -> "Today $time"
            1L -> "Yesterday $time"
            in 2L..6L -> "${weekday.format(at)} $time"
            else -> "${day.format(at)} $time"
        }
    }

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

    companion object {
        /**
         * The locale the list's times are said in (lib/time.ts listLocale): the app's language, English (every word of it
         * is), with the phone's region. So "Yesterday" and a weekday's name are English while the clock and the date are
         * written as that region writes them: a phone in Danish says "Thursday", "14.05", "21/11/2026", never "torsdag"
         * beside "Yesterday". (A phone's locale names its region; one that names none is said in English alone.)
         */
        fun speaking(device: Locale): Locale = Locale.Builder().setLanguage("en").setRegion(device.country).build()
    }
}
