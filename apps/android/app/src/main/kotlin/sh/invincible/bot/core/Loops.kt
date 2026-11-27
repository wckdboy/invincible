package sh.invincible.bot.core

/**
 * A loop's task, and what wakes it, in words, as the PWA's lib/loops.ts (describeTask) and lib/wakes.ts (describeWakes)
 * say them, held to them by the vectors' `loops`: a loop it drafted says them in Needs you.
 */
object Loops {
    /** As much of a text as a line keeps, counted as a string's length is in JavaScript (UTF-16), and an ellipsis where it
     * was cut. */
    private fun clip(text: String, n: Int): String = if (text.length > n) text.substring(0, n - 1) + "…" else text

    /** A JSON value as JavaScript's String() says it: a whole number without a point, an array its items joined by commas
     * (null as nothing), an object "[object Object]". */
    fun jsString(value: Json?): String = when (value) {
        null, Json.Null -> "null"
        is Json.Bool -> if (value.value) "true" else "false"
        is Json.Num -> jsNumber(value.value)
        is Json.Str -> value.value
        is Json.Arr -> value.items.joinToString(",") { if (it == Json.Null) "" else jsString(it) }
        is Json.Obj -> "[object Object]"
    }

    /** A number as JavaScript writes it (Number::toString): its shortest digits that read back as it, in figures from
     * 1e-6 up to 1e21 ("0.00001", "12345678901234567000": a whole number past 2^53 its shortest digits and zeros, never its
     * exact value), in an exponent outside that ("1e-7", "1e+21"). As the canonical JSON writes it (Json.kt), and the
     * words JavaScript has for what JSON has no number for. */
    fun jsNumber(number: Double): String {
        if (number.isNaN()) return "NaN"
        if (number.isInfinite()) return if (number > 0) "Infinity" else "-Infinity"
        return sh.invincible.bot.core.jsNumber(number)
    }

    /** What a loop runs, in a sentence: a heartbeat, a run (its network, its goal, what proves it), a call (its tool and
     * its arguments, by name), or a tell. */
    fun describeTask(task: Json?): String {
        val kind = task["kind"].string ?: return "A task this node can't read."
        return when (kind) {
            "heartbeat" -> {
                val what = if (task["checklist"].string.isNullOrEmpty()) "Heartbeat: checks the fleet and the machine it runs on." else "Heartbeat: checks the fleet, then reads your checklist."
                what + if (task["selfAction"].bool == false) " Only reports: self-action is off." else " Then fixes what's safe itself."
            }
            "run" -> {
                val gates = task["gates"].list.mapNotNull { it.string }
                val proves = if (gates.isEmpty()) "" else " Done means ${if (gates.size == 1) "this passes" else "these ${gates.size} pass"}: ${clip(gates.joinToString(" · "), 160)}"
                "Run, ${task["network"].string ?: ""}: ${clip(task["goal"].string ?: "", 160)}$proves"
            }
            "tell" -> {
                val text = task["text"].string ?: ""
                "Tells you${if (text.isEmpty()) ", with what woke it" else ": ${clip(text, 160)}"}: a notice in Needs you, and your loop's name on your phone."
            }
            else -> {
                val args = task["args"].fields.entries.sortedBy { it.key }.joinToString(" ") { "${it.key}=${jsString(it.value)}" }
                "Calls ${task["connector"].string ?: ""}.${task["tool"].string ?: ""}${if (args.isEmpty()) "" else " ${clip(args, 120)}"}"
            }
        }
    }

    private val GITHUB_WORDS = mapOf("ci.failed" to "a failed CI run", "pushed" to "a push", "issue.opened" to "a new issue", "pr.opened" to "a new pull request")

    /** A wake in a few words (lib/wakes.ts describeWake). */
    fun describeWake(wake: Json?): String = when (wake["kind"].string) {
        "webhook" -> "a webhook"
        "mail" -> {
            val query = wake["query"].string ?: ""
            "new ${if (wake["connector"].string == "gmail") "Gmail" else "Outlook"} mail${if (query.isEmpty()) "" else " matching \"$query\""}"
        }
        "github" -> {
            val branch = wake["branch"].string ?: ""
            val what = wake["on"].list.mapNotNull { it.string }.map { on -> if (on == "ci.failed" && branch.isNotEmpty()) "a failed CI run on $branch" else GITHUB_WORDS[on] ?: on }
            "${what.joinToString(" or ")} in ${wake["owner"].string ?: ""}/${wake["repo"].string ?: ""}"
        }
        else -> ""
    }

    /** What else wakes it, and that a burst of them is one run (lib/wakes.ts describeWakes); "" for none. */
    fun describeWakes(wakes: List<Json>, cooldownMs: Double?): String {
        if (wakes.isEmpty()) return ""
        // (JavaScript's Math.round: half up.)
        val minutes = Math.floor((cooldownMs ?: 600_000.0) / 60_000 + 0.5).toLong()
        return "Also wakes on ${wakes.joinToString(" · ") { describeWake(it) }}; a burst within $minutes min is one run."
    }
}
