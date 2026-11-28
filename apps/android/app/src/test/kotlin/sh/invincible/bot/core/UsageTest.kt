package sh.invincible.bot.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The meter's words: money in two decimals as every app says it (lib/usage.ts), tokens as the node says them. */
class UsageTest {
    private fun meter(spent: Double, budget: Double?, left: Double?, complete: Boolean = true) =
        UsageMeter("month", "2026-11-01", budget, spent, complete, emptyList(), 3_610_000, 3, left, emptyList())

    @Test fun moneyIsAlwaysTwoDecimalsAndTokensReadAsTheNodesDo() {
        assertEquals("$0.00", Usage.money(0.0))
        assertEquals("$0.0050", Usage.money(0.005))
        assertEquals("$3.40", Usage.money(3.4))
        assertEquals("$10.00", Usage.money(10.0))
        assertEquals("$150.00", Usage.money(150.0))
        assertEquals("9,999", Usage.tokens(9_999))
        assertEquals("48.2k", Usage.tokens(48_210))
        assertEquals("2.34M", Usage.tokens(2_340_000))
    }

    @Test fun theLineSaysWhatIsLeftOrThatItIsOverBudget() {
        assertEquals("At least $3.40 of $10.00 · $6.60 left", Usage.line(meter(3.4, 10.0, 6.6, complete = false)))
        assertEquals("$2.10 of $2.00 · over budget", Usage.line(meter(2.1, 2.0, 0.0)))
        assertEquals("$2.00 of $2.00 · all spent", Usage.line(meter(2.0, 2.0, 0.0)))
        assertEquals("$3.40 · 3.61M tokens · no budget", Usage.line(meter(3.4, null, null)))
        // Nothing priced yet is $0.00, never "At least $0.00".
        assertEquals("$0.00 · 3.61M tokens · no budget", Usage.line(meter(0.0, null, null, complete = false)))
        assertEquals(1.0, Usage.share(meter(15.0, 10.0, 0.0))!!, 0.0)
        assertNull(Usage.share(meter(3.0, null, null)))
        assertEquals("This month: of $10.00 · $6.60 left", Usage.subline(meter(3.4, 10.0, 6.6)))
        assertEquals("This month: 3.61M tokens · no budget", Usage.subline(meter(3.4, null, null)))
    }

    @Test fun aSpentPlanIsSaidWithTheHourItResetsOnThisPhonesClock() {
        val zone = ZoneId.of("Europe/Copenhagen")
        val locale = Locale.UK
        // 21 November 2026, 13:00 in Copenhagen (12:00 UTC).
        val now = 1_795_262_400_000L
        val window = { hoursOn: Long -> UsageMeter.SpentWindow("opencode-go", now + hoursOn * 3_600_000, "allowance spent; resets in 35h") }
        // The hour as this phone's clock writes it (how a locale writes 01:00 differs between Java versions).
        val hour = { hoursOn: Long -> Instant.ofEpochMilli(now + hoursOn * 3_600_000).atZone(zone).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)) }
        // Five hours on is 18:00 in Copenhagen (17:00 UTC): the phone's own clock, not the node's.
        assertEquals("18:00", hour(5))
        assertEquals("opencode-go: its allowance is spent until 18:00", Usage.window(window(5), now, zone, locale))
        assertEquals("opencode-go: its allowance is spent until ${hour(12)} tomorrow", Usage.window(window(12), now, zone, locale))
        assertEquals("opencode-go: its allowance is spent until ${hour(60)} on Tuesday", Usage.window(window(60), now, zone, locale))
    }

    @Test fun aMeterFromANodeThatSaysNoWindowsHasNone() {
        val older = Json.parse("""{"per":"month","since":"2026-11-01","budgetUsd":null,"spentUsd":1.5,"complete":true,"unpriced":[],"tokens":10,"calls":1,"leftUsd":null,"top":[{"model":"deepseek/deepseek-v4-pro","usd":1.5,"tokens":10}]}""")
        val read = UsageMeter.of(older)!!
        assertTrue(read.windows.isEmpty())
        assertEquals(listOf(UsageMeter.Top("deepseek/deepseek-v4-pro", 1.5, 10)), read.top)
        assertNull(read.budgetUsd)
        val spent = Json.parse("""{"per":"day","since":"2026-11-21","budgetUsd":5,"spentUsd":1.5,"complete":false,"unpriced":["ollama/qwen3.8:27b"],"tokens":10,"calls":1,"leftUsd":3.5,"top":[],"windows":[{"provider":"opencode-go","until":1795390200000,"said":"resets in 35h"}]}""")
        assertEquals(listOf(UsageMeter.SpentWindow("opencode-go", 1_795_390_200_000, "resets in 35h")), UsageMeter.of(spent)!!.windows)
        assertNull(UsageMeter.of(Json.parse("""{"error":"no meter"}""")))
    }

    @Test fun aBudgetIsAnAmountAboveZeroOrNothing() {
        assertEquals(25.0, Usage.budgetTyped(" $25 ").getOrNull()!!, 0.0)
        assertEquals(2.5, Usage.budgetTyped("2,5").getOrNull()!!, 0.0)
        assertNull(Usage.budgetTyped("").getOrThrow())
        assertTrue(Usage.budgetTyped("0").isFailure)
        assertTrue(Usage.budgetTyped("lots").isFailure)
        assertTrue(Usage.budgetTyped("200000").isFailure)
    }
}
