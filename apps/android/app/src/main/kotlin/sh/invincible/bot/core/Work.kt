package sh.invincible.bot.core

import java.text.Collator
import java.util.Locale

/*
 * The work by attention (the PWA's lib/work.ts, 26 November 2026; your words: "project/tasks/coding t3code style for the
 * agents"): every task as a row of three lines (its project and how it stands, its title, its agent and what it is
 * doing or came to), in one of four sections by what it asks of you:
 *
 *   needs    only you can move it on: a proposal to approve, work cut short to look at, its agent asking for your approval
 *            while it works, work queued behind an agent you paused;
 *   active   a result new to you: it ended (failed, or done) after you last looked at its agent or its room, on any
 *            device, as an email is unread (a node that keeps no such mark: for half a day after it ended);
 *   working  at work, or queued;
 *   done     settled: ended and seen, or stopped.
 *
 * Pure (no Android), from what the app already asks the node: the team (GET /api/team), your projects (GET /api/projects)
 * and the approvals waiting. The phone's Home and a tablet's sidebar draw these rows. Held to the PWA's own words by the
 * vectors' `work` section.
 */

/** A task as the node keeps it (core's TeamTask): the fields the work, a task's thread and its proof read. */
data class TeamTask(
    val id: String,
    /** The conversation it was given in. */
    val room: String,
    val assignee: String,
    val title: String,
    /** The brief. (Never kept on the phone: KeptTable leaves it out.) */
    val goal: String,
    val dependsOn: List<String>,
    /** Its gates' commands, yours first. */
    val gates: List<String>,
    val status: String,
    val verified: Boolean,
    val progress: String,
    /** What the agent said of its work, and the runner's lines after it. */
    val output: String,
    val error: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val budgetUsd: Double? = null,
    val record: Record? = null,
    val changes: Changes? = null,
    val givenBy: String? = null,
    val proposedBy: String? = null,
    val shipped: Shipped? = null,
    val fix: Fix? = null,
    val from: From? = null,
    val outcome: String? = null,
    val models: List<String> = emptyList(),
    /** Each time you stepped in on it, by how. */
    val interventions: Map<String, Int> = emptyMap(),
) {
    /** What its run came to, once it ended in the agent's hands: when it began and ended, how, its model calls, and what
     * proves it (null: a record from before the runner kept that). */
    data class Record(val startedAt: Long, val endedAt: Long, val ended: String, val spent: List<UsageLine>, val proof: Proof? = null) {
        /** Each gate's exit before the work and after it (null: not run), the reviewer's verdict ("pass", "revise"; null:
         * none), and whether the reviewer was the model that did the work. */
        data class Proof(val before: List<Int?>, val after: List<Int?>, val review: String?, val sameModel: Boolean)
    }

    /** What it changed in its repository, where that was kept: how many files, and from which commit. */
    data class Changes(val files: Int, val base: String?)

    /** Its pull request, once you shipped its work (its number: null where the forge gave none). */
    data class Shipped(val url: String?, val pr: Int?)

    /** The pull request whose failing checks it fixes. */
    data class Fix(val branch: String, val pr: Int?)

    /** The step of another task it was started from. */
    data class From(val task: String?, val step: Int)

    companion object {
        fun of(j: Json): TeamTask {
            val updatedAt = j["updatedAt"].long ?: 0
            return TeamTask(
                id = j["id"].string ?: "",
                room = j["room"].string ?: "",
                assignee = j["assignee"].string ?: "",
                title = j["title"].string ?: "",
                goal = j["goal"].string ?: "",
                dependsOn = j["dependsOn"].list.mapNotNull { it.string },
                gates = j["gates"].list.mapNotNull { it.string },
                status = j["status"].string ?: "",
                verified = j["verified"].bool ?: false,
                progress = j["progress"].string ?: "",
                output = j["output"].string ?: "",
                error = j["error"].string,
                // (A task kept on this phone before it kept this has none: when it last moved stands in.)
                createdAt = j["createdAt"].long ?: updatedAt,
                updatedAt = updatedAt,
                budgetUsd = j["budgetUsd"].double,
                record = (j["record"] as? Json.Obj)?.let { r ->
                    Record(
                        r["startedAt"].long ?: 0, r["endedAt"].long ?: 0, r["ended"].string ?: "", r["spent"].list.map(UsageLine::of),
                        (r["proof"] as? Json.Obj)?.let { p ->
                            Record.Proof(p["before"].list.map { it.int }, p["after"].list.map { it.int }, p["review"].string, p["sameModel"].bool ?: false)
                        },
                    )
                },
                changes = (j["changes"] as? Json.Obj)?.let { c -> c["files"].int?.let { Changes(it, c["base"].string) } },
                givenBy = j["givenBy"].string,
                proposedBy = j["proposedBy"].string,
                shipped = (j["shipped"] as? Json.Obj)?.let { s -> Shipped(s["url"].string, s["pr"].int) },
                fix = (j["fix"] as? Json.Obj)?.let { f -> Fix(f["branch"].string ?: "", f["pr"].int) },
                from = (j["from"] as? Json.Obj)?.let { f -> From(f["task"].string, f["step"].int ?: 0) },
                outcome = j["outcome"].string,
                models = j["models"].list.mapNotNull { it.string },
                interventions = j["interventions"].fields.mapNotNull { (k, v) -> v.int?.let { k to it } }.toMap(),
            )
        }

        /** A team's tasks (GET /api/team's `tasks`). */
        fun all(team: Json?): List<TeamTask> = team["tasks"].list.map(::of)
    }
}

/** A project of yours (GET /api/projects): what a repository's work goes by. */
data class ProjectName(val name: String, val repo: String?)

object Work {
    enum class Attention { NEEDS, ACTIVE, WORKING, DONE; val wire: String get() = name.lowercase() }

    /** Its agent's repository, as the work names it: its key (its address without a scheme, or "other"), its name, and
     * the letter on its badge ("" for other work). */
    data class Project(val key: String, val name: String, val badge: String)

    val OTHER = Project("other", "Other work", "")

    /**
     * A task as a row of three lines: what it is, its project, its agent, its state and section; how it stands in a word
     * or two at the end of its first line in its state's colour ([word]: "Allow?", "Failed · gate 2", "Verified",
     * "Working · 4m", "Queued"; never colour alone); how long since it last moved ([age]: null at work, whose word says how
     * long it has been in hand); its third line after its agent's name ([detail]: what it is doing, or what it came to),
     * set in mono where it is a command or a path; and when it last moved, its order within a section.
     */
    data class Row(
        val id: String,
        val room: String,
        val title: String,
        val project: Project,
        val agent: String,
        val agentName: String,
        val avatar: Json?,
        val state: AgentState,
        val attention: Attention,
        val word: String,
        val tone: AgentState.Tone,
        val age: String?,
        val detail: String,
        val mono: Boolean,
        val at: Long,
        /** Once it has ended, its verdict in words that follow its proof (Steps.verdict, from its record): what its row
         * says in place of [word], so a row never says "Verified" where its gates proved nothing. Null while in hand. */
        val verdict: Steps.Said? = null,
    )

    /** The work in its four sections, each the latest first (at work before queued), and the projects with tasks, for the
     * filters: the busiest first. */
    data class Attended(
        val needs: List<Row>,
        val active: List<Row>,
        val working: List<Row>,
        val done: List<Row>,
        val projects: List<Counted>,
    ) {
        fun of(section: Attention): List<Row> = when (section) {
            Attention.NEEDS -> needs
            Attention.ACTIVE -> active
            Attention.WORKING -> working
            Attention.DONE -> done
        }

        val empty: Boolean get() = needs.isEmpty() && active.isEmpty() && working.isEmpty() && done.isEmpty()
    }

    data class Counted(val key: String, val name: String, val badge: String, val count: Int)

    private const val MINUTE = 60_000L

    /** How long a result stays new to you on a node that keeps no read marks. */
    const val NEW_FOR_MS = 12 * 60 * MINUTE

    /** A repository's address as one key, however it was written (case of its host, `.git`, a trailing slash); null for
     * anything that isn't an https address. As the PWA reads it with the URL standard, for the addresses an agent has. */
    fun projectKey(repo: String): String? {
        val text = JsText.trim(repo)
        val scheme = text.indexOf(':')
        if (scheme < 0 || !text.substring(0, scheme).equals("https", ignoreCase = true)) return null
        var rest = text.substring(scheme + 1)
        // (A special scheme's slashes, either way, as many as there are.)
        rest = rest.trimStart('/', '\\')
        val end = rest.indexOfFirst { it == '/' || it == '\\' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
        var authority = rest.substring(0, end)
        authority = authority.substringAfterLast('@')
        if (authority.isEmpty() || authority.any { it.isWhitespace() || it == '<' || it == '>' || it == '^' || it == '|' || it == '%' }) return null
        val host = authority.lowercase(Locale.ROOT).let { if (it.endsWith(":443")) it.dropLast(4) else if (it.endsWith(":")) it.dropLast(1) else it }
        val tail = rest.substring(end)
        val pathEnd = tail.indexOfFirst { it == '?' || it == '#' }.let { if (it < 0) tail.length else it }
        val path = normalPath(tail.substring(0, pathEnd).replace('\\', '/'))
        val trimmed = path.trimEnd('/').let { if (it.endsWith(".git")) it.dropLast(4) else it }
        return if (trimmed.length > 1) "$host$trimmed" else null
    }

    /** A path as the URL standard leaves it: its dot segments resolved, and what may not stand in it percent-encoded. */
    private fun normalPath(raw: String): String {
        if (raw.isEmpty()) return "/"
        val out = ArrayList<String>()
        val parts = raw.split('/').drop(1)
        parts.forEachIndexed { i, part ->
            val last = i == parts.lastIndex
            when (part.lowercase(Locale.ROOT)) {
                ".", "%2e" -> if (last) out += ""
                "..", ".%2e", "%2e.", "%2e%2e" -> {
                    if (out.isNotEmpty()) out.removeAt(out.lastIndex)
                    if (last) out += ""
                }
                else -> out += buildString {
                    for (c in part) if (c <= ' ' || c == '"' || c == '<' || c == '>' || c == '`' || c == '{' || c == '}' || c.code == 0x7f) append("%%%02X".format(c.code)) else append(c)
                }
            }
        }
        return "/" + out.joinToString("/")
    }

    /** A task's state, as its row shows it: at work; waiting on you (proposed, or cut short and yours to look at); queued;
     * failed; verified; stopped (paused); done without verification, at rest. */
    fun taskState(status: String, verified: Boolean): AgentState = when (status) {
        "running" -> AgentState.WORKING
        "proposed", "interrupted" -> AgentState.NEEDS
        "queued" -> AgentState.QUEUED
        "failed" -> AgentState.FAILED
        "stopped" -> AgentState.PAUSED
        "done" -> if (verified) AgentState.VERIFIED else AgentState.RESTING
        else -> AgentState.RESTING
    }

    private val ENDED = mapOf("gave-up" to "gave up", "unverified" to "not verified", "stopped" to "stopped")

    /** A span of time as a row says it, short: "now", "4m", "3h", "2d". */
    fun shortSpan(ms: Long): String {
        val minutes = maxOf(0L, ms) / MINUTE
        if (minutes < 1) return "now"
        if (minutes < 60) return "${minutes}m"
        val hours = minutes / 60
        if (hours < 24) return "${hours}h"
        return "${hours / 24}d"
    }

    private val letterOrDigit = Regex("[\\p{L}\\p{N}]")

    /** The letter on a project's badge: its name's first letter or digit, as a capital ("" for none). */
    fun projectBadge(name: String): String = letterOrDigit.find(name)?.value?.uppercase(Locale.getDefault()) ?: ""

    /** Each agent's project (by its repository, named by a project of yours with that repository), and other work's. */
    fun projectsOfAgents(agents: List<Agent>, projects: List<ProjectName>): (String) -> Project {
        val named = HashMap<String, String>()
        for (p in projects) {
            val key = p.repo?.let(::projectKey) ?: continue
            named[key] = p.name
        }
        val of = HashMap<String, Project>()
        for (agent in agents) {
            val key = agent.repository?.takeIf { it.isNotEmpty() }?.let(::projectKey)
            of[agent.id] = if (key == null) OTHER else {
                val name = named[key] ?: key.substringAfterLast('/')
                Project(key, name, projectBadge(name))
            }
        }
        return { agent -> of[agent] ?: OTHER }
    }

    /** What a task's latest line says it is doing, for its row: the command it runs (mono), else the step it is at. */
    data class Doing(val text: String, val mono: Boolean)

    private val gateMark = Regex("Gate (\\d+)/(\\d+)")

    fun doingNow(progress: String): Doing {
        val line = JsText.firstLine(progress)
        val parts = line.split(" · ")
        val mark = parts[0]
        val said = JsText.trim(parts.drop(1).joinToString(" · "))
        when (mark) {
            "Running" -> return Doing(said, true)
            "Plan" -> return Doing("planning", false)
            "Thinking" -> return Doing("thinking", false)
            "Submitted for review" -> return Doing("its gates run", false)
            "Review" -> return Doing("in review", false)
            "Exit" -> return Doing("reading what it printed", false)
        }
        gateMark.matchEntire(mark)?.let { return Doing("gate ${it.groupValues[1]} of ${it.groupValues[2]}", false) }
        return Doing(if (line.length > 80) "${line.substring(0, 79)}…" else line, false)
    }

    private val failedAt = Regex("^Gate (\\d+)/\\d+ · exit (-?\\d+)")

    /** The gate a failed task's latest line says it failed at (null: it doesn't say). */
    fun failedGate(progress: String): Int? {
        val gate = failedAt.find(JsText.firstLine(progress)) ?: return null
        return if (gate.groupValues[2] != "0") gate.groupValues[1].toIntOrNull() else null
    }

    /** The work by attention, from the team, your projects and the approvals waiting, at [now]. */
    fun attended(agents: List<Agent>, tasks: List<TeamTask>, seen: Map<String, Long>?, projects: List<ProjectName>, asks: List<Ask>, now: Long): Attended {
        val byHandle = agents.associateBy { it.id }
        val projectOf = projectsOfAgents(agents, projects)
        val titles = HashMap<String, String>().apply { for (t in tasks) put(t.id, t.title) }
        // What an agent asks your approval for, while its task runs (an agent works one thing at a time).
        val asking = HashMap<String, MutableList<Ask>>()
        for (ask in asks) Roster.agentOfCaller(ask.by)?.let { asking.getOrPut(it) { ArrayList() } += ask }
        fun seenAt(task: TeamTask): Long? = seen?.let { maxOf(it["agent:${task.assignee}"] ?: 0, it["room:${task.room}"] ?: 0) }
        val needs = ArrayList<Row>()
        val active = ArrayList<Row>()
        val working = ArrayList<Row>()
        val done = ArrayList<Row>()

        class Count(val project: Project, var count: Int = 0, var busy: Int = 0, var at: Long = 0)
        val counts = LinkedHashMap<String, Count>()
        for (task in tasks) {
            val agent = byHandle[task.assignee]
            val name = agent?.name ?: task.assignee
            val project = projectOf(task.assignee)
            val row = rowOf(task, name, agent?.enabled == false, if (task.status == "running") asking[task.assignee] ?: emptyList() else emptyList(), seenAt(task), now, titles)
                .copy(
                    id = task.id, room = task.room, title = task.title, project = project, agent = task.assignee, agentName = name, avatar = agent?.avatar, at = task.updatedAt,
                    verdict = Steps.verdict(task.status, task.verified, task.error, task.record, Steps.facts(task.record)),
                )
            when (row.attention) {
                Attention.NEEDS -> needs += row
                Attention.ACTIVE -> active += row
                Attention.WORKING -> working += row
                Attention.DONE -> done += row
            }
            val counted = counts.getOrPut(project.key) { Count(project) }
            counted.count++
            counted.busy = maxOf(counted.busy, when (row.attention) { Attention.NEEDS -> 3; Attention.ACTIVE -> 2; Attention.WORKING -> 1; Attention.DONE -> 0 })
            counted.at = maxOf(counted.at, task.updatedAt)
        }
        val newest = Comparator<Row> { a, b -> b.at.compareTo(a.at).takeIf { it != 0 } ?: if (a.id < b.id) -1 else 1 }
        val collator = Collator.getInstance()
        // Other work last; then the busiest (what needs you, then what is new, then work in hand), the latest, by name.
        val projectsShown = counts.values.sortedWith { a, b ->
            val other = (if (a.project.key == "other") 1 else 0) - (if (b.project.key == "other") 1 else 0)
            when {
                other != 0 -> other
                a.busy != b.busy -> b.busy - a.busy
                a.at != b.at -> b.at.compareTo(a.at)
                else -> collator.compare(a.project.name, b.project.name)
            }
        }
        return Attended(
            needs.sortedWith(newest),
            active.sortedWith(newest),
            done = done.sortedWith(newest),
            // At work before queued, and each the latest first.
            working = working.sortedWith { a, b -> ((if (b.state == AgentState.WORKING) 1 else 0) - (if (a.state == AgentState.WORKING) 1 else 0)).takeIf { it != 0 } ?: newest.compare(a, b) },
            projects = projectsShown.map { Counted(it.project.key, it.project.name, it.project.badge, it.count) },
        )
    }

    /** The rows of one project alone (a filter), its sections as they were; every project's with none. */
    fun inProject(work: Attended, key: String?): Attended {
        if (key == null) return work
        fun only(rows: List<Row>) = rows.filter { it.project.key == key }
        return Attended(only(work.needs), only(work.active), only(work.working), only(work.done), work.projects)
    }

    /** Every row, in the order of attention: what needs you, what is new to you, what is at work, then what is settled. */
    fun byAttention(work: Attended): List<Row> = work.needs + work.active + work.working + work.done

    private fun rowOf(task: TeamTask, name: String, paused: Boolean, asks: List<Ask>, seen: Long?, now: Long, titles: Map<String, String>): Row {
        val age = shortSpan(now - task.updatedAt)
        fun say(state: AgentState, attention: Attention, word: String, detail: String = "", mono: Boolean = false, shownAge: String? = age) =
            Row("", "", "", OTHER, "", "", null, state, attention, word, state.tone, shownAge, detail, mono, 0)
        when (task.status) {
            "proposed" -> {
                val by = if (!task.proposedBy.isNullOrEmpty() && task.proposedBy != task.assignee) "proposed for $name" else "proposed by its agent"
                return say(AgentState.NEEDS, Attention.NEEDS, "Approve?", if (!task.proposedBy.isNullOrEmpty()) by else "waits for your approval")
            }
            "interrupted" -> return say(AgentState.NEEDS, Attention.NEEDS, "Interrupted", "look at it before it resumes")
            "running" -> {
                val ask = asks.firstOrNull()
                val doing = doingNow(task.progress)
                if (ask != null) {
                    return say(AgentState.NEEDS, Attention.NEEDS, "Allow?", if (!ask.connector.isNullOrEmpty() && !ask.tool.isNullOrEmpty()) "${ask.connector}.${ask.tool}" else "asks for your approval", !ask.connector.isNullOrEmpty(), age)
                }
                val span = shortSpan(now - task.createdAt)
                return say(AgentState.WORKING, Attention.WORKING, if (span == "now") "Working" else "Working · $span", doing.text, doing.mono, null)
            }
            "queued" -> {
                if (paused) return say(AgentState.NEEDS, Attention.NEEDS, "Agent paused", "resume $name to start it")
                val waiting = task.dependsOn.firstNotNullOfOrNull { titles[it] }
                return say(AgentState.QUEUED, Attention.WORKING, "Queued", if (!waiting.isNullOrEmpty()) "after “$waiting”" else "")
            }
            "stopped" -> return say(AgentState.PAUSED, Attention.DONE, "Stopped")
        }
        // Ended: done (verified), or failed (which a task that wasn't verified is). New to you until you look.
        val unread = if (seen == null) now - task.updatedAt < NEW_FOR_MS else task.updatedAt > seen
        val attention = if (unread) Attention.ACTIVE else Attention.DONE
        if (task.status == "done") {
            val shipped = task.shipped
            val changes = task.changes
            val detail = if (shipped != null) (if (shipped.pr != null && shipped.pr != 0) "PR #${shipped.pr}" else "shipped") else if (changes != null) "${changes.files} file${if (changes.files == 1) "" else "s"} kept" else ""
            return if (task.verified) say(AgentState.VERIFIED, attention, "Verified", detail) else say(AgentState.RESTING, attention, "Not verified", detail)
        }
        val why = JsText.firstLine(task.error)
        val gate = failedGate(task.progress)
        return say(AgentState.FAILED, attention, if (gate != null && gate != 0) "Failed · gate $gate" else "Failed", ENDED[why] ?: if (why.length > 60) "${why.substring(0, 59)}…" else why)
    }

    /** What waits in the Inbox beyond the task rows that ask for it: its count, less the approvals a needs row stands for
     * (its agent asking for your approval as its task runs). */
    /**
     * What needs you, decisions only, counted one way for every place that says how many (Home's line and its Needs you,
     * the Inbox's badge, the primary's line among the agents, the sidebar, the kept agents): every approval waiting once,
     * each task only you can move on (an agent asking for your approval is that approval's), devices asking to join, keys
     * asked for, a service's question while it can be answered ([questionsUntil]: when each stops), and asks to use a
     * machine. What the node noticed (a notice, a fact about you) is news, not a decision: shown in the Inbox, counted
     * nowhere. (The iPhone's Session.needsCount.)
     */
    fun needsCount(approvals: Int, needs: List<Row>, pairings: Int, keys: Int, questionsUntil: List<Long?>, screens: Int, now: Long): Int =
        approvals + needs.count { it.word != "Allow?" } + pairings + keys + questionsUntil.count { (it ?: Long.MAX_VALUE) > now } + screens

    fun inboxBeyond(inbox: Int, asks: List<Ask>, needs: List<Row>): Int {
        val asking = needs.filter { it.word == "Allow?" }.map { it.agent }.toSet()
        return maxOf(0, inbox - asks.count { asking.contains(Roster.agentOfCaller(it.by) ?: "") })
    }

    /**
     * What opening a task marks as read, on every device (POST /api/team/seen): its agent's page, when the task has ended
     * and is the latest of that agent's results still new to you. Null: nothing to mark (still in hand, already read, or
     * a node that keeps no marks). Returns the agent's handle.
     */
    fun seenOnOpen(id: String, tasks: List<TeamTask>, seen: Map<String, Long>?): String? {
        val task = tasks.firstOrNull { it.id == id } ?: return null
        if (seen == null || !(task.status == "done" || task.status == "failed")) return null
        fun seenAt(one: TeamTask) = maxOf(seen["agent:${one.assignee}"] ?: 0, seen["room:${one.room}"] ?: 0)
        val unread = tasks.filter { it.assignee == task.assignee && (it.status == "done" || it.status == "failed") && it.updatedAt > seenAt(it) }
        val newest = unread.fold(null as TeamTask?) { latest, one -> if (latest == null || one.updatedAt > latest.updatedAt) one else latest }
        return if (newest?.id == task.id) task.assignee else null
    }

    /** Home's line under the primary's name: how much needs you, first (the line is amber then, and its first words agree with
     * its colour), and how many are at work; else its own line. */
    data class Glance(val text: String, val needs: Boolean)

    fun atAGlance(working: List<Row>, needs: Int, its: String): Glance {
        val atWork = working.count { it.state == AgentState.WORKING }
        val parts = listOfNotNull(if (needs > 0) "$needs need${if (needs == 1) "s" else ""} you" else null, if (atWork > 0) "$atWork at work" else null)
        return if (parts.isNotEmpty()) Glance(parts.joinToString(" · "), needs > 0) else Glance(its, false)
    }

    /** What an agent's tasks that ended since [since] cost at your prices, as their runner recorded them: its sum, and
     * whether it is the whole of it. Null: none of its tasks ended in that time with a model call counted. */
    data class Spent(val usd: Double, val complete: Boolean)

    fun spentSince(tasks: List<TeamTask>, agent: String, since: Long, prices: Map<String, Price>): Spent? {
        val lines = tasks.filter { it.assignee == agent && it.record != null && it.record.endedAt >= since }.flatMap { it.record!!.spent }
        if (lines.none { it.calls > it.unknown }) return null
        val cost = Spend.costOf(lines, prices)
        return Spent(cost.usd, cost.complete && cost.unpriced.isEmpty())
    }
}

/** Strings as JavaScript reads them, where the PWA's words depend on it. */
object JsText {
    /** JavaScript's String.prototype.trim: its white space and line terminators, from both ends. */
    fun trim(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && space(text[start])) start++
        while (end > start && space(text[end - 1])) end--
        return text.substring(start, end)
    }

    fun space(c: Char): Boolean = c == ' ' || c in '\t'..'\r' || c == ' ' || c == ' ' || c in ' '..' ' ||
        c == ' ' || c == ' ' || c == ' ' || c == ' ' || c == '　' || c == '﻿'

    /** A text's first line, trimmed (the PWA's firstLine: the whole trimmed first, then its first line trimmed). */
    fun firstLine(text: String?): String = trim(trim(text ?: "").split("\n")[0])
}
