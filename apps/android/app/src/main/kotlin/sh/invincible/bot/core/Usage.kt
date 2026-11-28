package sh.invincible.bot.core

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/**
 * This period's model calls on the node at your prices, against your budget (`GET /api/usage/meter`), as the iPhone's
 * meter reads it (UsageMeterView.swift): what they came to, what cost most, the models with no price, and the coding
 * plans whose allowance is spent now.
 */
data class UsageMeter(
    /** day · month */
    val per: String,
    val since: String,
    val budgetUsd: Double?,
    val spentUsd: Double,
    /** Every call was counted and priced: `spentUsd` is the whole of it, not a lower bound. */
    val complete: Boolean,
    val unpriced: List<String>,
    val tokens: Long,
    val calls: Long,
    val leftUsd: Double?,
    val top: List<Top>,
    /** Plans whose allowance is spent now, until when (none from an older node). */
    val windows: List<SpentWindow> = emptyList(),
) {
    data class Top(val model: String, val usd: Double?, val tokens: Long)

    data class SpentWindow(val provider: String, val until: Long, val said: String)

    companion object {
        fun of(j: Json): UsageMeter? {
            val spent = j["spentUsd"].double ?: return null
            return UsageMeter(
                per = j["per"].string ?: "month",
                since = j["since"].string ?: "",
                budgetUsd = j["budgetUsd"].double,
                spentUsd = spent,
                complete = j["complete"].bool ?: false,
                unpriced = j["unpriced"].list.mapNotNull { it.string },
                tokens = j["tokens"].long ?: 0,
                calls = j["calls"].long ?: 0,
                leftUsd = j["leftUsd"].double,
                top = j["top"].list.mapNotNull { t -> t["model"].string?.let { Top(it, t["usd"].double, t["tokens"].long ?: 0) } },
                windows = j["windows"].list.mapNotNull { w ->
                    val provider = w["provider"].string ?: return@mapNotNull null
                    SpentWindow(provider, w["until"].long ?: return@mapNotNull null, w["said"].string ?: "")
                },
            )
        }
    }
}

/**
 * The meter's words, every app's (lib/usage.ts, held by the vectors): money always in two decimals, tokens as the node
 * says them (core's spend.ts tokensLabel).
 */
object Usage {
    fun tokens(n: Long): String = when {
        n < 10_000 -> String.format(Locale.US, "%,d", n)
        n < 1_000_000 -> String.format(Locale.US, if (n < 100_000) "%.1fk" else "%.0fk", n / 1000.0)
        else -> String.format(Locale.US, if (n < 10_000_000) "%.2fM" else "%.1fM", n / 1_000_000.0)
    }

    /**
     * Money as the apps say it (lib/usage.ts moneyWords): always two decimals ($36.60), four under a cent so a little is
     * never $0.00. Rounded as the PWA's toFixed rounds, on the number's exact value (1.005 is $1.00).
     */
    fun money(usd: Double): String {
        if (!usd.isFinite()) return "$$usd"
        return "$" + BigDecimal(usd).setScale(if (usd > 0 && usd < 0.01) 4 else 2, RoundingMode.HALF_UP).toPlainString()
    }

    /** The meter's figure (lib/usage.ts spentWords): what this period came to, "At least" when some calls had no price (never of $0). */
    fun spentWords(spentUsd: Double, complete: Boolean): String = "${if (complete || spentUsd == 0.0) "" else "At least "}${money(spentUsd)}"

    /**
     * Under the figure (lib/usage.ts budgetWords): of what budget, then what is left, all of it spent, or over budget; with
     * no budget, its tokens.
     */
    fun budgetWords(spentUsd: Double, budgetUsd: Double?, tokenCount: Long): String {
        val budget = budgetUsd ?: return "${tokens(tokenCount)} tokens · no budget"
        val of = "of ${money(budget)}"
        return when {
            spentUsd > budget -> "$of · over budget"
            spentUsd == budget -> "$of · all spent"
            else -> "$of · ${money(budget - spentUsd)} left"
        }
    }

    /** The meter in a line, as Settings' Providers says it in every app (lib/usage.ts meterLine): the two together. */
    fun meterLine(spentUsd: Double, complete: Boolean, budgetUsd: Double?, tokenCount: Long): String =
        "${spentWords(spentUsd, complete)}${if (budgetUsd == null) " · " else " "}${budgetWords(spentUsd, budgetUsd, tokenCount)}"

    fun line(m: UsageMeter): String = meterLine(m.spentUsd, m.complete, m.budgetUsd, m.tokens)

    /** How much of the budget is spent, 0 to 1 (null with none). */
    fun share(m: UsageMeter): Double? = m.budgetUsd?.takeIf { it > 0 }?.let { minOf(1.0, m.spentUsd / it) }

    fun period(m: UsageMeter): String = if (m.per == "day") "Today" else "This month"

    /** Under the big figure: the period, then of what budget and what is left (the PWA's sheet says it so). */
    fun subline(m: UsageMeter): String = "${period(m)}: ${budgetWords(m.spentUsd, m.budgetUsd, m.tokens)}"

    /**
     * A plan whose allowance is spent, in a line: whose, and until when by this phone's clock (`invincible usage` says it in
     * UTC; here it is the hour you'd read off your own phone).
     */
    fun window(w: UsageMeter.SpentWindow, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val until = Instant.ofEpochMilli(w.until).atZone(zone)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val time = until.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
        val day = when (until.toLocalDate()) {
            today -> ""
            today.plusDays(1) -> " tomorrow"
            else -> " on ${until.dayOfWeek.getDisplayName(TextStyle.FULL, locale)}"
        }
        return "${w.provider}: its allowance is spent until $time$day"
    }

    /** A budget as typed: an amount in US dollars above 0, or empty for none; null when it is neither. */
    fun budgetTyped(typed: String): Result<Double?> {
        val t = typed.trim().replace(",", ".").replace("$", "")
        if (t.isEmpty()) return Result.success(null)
        val usd = t.toDoubleOrNull()
        return if (usd == null || usd <= 0 || usd > 100_000) Result.failure(IllegalArgumentException("A budget is an amount in US dollars above 0, like 25, or empty for none.")) else Result.success(usd)
    }
}
