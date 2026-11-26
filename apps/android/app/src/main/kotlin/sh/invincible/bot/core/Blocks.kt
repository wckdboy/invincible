package sh.invincible.bot.core

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/*
 * What the primary may show in an answer beyond words (packages/core/src/blocks.ts): a fenced block whose language names it,
 * drawn as a live element. What a model writes is untrusted, so each reader checks every field and caps every size; a
 * block it doesn't accept is shown as the code it is, with why. The parity vectors hold each reader to core's.
 */

object Blocks {
    val kinds = setOf("chart", "stats", "choices", "steps", "artifact")
    val chartTypes = listOf("line", "area", "bar", "stacked")
    val stepStates = listOf("done", "doing", "todo", "failed", "skipped")

    private const val LABELS = 60
    private const val SERIES = 6
    private const val TITLE = 80
    private const val NAME = 32
    private const val UNIT = 12
    private const val STATS = 6
    private const val STAT_LABEL = 40
    private const val STAT_VALUE = 24
    private const val NOTE = 60
    private const val CHOICES = 6
    private const val CHOICE = 80
    private const val STEPS = 20
    private const val STEP = 120
    private const val ARTIFACT_CHARS = 200_000

    sealed interface Read<out T> {
        data class Ok<T>(val value: T) : Read<T>
        data class No(val why: String) : Read<Nothing>
    }

    data class Chart(val type: String, val title: String?, val unit: String?, val labels: List<String>, val series: List<Pair<String, List<Double?>>>)
    data class Stat(val label: String, val number: Double?, val text: String?, val unit: String?, val delta: Double?, val note: String?, val good: String?)
    data class Step(val text: String, val state: String)

    private fun json(text: String): Json? = try {
        Json.parse(text)
    } catch (_: JsonError) {
        null
    }

    /** One line of text, its whitespace folded, cut to [max] characters with an ellipsis; null when there's none. */
    fun line(v: Json?, max: Int): String? {
        val raw = when (v) {
            is Json.Num -> jsNumber(v.value)
            is Json.Str -> v.value
            else -> return null
        }
        val text = raw.replace(Regex("[\\u0000-\\u001f\\u007f]+"), " ").replace(Regex("\\s+"), " ").trim()
        if (text.isEmpty()) return null
        return if (text.length > max) text.substring(0, max - 1).trimEnd() + "…" else text
    }

    private fun finite(v: Json?): Double? = (v as? Json.Num)?.value?.takeIf { it.isFinite() }

    fun chart(text: String): Read<Chart> {
        val c = json(text) ?: return Read.No("it isn't valid JSON")
        if (c !is Json.Obj) return Read.No("a chart is an object with type, labels and series")
        val type = c["type"].let { if (it == null) "line" else it.string }
        if (type == null || type !in chartTypes) return Read.No("its type is one of ${chartTypes.joinToString(", ")}")
        val rawLabels = (c["labels"] as? Json.Arr)?.items
        if (rawLabels.isNullOrEmpty()) return Read.No("it needs labels: what each value is for (a month, a name)")
        if (rawLabels.size > LABELS) return Read.No("at most $LABELS labels: more is a table")
        val labels = rawLabels.map { line(it, NAME) ?: "" }
        val rawSeries = (c["series"] as? Json.Arr)?.items
        if (rawSeries.isNullOrEmpty()) return Read.No("it needs a series of values")
        if (rawSeries.size > SERIES) return Read.No("at most $SERIES series: fold the rest into one called Other")
        val series = ArrayList<Pair<String, List<Double?>>>()
        for ((i, s) in rawSeries.withIndex()) {
            val values = (s["values"] as? Json.Arr)?.items
            if (s !is Json.Obj || values == null) return Read.No("series ${i + 1} needs values")
            if (values.size != labels.size) return Read.No("series ${i + 1} has ${values.size} values for ${labels.size} labels")
            val read = values.map { finite(it) }
            if (values.indices.any { values[it] != Json.Null && read[it] == null }) return Read.No("series ${i + 1} has a value that isn't a number (null leaves a gap)")
            if (type == "stacked" && read.any { it != null && it < 0 }) return Read.No("a stacked chart's values are parts of a whole: none below zero")
            val name = line(s["name"], NAME) ?: if (rawSeries.size == 1) line(c["title"], NAME) ?: "Value" else "Series ${i + 1}"
            if (series.any { it.first.lowercase() == name.lowercase() }) return Read.No("two series are called $name")
            series += name to read
        }
        if (series.none { s -> s.second.any { it != null } }) return Read.No("it has no values")
        return Read.Ok(Chart(type, line(c["title"], TITLE), line(c["unit"], UNIT), labels, series))
    }

    fun stats(text: String): Read<List<Stat>> {
        val parsed = json(text) ?: return Read.No("it isn't valid JSON")
        val list = ((parsed as? Json.Obj)?.get("stats") as? Json.Arr ?: parsed as? Json.Arr)?.items
        if (list.isNullOrEmpty()) return Read.No("figures are a list of {label, value}")
        if (list.size > STATS) return Read.No("at most $STATS figures")
        val out = ArrayList<Stat>()
        for ((i, s) in list.withIndex()) {
            if (s !is Json.Obj) return Read.No("figure ${i + 1} is an object with a label and a value")
            val label = line(s["label"], STAT_LABEL)
            val number = finite(s["value"])
            val text = if (number == null) line(s["value"], STAT_VALUE) else null
            if (label == null || (number == null && text == null)) return Read.No("figure ${i + 1} needs a label and a value")
            val good = s["good"].string?.takeIf { it == "up" || it == "down" }
            out += Stat(label, number, text, line(s["unit"], UNIT), finite(s["delta"]), line(s["note"], NOTE), good)
        }
        return Read.Ok(out)
    }

    fun choices(text: String): Read<List<String>> {
        val parsed = json(text) ?: return Read.No("it isn't valid JSON")
        val list = ((parsed as? Json.Obj)?.get("options") as? Json.Arr ?: parsed as? Json.Arr)?.items ?: return Read.No("choices are a list of short answers")
        val out = ArrayList<String>()
        for (c in list) {
            val choice = line(c, CHOICE)
            if (choice != null && out.none { it.lowercase() == choice.lowercase() }) out += choice
        }
        if (out.size < 2) return Read.No("at least two choices")
        if (out.size > CHOICES) return Read.No("at most $CHOICES choices")
        return Read.Ok(out)
    }

    fun steps(text: String): Read<List<Step>> {
        val parsed = json(text) ?: return Read.No("it isn't valid JSON")
        val list = ((parsed as? Json.Obj)?.get("steps") as? Json.Arr ?: parsed as? Json.Arr)?.items
        if (list.isNullOrEmpty()) return Read.No("steps are a list of {text, state}")
        if (list.size > STEPS) return Read.No("at most $STEPS steps")
        val out = ArrayList<Step>()
        for ((i, s) in list.withIndex()) {
            val text = line(if (s is Json.Obj) s["text"] else s, STEP) ?: return Read.No("step ${i + 1} needs its text")
            val state = (s as? Json.Obj)?.get("state").string?.takeIf { it in stepStates } ?: "todo"
            out += Step(text, state)
        }
        return Read.Ok(out)
    }

    fun artifact(text: String): Read<String> {
        val page = text.trim()
        if (!page.contains("<")) return Read.No("a page is HTML")
        if (page.length > ARTIFACT_CHARS) return Read.No("a page is at most ${ARTIFACT_CHARS / 1000}K characters")
        return Read.Ok(page)
    }

    /** The page's own <title>, as plain text, for its card. */
    fun artifactTitle(page: String): String? {
        val found = Regex("<title[^>]*>([^<]{1,200})</title>", RegexOption.IGNORE_CASE).find(page)?.groupValues?.get(1) ?: return null
        val plain = found.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        return line(Json.Str(plain), TITLE)
    }

    /** A figure as people read it: 1,284 under ten thousand; 12.9K, 4.2M above (as JavaScript's en-US locale writes them). */
    fun compactNumber(n: Double): String {
        val abs = Math.abs(n)
        if (abs < 10_000) return grouped(n, if (abs < 10) 2 else if (abs < 100) 1 else 0)
        val units = listOf(1e3 to "K", 1e6 to "M", 1e9 to "B", 1e12 to "T")
        var at = units.indexOfLast { abs >= it.first }
        fun shown(i: Int): Pair<String, Double> {
            val scaled = n / units[i].first
            val digits = if (Math.abs(scaled) < 100) 1 else 0
            return grouped(scaled, digits) to Math.abs(BigDecimal(jsNumber(scaled)).setScale(digits, RoundingMode.HALF_UP).toDouble())
        }
        // 999,999 rounds to 1,000K: that's 1M.
        if (shown(at).second >= 1000 && at < units.size - 1) at++
        return shown(at).first + units[at].second
    }

    /** As toLocaleString("en-US", {maximumFractionDigits}) writes it: rounded half away from zero, thousands grouped. */
    private fun grouped(n: Double, digits: Int): String {
        val rounded = BigDecimal(jsNumber(n)).setScale(digits, RoundingMode.HALF_UP)
        val format = DecimalFormat("#,##0" + if (digits > 0) "." + "#".repeat(digits) else "", DecimalFormatSymbols(Locale.US))
        val text = format.format(rounded)
        return if (text == "-0") "0" else text
    }
}
