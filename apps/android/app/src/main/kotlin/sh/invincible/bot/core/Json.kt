package sh.invincible.bot.core

/**
 * JSON as the node speaks it, with nothing borrowed: a value, a parser, and a writer whose canonical form is core's
 * (packages/core/src/canonical.ts): object keys sorted by UTF-16 code units, no whitespace, numbers and strings as
 * JavaScript's JSON.stringify writes them. Pure Kotlin, so the JVM's tests check it byte for byte against the vectors.
 */
sealed interface Json {
    data object Null : Json
    data class Bool(val value: Boolean) : Json
    data class Num(val value: Double) : Json
    data class Str(val value: String) : Json
    data class Arr(val items: List<Json>) : Json
    data class Obj(val fields: Map<String, Json>) : Json

    companion object {
        fun parse(text: String): Json = Parser(text).run { val v = value(); end(); v }
        fun obj(vararg pairs: Pair<String, Any?>): Obj = Obj(linkedMapOf(*pairs.mapNotNull { (k, v) -> if (v == null) null else k to of(v) }.toTypedArray()))
        fun arr(items: List<Any?>): Arr = Arr(items.map { of(it) })

        /** A Kotlin value as JSON: null, Boolean, Number, String, a list, a map, or JSON already. */
        fun of(value: Any?): Json = when (value) {
            null -> Null
            is Json -> value
            is Boolean -> Bool(value)
            is Number -> Num(value.toDouble())
            is String -> Str(value)
            is List<*> -> Arr(value.map { of(it) })
            is Map<*, *> -> Obj(linkedMapOf(*value.entries.mapNotNull { (k, v) -> if (v == null) null else k.toString() to of(v) }.toTypedArray()))
            else -> throw IllegalArgumentException("not JSON: ${value::class.simpleName}")
        }
    }
}

/* ---------- reading ---------- */

operator fun Json?.get(key: String): Json? = (this as? Json.Obj)?.fields?.get(key)
operator fun Json?.get(index: Int): Json? = (this as? Json.Arr)?.items?.getOrNull(index)
val Json?.string: String? get() = (this as? Json.Str)?.value
val Json?.double: Double? get() = (this as? Json.Num)?.value
val Json?.long: Long? get() = (this as? Json.Num)?.value?.let { if (it == Math.floor(it) && !it.isInfinite()) it.toLong() else null }
val Json?.int: Int? get() = long?.toInt()
val Json?.bool: Boolean? get() = (this as? Json.Bool)?.value
val Json?.list: List<Json> get() = (this as? Json.Arr)?.items ?: emptyList()
val Json?.fields: Map<String, Json> get() = (this as? Json.Obj)?.fields ?: emptyMap()

/* ---------- writing ---------- */

/** As the node writes it: compact, keys in the order they were given. */
fun Json.text(): String = StringBuilder().also { write(it, canonical = false) }.toString()

/** Core's canonical form: keys sorted by UTF-16 code units (Kotlin's String order is JavaScript's), no whitespace. */
fun Json.canonical(): String = StringBuilder().also { write(it, canonical = true) }.toString()

private fun Json.write(out: StringBuilder, canonical: Boolean) {
    when (this) {
        Json.Null -> out.append("null")
        is Json.Bool -> out.append(if (value) "true" else "false")
        is Json.Num -> out.append(jsNumber(value))
        is Json.Str -> jsString(value, out)
        is Json.Arr -> {
            out.append('[')
            items.forEachIndexed { i, item -> if (i > 0) out.append(','); item.write(out, canonical) }
            out.append(']')
        }
        is Json.Obj -> {
            out.append('{')
            val entries = if (canonical) fields.entries.sortedBy { it.key } else fields.entries
            entries.forEachIndexed { i, (k, v) ->
                if (i > 0) out.append(',')
                jsString(k, out)
                out.append(':')
                v.write(out, canonical)
            }
            out.append('}')
        }
    }
}

/** A string as JSON.stringify writes it: the two quotes, backslash and control characters escaped, all else as it is. */
internal fun jsString(s: String, out: StringBuilder) {
    out.append('"')
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '"' -> out.append("\\\"")
            c == '\\' -> out.append("\\\\")
            c == '\b' -> out.append("\\b")
            c == '\u000C' -> out.append("\\f")
            c == '\n' -> out.append("\\n")
            c == '\r' -> out.append("\\r")
            c == '\t' -> out.append("\\t")
            c < ' ' -> out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
            // A surrogate without its other half is written as its escape (well-formed JSON.stringify, ES2019).
            c.isHighSurrogate() && (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) -> out.append("\\u").append(c.code.toString(16))
            c.isLowSurrogate() && (i == 0 || !s[i - 1].isHighSurrogate()) -> out.append("\\u").append(c.code.toString(16))
            else -> out.append(c)
        }
        i += 1
    }
    out.append('"')
}

/**
 * A number as JavaScript writes it: the shortest digits that read back as the same double (shortestDecimal), plain from
 * 1e-7 up to 1e21 and with an exponent outside it (`1e+21`, `1.5e-7`); -0 is 0.
 */
internal fun jsNumber(x: Double): String {
    require(x.isFinite()) { "JSON has no non-finite numbers" }
    if (x == 0.0) return "0"
    if (x == Math.rint(x) && Math.abs(x) < 1e21) {
        if (Math.abs(x) < 9.007199254740992E15) return x.toLong().toString()
    }
    val dec = shortestDecimal(Math.abs(x)).stripTrailingZeros()
    val digits = dec.unscaledValue().abs().toString()
    // The value is digits × 10^(exp - k + 1), where k is how many digits: n is the decimal point's place (JS's "n").
    val n = digits.length - dec.scale()
    val sign = if (x < 0) "-" else ""
    val k = digits.length
    return when {
        n in (k)..21 -> sign + digits + "0".repeat(n - k)
        n in 1..21 -> sign + digits.substring(0, n) + "." + digits.substring(n)
        n in -5..0 -> sign + "0." + "0".repeat(-n) + digits
        else -> {
            val e = n - 1
            val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
            sign + mantissa + "e" + (if (e > 0) "+" else "-") + Math.abs(e)
        }
    }
}

/**
 * The shortest decimal that reads back as [x] (above 0), the closest of those to it, the even one of two as close: what
 * JavaScript's Number::toString writes. Java's own Double.toString isn't always the shortest before JDK 19
 * (JDK-4511638: -2^60 as -1.15292150460684698E18, 18 digits where 16 read back), so it is found here: at each length,
 * the two decimals either side of x's exact value, the first length at which one of them reads back as x.
 */
private fun shortestDecimal(x: Double): java.math.BigDecimal {
    val exact = java.math.BigDecimal(x)
    for (length in 1..17) {
        val down = exact.round(java.math.MathContext(length, java.math.RoundingMode.DOWN))
        val up = exact.round(java.math.MathContext(length, java.math.RoundingMode.UP))
        val downReads = down.toDouble() == x
        val upReads = up.toDouble() == x
        if (!downReads && !upReads) continue
        if (downReads != upReads) return if (downReads) down else up
        val below = exact.subtract(down)
        val above = up.subtract(exact)
        return when {
            below < above -> down
            above < below -> up
            else -> if (down.unscaledValue().testBit(0)) up else down
        }
    }
    return java.math.BigDecimal(x.toString())
}

/* ---------- parsing ---------- */

class JsonError(message: String) : Exception(message)

private class Parser(private val s: String) {
    private var i = 0

    fun end() {
        space()
        if (i != s.length) throw JsonError("unexpected ${s[i]} at $i")
    }

    private fun space() {
        while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
    }

    fun value(): Json {
        space()
        if (i >= s.length) throw JsonError("unexpected end")
        return when (val c = s[i]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> Json.Str(str())
            't' -> word("true", Json.Bool(true))
            'f' -> word("false", Json.Bool(false))
            'n' -> word("null", Json.Null)
            else -> if (c == '-' || c in '0'..'9') num() else throw JsonError("unexpected $c at $i")
        }
    }

    private fun word(w: String, v: Json): Json {
        if (!s.startsWith(w, i)) throw JsonError("unexpected ${s[i]} at $i")
        i += w.length
        return v
    }

    private fun obj(): Json {
        i++
        val out = LinkedHashMap<String, Json>()
        space()
        if (i < s.length && s[i] == '}') { i++; return Json.Obj(out) }
        while (true) {
            space()
            if (i >= s.length || s[i] != '"') throw JsonError("a key was expected at $i")
            val k = str()
            space()
            if (i >= s.length || s[i] != ':') throw JsonError(": was expected at $i")
            i++
            out[k] = value()
            space()
            if (i < s.length && s[i] == ',') { i++; continue }
            if (i < s.length && s[i] == '}') { i++; return Json.Obj(out) }
            throw JsonError(", or } was expected at $i")
        }
    }

    private fun arr(): Json {
        i++
        val out = ArrayList<Json>()
        space()
        if (i < s.length && s[i] == ']') { i++; return Json.Arr(out) }
        while (true) {
            out += value()
            space()
            if (i < s.length && s[i] == ',') { i++; continue }
            if (i < s.length && s[i] == ']') { i++; return Json.Arr(out) }
            throw JsonError(", or ] was expected at $i")
        }
    }

    private fun str(): String {
        i++
        val out = StringBuilder()
        while (true) {
            if (i >= s.length) throw JsonError("unterminated string")
            val c = s[i++]
            when {
                c == '"' -> return out.toString()
                c == '\\' -> {
                    if (i >= s.length) throw JsonError("unterminated escape")
                    when (val e = s[i++]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (i + 4 > s.length) throw JsonError("short \\u escape")
                            out.append(s.substring(i, i + 4).toInt(16).toChar())
                            i += 4
                        }
                        else -> throw JsonError("unknown escape \\$e")
                    }
                }
                c < ' ' -> throw JsonError("a control character in a string at ${i - 1}")
                else -> out.append(c)
            }
        }
    }

    private fun num(): Json {
        val start = i
        if (s[i] == '-') i++
        while (i < s.length && (s[i].isDigit() || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) i++
        return Json.Num(s.substring(start, i).toDoubleOrNull() ?: throw JsonError("not a number at $start"))
    }
}
