package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/**
 * When something happened, in the web's words (apps/web/src/lib/time.ts relativeTime), case for case, so a phone says it
 * as the web does. Held at a fixed now (Saturday 28 November 2026, 02:00 UTC), in UTC and US English.
 */
class RelativeTimeTest {
    private val now = Instant.parse("2026-11-28T02:00:00Z").toEpochMilli()
    private fun at(iso: String) = Instant.parse(iso).toEpochMilli()
    private fun said(ms: Long) = RelativeTime.of(ms, now, ZoneOffset.UTC, Locale.US)
    private val s = 1_000L
    private val min = 60 * s
    private val h = 60 * min

    @Test fun underFortyFiveSecondsItIsJustNowOrInAMoment() {
        assertEquals("just now", said(now - 10 * s))
        assertEquals("just now", said(now - 44 * s))
        assertEquals("in a moment", said(now + 10 * s))
    }

    @Test fun withinTheHourMinutesAtLeastOneAndWithinTheDayHoursHalvesRoundedUp() {
        assertEquals("1 min ago", said(now - 46 * s))
        assertEquals("2 min ago", said(now - 90 * s))
        assertEquals("59 min ago", said(now - 59 * min))
        assertEquals("3 h ago", said(now - (2 * h + 30 * min)))
        assertEquals("23 h ago", said(now - 23 * h))
        assertEquals("in 5 min", said(now + 5 * min))
        assertEquals("in 2 h", said(now + 2 * h))
        assertEquals("in 3 d", said(now + 72 * h))
    }

    @Test fun thenYesterdayThenAWeekdayWithinSixDaysThenAShortDateWithItsYearWhenItIsntThisOne() {
        assertEquals("yesterday", said(at("2026-11-27T01:00:00Z")))
        assertEquals("Wed", said(at("2026-11-25T02:00:00Z")))
        assertEquals("Nov 18", said(at("2026-11-18T02:00:00Z")))
        assertEquals("Oct 24, 2025", said(at("2025-10-24T02:00:00Z")))
    }
}
