package sh.invincible.bot.core

import kotlin.math.max
import kotlin.math.roundToLong

/*
 * A task's work, folded (the PWA's lib/steps.ts, 26 November 2026: T3 Code's "Worked for 2m 14s ›", its steps grouped:
 * "Read 6 files", "Edited 3 files", "Ran 4 commands"), and what proves it, told apart from what its agent says: each
 * gate's command and how it ended, and the reviewer's verdict, as the runner wrote them on the task's trail (POST
 * /api/team/trail), never the agent's own account. Pure, from the trail's lines as the node keeps them (each starts with
 * its step's mark: "Running · …", "Exit 0 · …", "Gate 1/2 · exit 0 · …", "Review · pass"). Held to the PWA's own words
 * by the vectors' `steps` section.
 */

/** A line of a task's trail: its number, when, and what the runner wrote. */
data class TrailEntry(val n: Long, val at: Long, val text: String) {
    companion object {
        fun of(j: Json): TrailEntry = TrailEntry(j["n"].long ?: 0, j["at"].long ?: 0, j["text"].string ?: "")
    }
}

object Steps {
    enum class Kind { PLAN, READ, EDIT, RUN, SUBMITTED, GATE, REVIEW, NOTE; val wire: String get() = name.lowercase() }
    enum class Tone { NEUTRAL, OK, FAILED, WARN; val wire: String get() = name.lowercase() }

    /** One line of what it ran or touched, a command or a path, with its exit where it is known. */
    data class Item(val text: String, val exit: Int?)

    /** One line of the work, folded: a step of its own (its plan, a gate, the review, a note), or a run of steps alike:
     * the line it folds to, what is in it, its tone, the trail's numbers it spans, and when it began. */
    data class Group(val kind: Kind, val text: String, val items: List<Item>, val tone: Tone, val from: Long, val to: Long, val at: Long)

    /** What the work came to in figures: from its first line to its last (or the runner's record), how many commands and
     * how many of them failed, and the files it read and edited, each counted once. */
    data class Summary(val ms: Long, val commands: Int, val failed: Int, val read: Int, val edited: Int)

    enum class GateState { PASSED, FAILED, RUNNING, WAITING; val wire: String get() = name.lowercase() }

    /** A gate as its latest round left it: its command, state, exit, how long it took, what it printed first, and how it
     * exited before any work (the gates run first: 0 means it passed already, so it shows nothing about the work). */
    data class GateRow(val command: String, val state: GateState, val exit: Int?, val ms: Long?, val said: String, val before: Int?)

    data class Review(val verdict: String, val notes: String, val at: Long)

    // ---- reading a line ----------------------------------------------------------------------------------------------

    private sealed interface Line {
        data class Plan(val text: String) : Line
        data class Command(val command: String) : Line
        data class Exit(val code: Int) : Line
        data class Gate(val index: Int, val of: Int, val exit: Int, val command: String, val output: String) : Line
        data class Gates(val commands: List<String>) : Line
        data object Gated : Line
        data class Baseline(val exits: List<Int>) : Line
        data class Submitted(val summary: String) : Line
        data class Reviewed(val verdict: String, val notes: String) : Line
        data object Thought : Line
        data class Note(val text: String, val tone: Tone) : Line
    }

    private val NOTE_TONE = mapOf(
        "Tripwire" to Tone.WARN, "Check" to Tone.NEUTRAL, "Audit" to Tone.NEUTRAL, "Budget" to Tone.WARN, "Retry" to Tone.NEUTRAL,
        "Escalated" to Tone.WARN, "Routed" to Tone.NEUTRAL, "Tests changed" to Tone.WARN, "Contract" to Tone.NEUTRAL, "Steps" to Tone.NEUTRAL,
        "Lease" to Tone.WARN, "No command to run" to Tone.NEUTRAL, "Review" to Tone.WARN,
    )

    private val baselineExit = Regex("^\\d+\\. exit (-?\\d+) · ")
    private val exitMark = Regex("Exit (-?\\d+)")
    private val gateMark = Regex("Gate (\\d+)/(\\d+)")
    private val gateRest = Regex("exit (-?\\d+) · ([\\s\\S]*)")
    private val listed = Regex("\\d+\\. ([\\s\\S]+)")

    private fun read(text: String): Line {
        val lines = text.split("\n")
        val head = lines[0]
        val rest = lines.drop(1)
        val body = rest.joinToString("\n")
        val at = head.indexOf(" · ")
        val mark = if (at < 0) head else head.substring(0, at)
        val said = if (at < 0) "" else head.substring(at + 3)
        when (mark) {
            "Plan" -> return Line.Plan(listOf(said, body).filter { it.isNotEmpty() }.joinToString("\n"))
            "Running" -> return Line.Command(listOf(said, body).filter { it.isNotEmpty() }.joinToString("\n"))
            "Thinking" -> return Line.Thought
            "Submitted for review" -> return Line.Submitted(said)
            "Gates before the work" -> return Line.Baseline((listOf(said) + rest).mapNotNull { baselineExit.find(it)?.groupValues?.get(1)?.toInt() })
        }
        exitMark.matchEntire(mark)?.let { return Line.Exit(it.groupValues[1].toInt()) }
        val gate = gateMark.matchEntire(mark)
        val gated = gateRest.matchEntire(said)
        if (gate != null && gated != null) {
            return Line.Gate(gate.groupValues[1].toInt(), gate.groupValues[2].toInt(), gated.groupValues[1].toInt(), gated.groupValues[2], body)
        }
        if (mark == "Gates") {
            // "Gates · 1. bun test\n2. bun run typecheck" (the list), or "Gates · all 2 passed" / "1 of 2 failed: back to the work".
            val commands = (listOf(said) + rest).mapNotNull { listed.matchEntire(it)?.groupValues?.get(1) }
            return if (commands.isNotEmpty()) Line.Gates(commands) else Line.Gated
        }
        if (mark == "Review" && (said == "pass" || said == "revise")) return Line.Reviewed(said, JsText.trim(body))
        return Line.Note(head, NOTE_TONE[mark] ?: Tone.NEUTRAL)
    }

    /** A shell word at the start of [text] ('quoted', as the tools quote a path, or bare), and what follows it. */
    private fun word(text: String): Pair<String, String>? {
        if (text.startsWith("'")) {
            val out = StringBuilder()
            var i = 1
            while (true) {
                val close = text.indexOf('\'', i)
                if (close < 0) return null
                out.append(text, i, close)
                // '\'' is a quote inside a quoted word.
                if (text.startsWith("\\''", close + 1)) {
                    out.append('\'')
                    i = close + 4
                    continue
                }
                return out.toString() to text.substring(close + 1)
            }
        }
        var end = 0
        while (end < text.length && !JsText.space(text[end])) end++
        return if (end == 0) null else text.substring(0, end) to text.substring(end)
    }

    /** What a command was, as the agent's own tools say their calls: a file read, edited or written, or a command run. */
    data class CommandKind(val kind: Kind, val path: String?)

    private val reading = Regex("sed -n '\\d+,\\d+p' ([\\s\\S]+)")
    private val editing = Regex("edit ([\\s\\S]+)")
    private val writing = Regex("cat > ([\\s\\S]+)")
    private val editRest = Regex("^( --all)? <<'")

    fun commandKind(command: String): CommandKind {
        reading.matchEntire(command)?.let { m ->
            val path = word(m.groupValues[1])
            if (path != null && JsText.trim(path.second).isEmpty()) return CommandKind(Kind.READ, path.first)
        }
        editing.matchEntire(command)?.let { m ->
            val path = word(m.groupValues[1])
            if (path != null && editRest.containsMatchIn(path.second)) return CommandKind(Kind.EDIT, path.first)
        }
        writing.matchEntire(command)?.let { m ->
            val path = word(m.groupValues[1])
            if (path != null && path.second.startsWith(" <<'")) return CommandKind(Kind.EDIT, path.first)
        }
        return CommandKind(Kind.RUN, null)
    }

    private fun firstLine(text: String): String = JsText.firstLine(text)
    private fun baseName(path: String): String = path.trimEnd('/').split("/").last().ifEmpty { path }
    private fun plural(n: Int, one: String, many: String = "${one}s"): String = "$n ${if (n == 1) one else many}"
    private val workspace = Regex("^/work/tasks/task-[a-z0-9_-]{12}/")

    /** The folder every path is in, under the task's own workspace (null: none in common, or only the workspace itself). */
    private fun commonFolder(paths: List<String>): String? {
        val parts = paths.map { workspace.replace(it, "").split("/").dropLast(1) }
        if (parts.isEmpty()) return null
        val shared = ArrayList<String>()
        var i = 0
        while (parts.all { i < it.size && it[i] == parts[0][i] }) {
            shared += parts[0][i]
            i++
        }
        val folder = shared.joinToString("/")
        return if (folder.isNotEmpty() && folder != "/") folder else null
    }

    /** Names, as a sentence: "a.ts", "a.ts and b.ts", "a.ts, b.ts and c.ts"; more than three are counted. */
    private fun named(names: List<String>): String {
        if (names.size > 3) return ""
        return if (names.size == 1) names[0] else "${names.dropLast(1).joinToString(", ")} and ${names.lastOrNull()}"
    }

    private class Raw(val text: String, var exit: Int?, val path: String?)

    private fun groupText(kind: Kind, items: List<Raw>): Pair<String, Tone> {
        if (kind == Kind.RUN) {
            val failed = items.count { it.exit != null && it.exit != 0 }
            val text = if (items.size == 1) "Ran ${firstLine(items[0].text)}" else "Ran ${plural(items.size, "command")}"
            return (if (failed > 0) "$text · ${if (failed == items.size && items.size == 1) "failed" else "$failed failed"}" else text) to (if (failed > 0) Tone.WARN else Tone.NEUTRAL)
        }
        val paths = LinkedHashSet<String>().apply { for (item in items) add(item.path ?: item.text) }.toList()
        val names = named(paths.map(::baseName))
        val folder = commonFolder(paths)
        val verb = if (kind == Kind.READ) "Read" else "Edited"
        return (if (names.isNotEmpty()) "$verb $names" else "$verb ${plural(paths.size, "file")}${if (folder != null) " in $folder" else ""}") to Tone.NEUTRAL
    }

    /**
     * The work, folded: steps alike in a row become one group (reads, edits, commands), and the plan, each gate, the review
     * and each note of the runner's stand alone, in the order they happened. What the agent thought aloud is not a step.
     */
    fun groups(entries: List<TrailEntry>): List<Group> {
        val groups = ArrayList<Group>()
        var openKind: Kind? = null
        var openFrom = 0L
        var openTo = 0L
        var openAt = 0L
        val raw = ArrayList<Raw>()
        fun close() {
            val kind = openKind ?: return
            val (text, tone) = groupText(kind, raw)
            groups += Group(kind, text, raw.map { Item(it.text, it.exit) }, tone, openFrom, openTo, openAt)
            openKind = null
            raw.clear()
        }
        for (entry in entries) {
            val line = read(entry.text)
            if (line is Line.Thought || line is Line.Gates || line is Line.Gated || line is Line.Baseline) continue
            if (line is Line.Exit) {
                val last = raw.lastOrNull()
                if (openKind != null && last != null && last.exit == null) {
                    last.exit = line.code
                    openTo = entry.n
                }
                continue
            }
            if (line is Line.Command) {
                val what = commandKind(line.command)
                if (openKind != what.kind) {
                    close()
                    openKind = what.kind
                    openFrom = entry.n
                    openTo = entry.n
                    openAt = entry.at
                }
                raw += Raw(if (what.kind == Kind.RUN) firstLine(line.command) else what.path ?: line.command, null, what.path)
                openTo = entry.n
                continue
            }
            close()
            fun one(kind: Kind, text: String, tone: Tone, items: List<Item> = emptyList()) {
                groups += Group(kind, text, items, tone, entry.n, entry.n, entry.at)
            }
            when (line) {
                is Line.Plan -> one(Kind.PLAN, "Planned the work", Tone.NEUTRAL, line.text.split("\n").filter { JsText.trim(it).isNotEmpty() }.map { Item(JsText.trim(it), null) })
                is Line.Submitted -> one(Kind.SUBMITTED, "Submitted it for its gates and review", Tone.NEUTRAL)
                is Line.Gate -> one(Kind.GATE, "Gate ${line.index} of ${line.of} · ${if (line.exit == 0) "passed" else "failed, exit ${line.exit}"}", if (line.exit == 0) Tone.OK else Tone.FAILED, listOf(Item(line.command, line.exit)))
                is Line.Reviewed -> one(Kind.REVIEW, if (line.verdict == "pass") "The reviewer passed it" else "The reviewer sent it back", if (line.verdict == "pass") Tone.OK else Tone.WARN, if (line.notes.isNotEmpty()) listOf(Item(firstLine(line.notes), null)) else emptyList())
                is Line.Note -> one(Kind.NOTE, line.text, line.tone)
            }
        }
        close()
        return groups
    }

    /** What the work came to in figures, for its folded line ("Worked for 6m 12s · ran 14 commands · edited 5 files"). */
    fun summary(entries: List<TrailEntry>, record: TeamTask.Record? = null): Summary {
        var commands = 0
        var failed = 0
        val read = HashSet<String>()
        val edited = HashSet<String>()
        var last: Kind? = null
        for (entry in entries) {
            val line = read(entry.text)
            if (line is Line.Command) {
                val what = commandKind(line.command)
                last = what.kind
                when (what.kind) {
                    Kind.READ -> read += what.path!!
                    Kind.EDIT -> edited += what.path!!
                    else -> commands++
                }
            } else if (line is Line.Exit && last == Kind.RUN && line.code != 0) {
                failed++
                last = null
            }
        }
        val ms = if (record != null) max(0, record.endedAt - record.startedAt) else if (entries.size > 1) max(0, entries.last().at - entries.first().at) else 0
        return Summary(ms, commands, failed, read.size, edited.size)
    }

    /** JavaScript's Math.round: half up, so every app comes to the same whole number. */
    private fun jsRound(x: Double): Double = kotlin.math.floor(x + 0.5).let { if (it - x > 0.5) it - 1 else it }

    /** A span of work as its folded line says it: "42s", "6m 12s", "1h 04m". */
    fun workedFor(ms: Long): String {
        val seconds = max(0L, jsRound(ms / 1000.0).roundToLong())
        if (seconds < 60) return "${seconds}s"
        val minutes = seconds / 60
        if (minutes < 60) return "${minutes}m ${(seconds % 60).toString().padStart(2, '0')}s"
        return "${minutes / 60}h ${(minutes % 60).toString().padStart(2, '0')}m"
    }

    /** The folded line's figures after its time, as words: "ran 14 commands · edited 5 files". */
    fun summaryWords(summary: Summary): String = listOfNotNull(
        if (summary.commands > 0) "ran ${plural(summary.commands, "command")}" else null,
        if (summary.edited > 0) "edited ${plural(summary.edited, "file")}" else if (summary.read > 0) "read ${plural(summary.read, "file")}" else null,
    ).joinToString(" · ")

    /** The runner's own line: "exit 0", or "exit 0 · 12 ms", which the gate's row says already. */
    private val exitLine = Regex("exit -?\\d+( · \\d+ ms\\b.*)?")

    /** The first line of what a command printed that says something (not its exit, not "stderr:", not the runner's own
     * line). */
    private fun firstSaid(output: String): String {
        val line = output.split("\n").map(JsText::trim).firstOrNull { it.isNotEmpty() && it != "stderr:" && it != "(no output)" && !exitLine.matches(it) } ?: return ""
        return line.take(200)
    }

    /**
     * Each of a task's gates ([gates]: its commands, yours first) as its latest round left it, from the runner's lines:
     * passed or failed with its exit and how long it took; running (the first without a result, while the task is at work
     * and has been submitted); or waiting. With how each exited before any work.
     */
    fun gateRows(gates: List<String>, entries: List<TrailEntry>, running: Boolean): List<GateRow> {
        var commands = gates
        var before: List<Int> = emptyList()
        var round = -1
        entries.forEachIndexed { i, entry ->
            when (val line = read(entry.text)) {
                is Line.Gates -> commands = line.commands
                is Line.Baseline -> before = line.exits
                is Line.Submitted -> round = i
                else -> {}
            }
        }
        class Result(val exit: Int, val ms: Long, val said: String)
        val results = HashMap<Int, Result>()
        var lastAt = if (round >= 0) entries[round].at else 0
        if (round >= 0) {
            for (entry in entries.drop(round + 1)) {
                val line = read(entry.text)
                if (line is Line.Gate) {
                    results[line.index - 1] = Result(line.exit, max(0, entry.at - lastAt), firstSaid(line.output))
                    lastAt = entry.at
                }
            }
        }
        var next = running && round >= 0
        return commands.mapIndexed { i, command ->
            val result = results[i]
            val exitBefore = before.getOrNull(i)
            if (result != null) {
                GateRow(command, if (result.exit == 0) GateState.PASSED else GateState.FAILED, result.exit, result.ms, result.said, exitBefore)
            } else {
                val state = if (next) GateState.RUNNING else GateState.WAITING
                next = false
                GateRow(command, state, null, null, "", exitBefore)
            }
        }
    }

    /** The reviewer's latest verdict, as the runner wrote it (null: no review yet). */
    fun reviewOf(entries: List<TrailEntry>): Review? {
        for (i in entries.indices.reversed()) {
            val line = read(entries[i].text)
            if (line is Line.Reviewed) return Review(line.verdict, line.notes, entries[i].at)
        }
        return null
    }

    /** Whether the review was by the same model that did the work after all (no other reviewer model could answer). */
    fun sameModelReview(entries: List<TrailEntry>): Boolean = entries.any { it.text.startsWith("Review · by the same model") }

    /** What a running task is doing this moment, as its live line says it: the command it runs (and since when), or the step. */
    data class Live(val text: String, val command: Boolean, val since: Long)

    fun liveStep(entries: List<TrailEntry>): Live? {
        val last = entries.lastOrNull() ?: return null
        return when (val line = read(last.text)) {
            is Line.Command -> Live(firstLine(line.command), true, last.at)
            is Line.Submitted -> Live("Running its gates", false, last.at)
            is Line.Gate -> Live(if (line.index < line.of) "Running gate ${line.index + 1} of ${line.of}" else "The reviewer is reading it", false, last.at)
            is Line.Plan -> Live("Starting on its plan", false, last.at)
            is Line.Reviewed -> Live(if (line.verdict == "pass") "Keeping its changes" else "Back to the work", false, last.at)
            is Line.Exit -> Live("Reading what it printed", false, last.at)
            is Line.Thought -> Live("Thinking", false, last.at)
            else -> Live("Working", false, last.at)
        }
    }

    /** What proves a task, in one place: its gates as they stand, how many passed, the reviewer's verdict and state
     * (passed, sent back, reading, waits, none), and the two ways a pass can say less than it seems. */
    data class Proof(val gates: List<GateRow>, val passed: Int, val review: Review?, val reviewer: String, val sameModel: Boolean, val provesNothing: Boolean)

    /** What proves a task, as facts (the PWA's ProofFacts): each gate's exit and its exit before the work, the reviewer's
     * verdict, and whether the reviewer was the model that did the work. */
    data class Facts(val gates: List<Gate>, val review: String?, val sameModel: Boolean) {
        data class Gate(val exit: Int?, val before: Int?)
    }

    /** The facts its trail gives (the PWA's factsOfProof). */
    fun facts(proof: Proof): Facts = Facts(proof.gates.map { Facts.Gate(it.exit, it.before) }, proof.review?.verdict, proof.sameModel)

    /** The facts its record keeps (the PWA's factsOfRecord); null from a record made before they were kept, or none yet. */
    fun facts(record: TeamTask.Record?): Facts? {
        val proof = record?.proof ?: return null
        return Facts(proof.after.mapIndexed { i, exit -> Facts.Gate(exit, proof.before.getOrNull(i)) }, proof.review, proof.sameModel)
    }

    enum class Verdict(val wire: String) {
        PROVEN("proven"), REVIEWED("reviewed"), FAILED("failed"), REJECTED("rejected"), GAVE_UP("gave-up"), STOPPED("stopped"), UNVERIFIED("unverified");

        /** Whether it says the work went wrong (red, with its word). */
        val wrong: Boolean get() = this == FAILED || this == REJECTED || this == GAVE_UP
    }

    /** A verdict, and its word. */
    data class Said(val word: String, val verdict: Verdict)

    /**
     * A task's verdict in words that follow its proof, once it has ended (the PWA's verdictOf; the owner's word, 26 November
     * 2026: never "Verified" above a warning that its gates proved nothing): Proven, Reviewed, not proven (Reviewed where
     * nothing says what its gates showed), Failed · gate 2, Sent back, Gave up, Stopped, Failed, Not verified. Null while
     * it is in hand.
     */
    /**
     * A proof in one line, as a chat's compact row says it (lib/steps.ts proofLine, held to the vectors): its verdict, then
     * how many of its gates passed, as the task's page counts them; its verdict alone where no gate ran. Null while it is
     * in hand.
     */
    fun proofLine(task: TeamTask): String? {
        val facts = facts(task.record)
        val said = verdict(task.status, task.verified, task.error, task.record, facts) ?: return null
        val gates = facts?.gates ?: emptyList()
        if (gates.isEmpty()) return said.word
        val passed = gates.count { it.exit == 0 }
        return "${said.word} · $passed of ${gates.size} ${if (gates.size == 1) "gate" else "gates"} passed"
    }

    fun verdict(status: String, verified: Boolean, error: String?, record: TeamTask.Record?, facts: Facts?): Said? {
        if (status != "done" && status != "failed" && status != "stopped") return null
        val how = record?.ended ?: (error ?: "").trim().split("\n")[0].trim()
        if (status == "stopped" || how == "stopped") return Said("Stopped", Verdict.STOPPED)
        if (status == "done" && verified) {
            if (facts == null) return Said("Reviewed", Verdict.REVIEWED)
            val shows = facts.gates.any { it.exit == 0 && it.before != null && it.before != 0 }
            return if (shows && facts.review == "pass" && !facts.sameModel) Said("Proven", Verdict.PROVEN) else Said("Reviewed, not proven", Verdict.REVIEWED)
        }
        val failing = facts?.gates?.indexOfFirst { it.exit != null && it.exit != 0 } ?: -1
        if (failing >= 0) return Said("Failed · gate ${failing + 1}", Verdict.FAILED)
        if (facts?.review == "revise") return Said("Sent back", Verdict.REJECTED)
        if (how == "gave-up") return Said("Gave up", Verdict.GAVE_UP)
        return if (status == "failed") Said("Failed", Verdict.FAILED) else Said("Not verified", Verdict.UNVERIFIED)
    }

    fun proofOf(status: String, gates: List<String>, entries: List<TrailEntry>): Proof {
        val running = status == "running"
        val rows = gateRows(gates, entries, running)
        val passed = rows.count { it.state == GateState.PASSED }
        val review = reviewOf(entries)
        val reviewer = when {
            review != null -> if (review.verdict == "pass") "passed" else "sent back"
            !running -> "none"
            rows.isNotEmpty() && passed == rows.size -> "reading"
            else -> "waits"
        }
        return Proof(rows, passed, review, reviewer, sameModelReview(entries), rows.isNotEmpty() && rows.all { it.before == 0 })
    }

    /**
     * What a task cost, in a line: its money at your prices (a lower bound with "at least" when a call went uncounted, "no
     * price" when a model that answered has none) against its budget, and how long it ran, as the runner recorded it.
     * Before it has ended, its budget alone.
     */
    fun costWords(budgetUsd: Double?, record: TeamTask.Record?, prices: Map<String, Price>): String {
        val budget = budgetUsd?.let(Usage::usd)
        if (record == null) return if (budget != null) "budget $budget" else ""
        val total = Spend.total(record.spent)
        val cost = Spend.costOf(record.spent, prices)
        val money = when {
            total.calls == 0.0 -> null
            total.unknown == total.calls -> "spend unknown"
            cost.unpriced.isNotEmpty() -> "no price"
            else -> "${if (cost.complete) "" else "at least "}${Usage.usd(cost.usd)}"
        }
        val spent = if (money != null) (if (budget != null) "$money of $budget" else money) else if (budget != null) "budget $budget" else if (total.calls == 0.0) "no model calls" else null
        // (A run of under half a second says no time: never "0s".)
        val ran = record.endedAt - record.startedAt
        return listOfNotNull(spent, if (ran >= 500) workedFor(ran).ifEmpty { null } else null).joinToString(" · ")
    }

    // ---- a trail read page by page (the PWA's lib/trail.ts) ------------------------------------------------------------

    /** A task's trail as held: the number of the last line (the next page is asked for after it) and its lines. */
    data class Trail(val after: Long = 0, val entries: List<TrailEntry> = emptyList())

    /** As many lines as the node itself keeps of one task. */
    private const val KEEP = 600

    /** A page taken in: only the lines after the last one held, so a page that comes twice (or late) adds nothing. */
    fun take(trail: Trail, page: List<TrailEntry>): Trail {
        val fresh = page.filter { it.n > trail.after }
        if (fresh.isEmpty()) return trail
        return Trail(fresh.last().n, (trail.entries + fresh).takeLast(KEEP))
    }

    /** When to ask for the next page: at once while the node has more (and this page held something); while the task is
     * at work or queued, once its entry in the team moves (a screen reads again then, never on a timer); never once it
     * has ended. */
    enum class Next { NOW, WAIT, DONE }

    fun next(status: String, more: Boolean, took: Boolean): Next {
        if (more && took) return Next.NOW
        return if (status == "running" || status == "queued") Next.WAIT else Next.DONE
    }
}

/**
 * What a task's card says, in words (the PWA's lib/task-card.ts and lib/timeline.ts, the parts a thread reads): how it
 * ended and why, what the agent said of it, what can be done with it, and the same task given again.
 */
object TaskWords {
    /** How an agent's run can end, as the runner records it on a task that wasn't verified. */
    private val RUN_ENDS = mapOf(
        "gave-up" to "It gave up.",
        "unverified" to "Not verified: its gates or the independent review did not pass.",
        "stopped" to "It stopped before the work was done.",
    )

    /** When nothing was recorded of why. */
    private val UNSAID = mapOf("failed" to "It failed without saying why.", "stopped" to "Stopped.", "interrupted" to "Interrupted. Review it before resuming.", "done" to "The work was not independently verified.")

    /** As much of what the agent said as a card shows. */
    private const val SAID = 1000

    /** How a task ended: why it wasn't verified (null: it was), and what the agent said of it, its own summary before the
     * runner's lines (null: nothing). Null for work still in hand. */
    data class End(val why: String?, val said: String?)

    fun end(task: TeamTask): End? {
        if (task.status == "proposed" || task.status == "queued" || task.status == "running") return null
        val summary = JsText.trim(task.output.split("\n\nReview:")[0])
        val said = if (summary.isEmpty() || summary.startsWith("Review:")) null else if (summary.length > SAID) "${summary.substring(0, SAID - 1)}…" else summary
        if (task.status == "done" && task.verified) return End(null, said)
        val error = task.error?.let(JsText::trim)
        return End((if (!error.isNullOrEmpty()) RUN_ENDS[error] ?: error else null) ?: UNSAID[task.status], said)
    }

    /** The words an agent may end on that only claim what its proof says ("Verified.", "Done."). */
    private val BARE_CLAIMS = setOf("verified", "done", "proven", "passed", "pass", "complete", "completed", "finished", "ok", "success", "succeeded")

    /**
     * What the agent said, as a thread shows it beside its proof: its own account as it said it, or nothing where it said
     * no more than a verdict, which would say the verdict twice, and in the agent's voice (the iPhone's saidBesideProof).
     */
    fun saidBesideProof(said: String?): String? {
        val trimmed = said?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val word = trimmed.lowercase().trim { it.isWhitespace() || it.category.code.startsWith("P") }
        return if (word in BARE_CLAIMS) null else trimmed
    }

    /** How long a gate took, to the precision it needs: "340 ms", "4.2 s", "2m 05s". Never "0:00". */
    fun took(ms: Long): String = when {
        ms < 1_000 -> "$ms ms"
        ms < 60_000 -> String.format(java.util.Locale.ROOT, "%.1f s", ms / 1_000.0)
        else -> Steps.workedFor(ms)
    }

    /** How a gate stood before the work: failed then and passes now (it shows the work was done), or passed then too. */
    fun before(before: Int?, exit: Int?): String? = when {
        before == null -> null
        before == 0 -> "passed before the work too"
        exit == 0 -> "failed before the work"
        else -> "failed before the work too"
    }

    /** The folded work's head: "Ada worked for 6m 12s", or under half a second no time at all ("Ada worked"), never "0s". */
    fun worked(name: String, ms: Long): String = if (ms >= 500) "$name worked for ${Steps.workedFor(ms)}" else "$name worked"

    /**
     * What a verdict rests on, as a line under its word, never that word again: "It gave up." under "Gave up" says nothing
     * more; "Not verified: its gates or the independent review did not pass." under "Not verified" says the rest. Null:
     * nothing more to say. (The iPhone's TaskCard.because.)
     */
    fun because(why: String?, verdict: String): String? {
        val said = why?.trim().orEmpty()
        if (said.isEmpty()) return null
        fun plain(text: String) = text.lowercase().trim { it.isWhitespace() || it.category.code.startsWith("P") }
        var bare = plain(said)
        if (bare.startsWith("it ")) bare = bare.drop(3)
        if (bare == plain(verdict)) return null
        for (joint in listOf(":", " ·", " –", " —")) {
            if (said.lowercase().startsWith(verdict.lowercase() + joint)) {
                val rest = said.drop(verdict.length + joint.length).trim()
                return if (rest.isEmpty()) null else rest.replaceFirstChar { it.uppercase() }
            }
        }
        return said
    }

    /** What can be done with a task: a proposal approved or declined, work in hand stopped, work that ended unverified
     * resumed or given again, and verified work it kept shipped as a pull request (not a fix: that goes onto its own). */
    fun actions(task: TeamTask): List<String> = when (task.status) {
        "proposed" -> listOf("approve", "decline")
        "queued", "running" -> listOf("stop")
        "done" -> if (!task.verified) listOf("again") else if (task.changes != null && task.fix == null && task.shipped == null) listOf("ship") else emptyList()
        else -> listOf("resume", "again")
    }

    /** How you stepped in on it, the north star's count (null: you never did): core's interventionWords, in its order
     * ("an approval and two messages"; "its desktop taken over, a stop, 12 resumes, given again two times and
     * rewritten"). */
    fun stepped(task: TeamTask): String? {
        val number = listOf("", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine")
        fun count(n: Int) = number.getOrNull(n) ?: n.toString()
        val parts = listOf("approval", "message", "takeover", "stop", "resume", "again", "rewritten").mapNotNull { kind ->
            val n = task.interventions[kind] ?: 0
            if (n <= 0) return@mapNotNull null
            when (kind) {
                "approval" -> if (n == 1) "an approval" else "${count(n)} approvals"
                "message" -> if (n == 1) "a message" else "${count(n)} messages"
                "takeover" -> "its desktop taken over"
                "stop" -> if (n == 1) "a stop" else "${count(n)} stops"
                "resume" -> if (n == 1) "a resume" else "${count(n)} resumes"
                "again" -> if (n == 1) "given again" else "given again ${count(n)} times"
                else -> if (n == 1) "rewritten" else "rewritten ${count(n)} times"
            }
        }
        if (parts.isEmpty()) return null
        val words = if (parts.size == 1) parts[0] else "${parts.dropLast(1).joinToString(", ")} and ${parts.last()}"
        return "You stepped in: $words"
    }

    /** Where a try's lesson begins in a goal: replaced by the next try's, never piled up. */
    private const val LAST_TIME = "\n\nLast time ("

    private fun cut(text: String, max: Int): String = if (text.length > max) "${text.substring(0, max - 1)}…" else text

    /**
     * What a task given again is asked: what was asked before, and when it ran and wasn't verified, what came of it (why,
     * what the agent said of its work, and what the independent review said), so the next try starts from there.
     */
    fun againGoal(task: TeamTask): String {
        val asked = task.goal.split(LAST_TIME)[0]
        val ran = task.status == "failed" || (task.status == "done" && !task.verified)
        val end = if (ran) end(task) else null
        if (end?.why == null) return asked
        val review = task.output.split("\n\nReview:").getOrNull(1)?.split("\nWorkspace:")?.get(0)?.let(JsText::trim) ?: ""
        val lines = listOfNotNull(
            "$asked$LAST_TIME${task.id}), it ended without verified work: ${end.why}",
            end.said?.let { "What it said of its work: ${cut(it, 600)}" },
            // (A verdict alone, PASS or FAIL, says nothing more.)
            if (review.any(JsText::space)) "What the independent review said: ${cut(review, 1500)}" else null,
        )
        return lines.joinToString("\n").take(8000)
    }

    /** The same task, given again as a new one (POST /api/team/tasks): what was asked, of whom and where, and which it
     * gives again, with what came of it last time. One in sensitive mode is again, on the same models. */
    fun giveAgain(task: TeamTask): Json = Json.obj(
        "room" to task.room,
        "assignee" to task.assignee,
        "title" to JsText.trim(task.title),
        "goal" to againGoal(task),
        "gates" to task.gates,
        "dependsOn" to task.dependsOn,
        "models" to task.models.takeIf { it.isNotEmpty() },
        "again" to task.id,
    )
}
