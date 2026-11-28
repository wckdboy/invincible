package sh.invincible.bot.core

import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.abs

/*
 * What Settings' Providers and Permissions say, read-only in this build (the lead's ruling of 28 November 2026: adding
 * and editing come next), in the PWA's words and held to its vectors (SettingsWordsVectorsTest): a seat of yours (`GET
 * /api/seats`, core's SeatView; lib/seats.ts), a rule of yours on the commands the work runs (`GET /api/rules`, core's
 * RuleView; lib/rules.ts ruleSentence), and a hand-off grant from one node to another's agents (`GET /api/fabric/grants`,
 * core's HandoffGrantView; lib/grants.ts).
 */

/** A seat: an account you hold with a vendor, serving the agents you chose. */
object Seats {
    private val KINDS = mapOf(
        "claude-subscription" to "Claude plan",
        "chatgpt-codex" to "ChatGPT plan",
        "chatgpt-siwc" to "ChatGPT plan",
        "mistral-vibe" to "Mistral plan",
        "google-antigravity" to "Gemini plan",
        "plan" to "Coding plan",
        "api" to "API key",
    )

    /** A seat's kind, named (lib/seats.ts SEAT_KIND_WORDS); a later release's, as the PWA says one. */
    fun kindName(kind: String): String = KINDS[kind] ?: "A kind this version doesn't know"

    /** A sign-in that ends within this many days is said to need signing in again (lib/seats.ts RENEW_DAYS). */
    private const val RENEW_DAYS = 7
    private const val DAY = 86_400_000L

    /** JavaScript's latest date: a time past it is no date, and is said "later" (the PWA's `new Date(at)`). */
    private const val LAST_DATE = 8_640_000_000_000_000L
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** A time as the seats page says it: HH:MM in UTC, with the day when it isn't today's; one no date can be, null. */
    private fun whenAt(at: Long, now: Long): String? {
        if (abs(at) > LAST_DATE) return null
        val then = Instant.ofEpochMilli(at).atZone(ZoneOffset.UTC)
        val clock = "%02d:%02d UTC".format(then.hour, then.minute)
        val today = Instant.ofEpochMilli(now).atZone(ZoneOffset.UTC).toLocalDate()
        return if (then.toLocalDate() == today) clock else "${then.dayOfMonth} ${MONTHS[then.monthValue - 1]}, $clock"
    }

    /**
     * Where a seat stands (core's SeatState), in a word or two, and how it reads (lib/seats.ts seatStateWords): "ok",
     * "work", "warn" or "quiet". [plan]: its plan's tier, where known ("max": "Signed in · Max").
     */
    fun state(state: Json, plan: String?, now: Long): Pair<String, String> = when (state["is"].string) {
        "ready" -> {
            val renewBy = state["renewBy"].long
            when {
                renewBy != null && renewBy - now <= RENEW_DAYS * DAY -> "Sign in again before ${whenAt(renewBy, now) ?: "it ends"}" to "warn"
                plan != null -> "Signed in · ${plan.replaceFirstChar { it.uppercase() }}" to "ok"
                else -> "Signed in" to "ok"
            }
        }
        "signing-in" -> "Signing in" to "work"
        "resting" -> (whenAt(state["until"].long ?: Long.MAX_VALUE, now)?.let { "Spent: back at $it" } ?: "Spent: back later") to "quiet"
        else -> when (state["why"].string) {
            "never" -> "Not signed in" to "warn"
            "cancelled" -> "Sign-in cancelled" to "quiet"
            "expired" -> "Sign-in lapsed" to "quiet"
            "failed" -> "Sign-in failed" to "warn"
            "wrong-account" -> "Signed in to another account: refused" to "warn"
            else -> "Signed out" to "warn"
        }
    }
}

/** Settings' own words, every app's (lib/usage.ts SETTINGS_WORDS). */
object SettingsWords {
    /** What this device's grant lets it do on its node, heading its line on This device ("May" read as the month). */
    const val SCOPES = "Can do"

    /** A page that shows but can't change yet, said in one line. */
    const val READ_ONLY = "Read-only for now: adding and changing come next."
}

/** Your rules and the hand-offs one node may make without asking you, in the PWA's words. */
object Permissions {
    /**
     * A rule's name as its row's title (lib/rules.ts ruleTitle): a rule's name is its id, typed as one ("pushes",
     * "no-force-push"), so it is said as you'd say it, a capital first and its hyphens and underscores spaces.
     */
    fun ruleTitle(name: String): String = name.replace(Regex("[-_]+"), " ").trim().replaceFirstChar { it.uppercase() }

    /**
     * A rule (core's RuleView's rule) as a sentence (lib/rules.ts ruleSentence): what it does, and when, its globs and text
     * as written, its first word a capital, its text in curly quotes, a full stop.
     */
    fun sentence(rule: Json): String {
        val words = rule["words"].list.mapNotNull { it.string }
        val contains = rule["contains"].string
        val out = StringBuilder(
            when (rule["does"].string) {
                "check" -> "runs ${rule["run"].string ?: ""} after a command that succeeds, when "
                "tell" -> "tells you when a command has run, when "
                "halt" -> "halts the work when "
                else -> "refuses the command when "
            },
        )
        if (words.isNotEmpty()) {
            out.append("a word matches ")
            words.forEachIndexed { i, glob ->
                if (i > 0) out.append(if (i == words.size - 1) " or " else ", ")
                out.append(glob)
            }
        }
        if (contains != null) out.append(if (words.isEmpty()) "it holds " else " and it holds ").append("“$contains”")
        return out.toString().replaceFirstChar { it.uppercase() } + "."
    }

    /** A hand-off grant: from which node to which (lib/grants.ts handoffTitle). */
    fun handoffTitle(grant: Json): String = "${grant["from"]["name"].string ?: ""} → ${grant["to"]["name"].string ?: ""}"

    /**
     * Its terms in a line (lib/grants.ts handoffTerms): whose agents (none named: any of them), and what its tasks there
     * may spend a day; terms this version doesn't understand (none), said so.
     */
    fun handoffTerms(terms: Json?): String {
        if (terms == null || terms !is Json.Obj) return "Written by a newer node: not understood here."
        val agents = terms["agents"].list.mapNotNull { it.string }
        val budget = terms["budgetUsdPerDay"].double ?: 0.0
        return "To ${if (agents.isEmpty()) "any of its agents" else agents.joinToString(", ")} · up to $${"%.2f".format(java.util.Locale.ROOT, budget)} a day"
    }
}
