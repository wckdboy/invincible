package sh.invincible.bot.core

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

/** The meter's words, as the node's own say money and tokens (core's spend.ts: usdLabel, tokensLabel) and the iPhone's. */
object Usage {
    fun usd(usd: Double): String = when {
        usd == 0.0 -> "$0"
        usd < 0.01 -> String.format(Locale.US, "$%.4f", usd)
        usd < 10 -> String.format(Locale.US, "$%.2f", usd)
        usd < 100 -> String.format(Locale.US, "$%.1f", usd)
        else -> String.format(Locale.US, "$%.0f", usd)
    }

    fun tokens(n: Long): String = when {
        n < 10_000 -> String.format(Locale.US, "%,d", n)
        n < 1_000_000 -> String.format(Locale.US, if (n < 100_000) "%.1fk" else "%.0fk", n / 1000.0)
        else -> String.format(Locale.US, if (n < 10_000_000) "%.2fM" else "%.1fM", n / 1_000_000.0)
    }

    /** The meter in a line: what it came to ("at least" when some calls had no price, never of $0), against the budget. */
    fun line(m: UsageMeter): String {
        val spent = "${if (m.complete || m.spentUsd == 0.0) "" else "at least "}${usd(m.spentUsd)}"
        val budget = m.budgetUsd ?: return "$spent · ${tokens(m.tokens)} tokens"
        val left = m.leftUsd
        return if (left == null || left <= 0) "$spent of ${usd(budget)} · spent" else "$spent of ${usd(budget)} · ${usd(left)} left"
    }

    /** How much of the budget is spent, 0 to 1 (null with none). */
    fun share(m: UsageMeter): Double? = m.budgetUsd?.takeIf { it > 0 }?.let { minOf(1.0, m.spentUsd / it) }

    fun period(m: UsageMeter): String = if (m.per == "day") "Today" else "This month"

    /** Under the big figure: of what budget, and what is left. */
    fun subline(m: UsageMeter): String {
        val period = if (m.per == "day") "today" else "this month"
        val budget = m.budgetUsd ?: return "spent $period, with no budget"
        val left = m.leftUsd
        return if (left != null && left > 0) "of ${usd(budget)} $period: ${usd(left)} left" else "of ${usd(budget)} $period: spent"
    }

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
