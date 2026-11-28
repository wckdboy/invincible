package sh.invincible.bot.core

/**
 * What model calls cost (core's spend.ts, the parts the work and a task's thread read): a runner's lines of calls by role
 * and model, their total, the price that applies to a model, and what they came to at your prices. Pure, so the JVM's
 * tests hold it to the vectors (`work.spent`, `steps.costs`).
 */
data class UsageLine(
    val role: String,
    val model: String,
    val calls: Double,
    /** Calls whose provider reported no usage: the counts below don't include them. */
    val unknown: Double,
    val input: Double,
    val output: Double,
    val cached: Double,
    val reasoning: Double,
    /** Of [calls], those counted at their most (core's Usage.atMost): the counts include them as upper bounds. 0: none. */
    val atMost: Double = 0.0,
) {
    companion object {
        fun of(j: Json): UsageLine = UsageLine(
            j["role"].string ?: "", j["model"].string ?: "", j["calls"].double ?: 0.0, j["unknown"].double ?: 0.0,
            j["input"].double ?: 0.0, j["output"].double ?: 0.0, j["cached"].double ?: 0.0, j["reasoning"].double ?: 0.0,
            j["atMost"].double ?: 0.0,
        )
    }
}

/** A model's price in US dollars per million tokens: in, out, and cached in (the in price where it has none). */
data class Price(val input: Double, val output: Double, val cached: Double? = null) {
    companion object {
        fun of(j: Json): Price? {
            val input = j["input"].double ?: return null
            val output = j["output"].double ?: return null
            return Price(input, output, j["cached"].double)
        }
    }
}

object Spend {
    data class Total(val calls: Double, val unknown: Double, val input: Double, val output: Double, val cached: Double, val reasoning: Double, val atMost: Double = 0.0) {
        val tokens: Double get() = input + output
        /** No call reported nothing: the counts are the whole of it. */
        val complete: Boolean get() = unknown == 0.0
    }

    /** What lines came to: their usd at the prices, the models with no price (sorted), whether it is the whole of it, and
     * whether some call was counted at its most (an upper bound for those). */
    data class Cost(val usd: Double, val unpriced: List<String>, val complete: Boolean, val atMost: Boolean = false)

    /** What a figure is, in the word before it (core's boundWord): exact, "at least ", "at most ", or "about " where both. */
    fun boundWord(lower: Boolean, upper: Boolean): String = if (upper) (if (lower) "about " else "at most ") else if (lower) "at least " else ""

    fun total(lines: List<UsageLine>): Total {
        var calls = 0.0
        var unknown = 0.0
        var input = 0.0
        var output = 0.0
        var cached = 0.0
        var reasoning = 0.0
        var atMost = 0.0
        for (l in lines) {
            calls += l.calls
            atMost += l.atMost
            unknown += l.unknown
            input += l.input
            output += l.output
            cached += l.cached
            reasoning += l.reasoning
        }
        return Total(calls, unknown, input, output, cached, reasoning, atMost)
    }

    /** The price that applies to a model: its own, else its provider's (the provider followed by a slash and a star), else none. */
    fun priceFor(prices: Map<String, Price>, model: String): Price? {
        prices[model]?.let { return it }
        val slash = model.indexOf('/')
        return if (slash > 0) prices["${model.substring(0, slash)}/*"] else null
    }

    /** Lines at your prices, as the node counts them (core's costOf, to the last bit: the same order of operations). */
    fun costOf(lines: List<UsageLine>, prices: Map<String, Price>): Cost {
        var usd = 0.0
        var unknown = 0.0
        val unpriced = sortedSetOf<String>()
        for (l in lines) {
            unknown += l.unknown
            if (l.calls == l.unknown) continue
            val price = priceFor(prices, l.model)
            if (price == null) {
                unpriced += l.model
                continue
            }
            usd += ((l.input - l.cached) * price.input + l.cached * (price.cached ?: price.input) + l.output * price.output) / 1e6
        }
        return Cost(usd, unpriced.toList(), unknown == 0.0 && unpriced.isEmpty(), lines.any { it.atMost > 0.0 })
    }

    /**
     * Your prices as money goes (core's moneyPrices): a coding plan's calls are paid for already, so every model of one of
     * [plans] (their provider ids) costs nothing more, priced by you or not.
     */
    fun moneyPrices(prices: Map<String, Price>, plans: List<String>): Map<String, Price> {
        val free = Price(0.0, 0.0, 0.0)
        val out = LinkedHashMap<String, Price>()
        for ((ref, price) in prices) {
            val slash = ref.indexOf('/')
            out[ref] = if (slash > 0 && ref.substring(0, slash) in plans) free else price
        }
        for (plan in plans) out["$plan/*"] = free
        return out
    }

    /** GET /api/prices, read: `prices` by model, and the coding plans whose calls are paid for already. */
    fun pricesOf(j: Json): Map<String, Price> {
        val prices = LinkedHashMap<String, Price>()
        for ((ref, p) in j["prices"].fields) Price.of(p)?.let { prices[ref] = it }
        return moneyPrices(prices, j["plans"].list.mapNotNull { it.string })
    }
}
