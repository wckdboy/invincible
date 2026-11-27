package sh.invincible.bot.core

/*
 * The agents as the PWA and the Apple app read it (apps/web/src/lib/roster.ts, now.ts, agent-state.ts and core's
 * avatar.ts, whose colours are Avatar's), so an agent's line, state and orb say the same thing on every screen: the primary
 * first, then each agent, then each room, every row with one line of latest activity and a mark when it needs you.
 * Pure, from what the app already asks the node (the team as one snapshot, the approvals waiting); the parity vectors
 * hold it byte for byte.
 */

data class Agent(
    val id: String,
    val name: String,
    val instructions: String,
    val role: String,
    val enabled: Boolean,
    val dailyTurns: Int,
    val turnsToday: Int,
    val createdBy: String?,
    val avatar: Json?,
    /** Its VM, once it has one (null: none yet). */
    val workspace: Json? = null,
    /** The repository it works in (an https address), which names its tasks' project (Work); null: other work. */
    val repository: String? = null,
) {
    companion object {
        fun of(j: Json) = Agent(
            j["id"].string ?: "", j["name"].string ?: "", j["instructions"].string ?: "", j["role"].string ?: "",
            j["enabled"].bool ?: true, j["dailyTurns"].int ?: 0, j["turnsToday"].int ?: 0, j["createdBy"].string, j["avatar"],
            j["workspace"]?.takeIf { it != Json.Null }, j["repository"].string,
        )
    }
}

/** A task or a delivery (a reply being written), as one: what the roster reads of either. */
data class Job(
    val task: Boolean,
    val id: String,
    val title: String,
    /** A task's assignee, or a delivery's agent. */
    val who: String,
    val status: String,
    val verified: Boolean,
    val updatedAt: Long,
    val progress: String?,
    val error: String?,
    val files: Int?,
    val proposedBy: String?,
    val room: String?,
    val dependsOn: List<String>,
    /** A task's record, for its verdict once it has ended (null: a delivery, or none yet). */
    val record: TeamTask.Record? = null,
) {
    companion object {
        fun task(j: Json) = Job(
            true, j["id"].string ?: "", j["title"].string ?: "", j["assignee"].string ?: "", j["status"].string ?: "", j["verified"].bool ?: false,
            j["updatedAt"].long ?: 0, j["progress"].string, j["error"].string, j["changes"]["files"].int, j["proposedBy"].string, j["room"].string,
            j["dependsOn"].list.mapNotNull { it.string }, (j["record"] as? Json.Obj)?.let(TeamTask.Record::of),
        )

        fun delivery(j: Json) = Job(
            false, j["id"].string ?: "", "", j["agent"].string ?: "", j["status"].string ?: "", false, j["updatedAt"].long ?: 0, null,
            j["error"].string, null, null, j["room"].string, emptyList(),
        )
    }
}

data class Room(val id: String, val name: String, val direct: Boolean, val members: List<String>, val updatedAt: Long, val paused: Boolean) {
    companion object {
        fun of(j: Json) = Room(j["id"].string ?: "", j["name"].string ?: "", j["direct"].bool ?: false, j["members"].list.mapNotNull { it.string }, j["updatedAt"].long ?: 0, j["paused"].bool ?: false)
    }
}

/** What the roster reads of GET /api/team. */
data class Snapshot(
    val agents: List<Agent>,
    val rooms: List<Room>,
    val tasks: List<Job>,
    val deliveries: List<Job>,
    val removed: List<Pair<String, String>>,
    /** When you last looked at each agent's page and room; null from a node that keeps no such thing. */
    val seen: Map<String, Long>?,
) {
    companion object {
        fun of(j: Json) = Snapshot(
            j["agents"].list.map(Agent::of),
            j["rooms"].list.map(Room::of),
            j["tasks"].list.map(Job::task),
            j["deliveries"].list.map(Job::delivery),
            j["removed"].list.map { (it["id"].string ?: "") to (it["name"].string ?: "") },
            (j["seen"] as? Json.Obj)?.fields?.mapValues { it.value.long ?: 0 },
        )
    }
}

/** An approval waiting for your answer: who asked, and for what. */
data class Ask(val by: String, val connector: String?, val tool: String?)

/** An agent's state in a word: the ring round its face and the chip beside its name. */
enum class AgentState(val words: String?, val tone: Tone) {
    WORKING("Working", Tone.WORK), NEEDS("Needs you", Tone.NEEDS), FAILED("Failed", Tone.FAILED), PAUSED("Paused", Tone.NEUTRAL),
    // (Verified work is new to you until you look, as the iPhone and the web say it: never "Verified" over a verdict that
    // may say it wasn't proven. Its line says the verdict.)
    QUEUED("Queued", Tone.NEUTRAL), VERIFIED("New", Tone.OK), UNREAD("New", Tone.OK), RESTING(null, Tone.NEUTRAL);

    enum class Tone { WORK, NEEDS, FAILED, OK, NEUTRAL }

    val wire: String get() = name.lowercase()
}

data class RosterRow(
    val kind: String,
    val id: String,
    val name: String,
    val room: String?,
    val line: String,
    val needs: Boolean,
    val unread: Boolean,
    val expression: String? = null,
    val state: AgentState? = null,
    val avatar: Json? = null,
)

object Roster {
    private val caller = Regex("^arm:team\\.[a-f0-9]{10}\\.([a-z][a-z0-9-]{0,31})$")

    /** The agent that filed an approval ("arm:team.<controller>.<handle>"), or null when someone else asked. */
    fun agentOfCaller(by: String): String? = caller.find(by)?.groupValues?.get(1)

    /** What waits for you that is no agent's: the Inbox's count, less the approvals that show on an agent's own row. */
    fun primaryNeeds(inbox: Int, asks: List<Ask>, agents: List<String>): Int = maxOf(0, inbox - asks.count { agents.contains(agentOfCaller(it.by) ?: "") })

    private fun firstLine(text: String?): String = (text ?: "").trim().split("\n").firstOrNull()?.trim() ?: ""
    private fun titled(job: Job) = "“${job.title}”"
    private val endedWords = mapOf("gave-up" to "gave up", "unverified" to "not verified")
    private fun withWhy(line: String, why: String?): String = firstLine(why).let { if (it.isNotEmpty()) "$line · ${endedWords[it] ?: it}" else line }
    private fun latestOf(jobs: List<Job>): Job? = jobs.fold(null as Job?) { latest, job -> if (latest == null || job.updatedAt > latest.updatedAt) job else latest }
    private fun endedSince(jobs: List<Job>, seen: Long?, keeps: Boolean): Job? {
        val ended = latestOf(jobs.filter { it.status == "done" || it.status == "failed" })
        return if (keeps && ended != null && ended.updatedAt > (seen ?: 0)) ended else null
    }
    private fun waitingIn(jobs: List<Job>) = jobs.count { it.status == "queued" }

    private fun trouble(job: Job?, who: String?): String? {
        if (job == null || (job.status != "failed" && job.status != "interrupted")) return null
        if (job.status == "interrupted") return "Interrupted: ${if (job.task) titled(job) else "${if (who != null) "$who's" else "a"} reply"} · review it before resuming"
        return if (job.task) withWhy("Failed: ${titled(job)}", job.error) else withWhy(if (who != null) "$who couldn't reply" else "Couldn't reply", job.error)
    }

    private fun named(s: Snapshot, id: String): String = if (id == "primary") "Your agent" else s.agents.firstOrNull { it.id == id }?.name ?: id
    private fun proposals(jobs: List<Job>) = jobs.filter { it.task && it.status == "proposed" }.sortedByDescending { it.updatedAt }
    private fun proposing(proposed: List<Job>, by: (String) -> String?): String {
        val latest = proposed.first()
        val who = latest.proposedBy?.let(by)
        return "${if (who != null) "$who proposes" else "Proposes"} ${titled(latest)}${if (proposed.size > 1) ", and ${proposed.size - 1} more" else ""}"
    }
    /** How a task ended: its verdict as its proof allows (Steps.verdict, from its record), as its card and its thread say
     * it, never "Verified" where its gates proved nothing (lib/roster.ts ended). */
    private fun ended(task: Job): String {
        if (task.status == "stopped") return "Stopped: ${titled(task)}"
        val kept = task.files?.let { " · $it file${if (it == 1) "" else "s"} kept" } ?: ""
        val word = Steps.verdict(task.status, task.verified, task.error, task.record, Steps.facts(task.record))?.word
            ?: when (task.status) { "proposed" -> "Waiting for you"; "queued" -> "Queued"; "running" -> "Running"; "interrupted" -> "Interrupted"; else -> "Done" }
        return "$word: ${titled(task)}$kept"
    }
    private fun maker(person: Agent, s: Snapshot): String? {
        val by = person.createdBy
        if (by == null || by == "owner") return null
        if (by == "primary") return "your agent"
        return s.agents.firstOrNull { it.id == by }?.name ?: s.removed.firstOrNull { it.first == by }?.second ?: by
    }

    /** What a step's line says an agent is doing (core's taskStep). */
    fun taskStep(progress: String): String {
        val line = progress.trimStart()
        if (line.startsWith("Plan · ") || line.startsWith("Thinking · ")) return "thinking"
        if (Regex("^Running · desktop(\\s|$)").containsMatchIn(line)) return "browsing"
        if (line.startsWith("Running · ")) return "working"
        if (Regex("^Exit -?\\d+ · ").containsMatchIn(line)) return "reading"
        if (Regex("^(Gate \\d+/\\d+ · |Gates · |Gates before the work · |Review · |Submitted for review · )").containsMatchIn(line) || Regex("^gate[sd]$").matches(line.trimEnd())) return "checking"
        return "working"
    }

    /** What an agent's face acts out: observable work, never a mood (core's avatarExpression). */
    fun expression(person: Agent, s: Snapshot, now: Long): String {
        val tasks = s.tasks.filter { it.who == person.id }
        val deliveries = s.deliveries.filter { it.who == person.id }
        tasks.firstOrNull { it.status == "running" }?.let { return taskStep(it.progress ?: "") }
        if (deliveries.any { it.status == "running" }) return "thinking"
        if (!person.enabled) return "resting"
        val work = tasks + deliveries
        if (tasks.any { it.status == "proposed" }) return "asking"
        if (work.any { it.status == "queued" }) return "waiting"
        val recent = { at: Long -> now >= at && now - at < 30_000 }
        if (work.any { (it.status == "failed" || it.status == "interrupted") && recent(it.updatedAt) }) return "concerned"
        if (tasks.any { it.status == "done" && it.verified && recent(it.updatedAt) }) return "pleased"
        return "idle"
    }

    private fun agentRow(person: Agent, s: Snapshot, asks: List<Ask>, now: Long): RosterRow {
        val room = s.rooms.firstOrNull { it.direct && it.members.size == 1 && it.members[0] == person.id }
        val jobs = s.tasks.filter { it.who == person.id } + s.deliveries.filter { it.who == person.id }
        val asked = asks.filter { agentOfCaller(it.by) == person.id }
        val proposed = proposals(jobs)
        val expression = if (asked.isNotEmpty() || proposed.isNotEmpty()) "asking" else expression(person, s, now)
        val fresh = endedSince(jobs.filter { it.task || it.room == room?.id }, s.seen?.get("agent:${person.id}"), s.seen != null)
        val rest = if (s.seen != null) {
            if (fresh != null) (if (fresh.task && fresh.verified) AgentState.VERIFIED else AgentState.UNREAD) else AgentState.RESTING
        } else if (expression == "pleased") AgentState.VERIFIED else AgentState.RESTING
        fun say(line: String, needs: Boolean = false, state: AgentState = rest) =
            RosterRow("agent", person.id, person.name, room?.id, line, needs, fresh != null, expression, state, person.avatar)

        asked.firstOrNull()?.let { return say("Asks for approval: ${it.connector}.${it.tool}${if (asked.size > 1) ", and ${asked.size - 1} more" else ""}", true, AgentState.NEEDS) }
        if (proposed.isNotEmpty()) return say(proposing(proposed) { if (it == person.id) null else named(s, it) }, true, AgentState.NEEDS)
        jobs.firstOrNull { it.status == "running" && it.task }?.let {
            return say(if (firstLine(it.progress).isNotEmpty()) "${it.title} · ${firstLine(it.progress)}" else "Working on ${titled(it)}", false, AgentState.WORKING)
        }
        if (jobs.any { it.status == "running" }) return say("Writing a reply", false, AgentState.WORKING)
        val latest = latestOf(jobs)
        trouble(latest, null)?.let { return say(it, true, if (latest!!.status == "interrupted") AgentState.NEEDS else AgentState.FAILED) }
        val waiting = waitingIn(jobs)
        val held = if (!person.enabled) "Paused" else if (person.turnsToday >= person.dailyTurns) "Daily allowance spent" else null
        if (held != null) return say(if (waiting > 0) "$held · $waiting waiting" else held, waiting > 0, if (!person.enabled) AgentState.PAUSED else if (waiting > 0) AgentState.NEEDS else AgentState.RESTING)
        jobs.firstOrNull { it.status == "queued" && it.task }?.let { queued ->
            val blocking = queued.dependsOn.map { id -> s.tasks.firstOrNull { it.id == id }.let { parent -> (parent?.title ?: id) to (parent?.status == "done" && parent.verified) } }.firstOrNull { !it.second }
            return say(if (blocking != null) "Waiting for “${blocking.first}”" else "Queued: ${titled(queued)}", false, AgentState.QUEUED)
        }
        if (waiting > 0) return say("Reply queued", false, AgentState.QUEUED)
        latestOf(jobs.filter { it.task })?.let { return say(ended(it)) }
        val job = firstLine(person.instructions).ifEmpty { person.role }
        return say(maker(person, s)?.let { "Made by $it · $job" } ?: job)
    }

    private fun roomRow(room: Room, s: Snapshot): RosterRow {
        val jobs = s.tasks.filter { it.room == room.id } + s.deliveries.filter { it.room == room.id }
        val fresh = endedSince(jobs, s.seen?.get("room:${room.id}"), s.seen != null)
        fun say(line: String, needs: Boolean = false) = RosterRow("room", room.id, room.name, room.id, line, needs, fresh != null)
        val proposed = proposals(jobs)
        if (proposed.isNotEmpty()) return say(proposing(proposed) { named(s, it) }, true)
        val working = jobs.filter { it.status == "running" && it.task }
        if (working.isNotEmpty()) return say("${if (working.size > 1) "${working.size} at work" else named(s, working[0].who)} · ${working[0].title}")
        val writing = jobs.filter { it.status == "running" && !it.task }
        if (writing.isNotEmpty()) return say("${writing.joinToString(", ") { named(s, it.who) }} ${if (writing.size > 1) "are" else "is"} writing")
        val latest = latestOf(jobs)
        trouble(latest, latest?.takeIf { !it.task }?.let { named(s, it.who) })?.let { return say(it, true) }
        val waiting = waitingIn(jobs)
        if (room.paused) return say(if (waiting > 0) "Paused · $waiting waiting" else "Paused", waiting > 0)
        return say(room.members.joinToString(", ") { named(s, it) })
    }

    /** Each agent, then each room (the newest first). */
    fun rows(s: Snapshot, asks: List<Ask>, now: Long): List<RosterRow> =
        s.agents.map { agentRow(it, s, asks, now) } + s.rooms.filter { !it.direct }.sortedByDescending { it.updatedAt }.map { roomRow(it, s) }

    /** A line as it reads beside its state's chip: the chip's words aren't said twice. */
    fun besideChip(line: String, state: AgentState?): String {
        val words = (state ?: AgentState.RESTING).words ?: return line
        if (line == words) return ""
        for (joint in listOf(": ", " · ")) if (line.startsWith("$words$joint")) return line.substring(words.length + joint.length)
        return line
    }

    /** Its line ([primaryNow]: the work first, then what needs you), and as every app shows it ([line]: lib/now.ts's
     * needsFirst, 26 November 2026: when something needs you, that first, then what it is doing; the line is amber then,
     * and a phone cuts its end, so "Working on: Make syn…" in amber said one thing in words and another in colour).
     * Otherwise [line] is [text], word for word; the same tone. */
    data class Now(val text: String, val expression: String, val tone: String, val line: String = text) {
        val state: AgentState get() = when {
            tone == "warn" -> AgentState.NEEDS
            tone == "accent" || expression == "thinking" || expression == "working" -> AgentState.WORKING
            tone == "ok" -> AgentState.UNREAD
            else -> AgentState.RESTING
        }
    }

    fun needsYou(n: Int) = "$n ${if (n == 1) "thing needs" else "things need"} you"

    /** What the primary is doing now, in one line (lib/now.ts): idle, working on something, or needing you. */
    fun primaryNow(step: String? = null, here: Boolean = false, turns: List<String?>, runs: List<String>, needs: Int?, unread: List<String?> = emptyList()): Now {
        val inHand = turns.size + runs.size
        val needsLine = needs?.takeIf { it > 0 }?.let(::needsYou)
        val doing = when {
            here -> step?.ifEmpty { null } ?: "Starting"
            inHand > 1 -> "Working on $inHand things"
            turns.isNotEmpty() -> turns[0]?.let { "Working in “$it”" } ?: "Working in a temporary chat"
            runs.isNotEmpty() -> "Working on: ${runs[0].trim().split("\n")[0]}"
            else -> null
        }
        val fresh = when {
            unread.size > 1 -> "${unread.size} new answers"
            unread.isNotEmpty() -> unread[0]?.let { "New answer in “$it”" } ?: "A new answer"
            else -> null
        }
        val text = if (doing != null) listOfNotNull(doing, needsLine).joinToString(" · ") else needsLine ?: fresh ?: if (needs == 0) "Idle · nothing needs you" else "Idle"
        val expression = if (here) "thinking" else if (doing != null) "working" else if (needsLine != null) "asking" else "idle"
        val tone = if (needsLine != null) "warn" else if (doing != null) "accent" else if (fresh != null) "ok" else "neutral"
        return Now(text, expression, tone, if (doing != null && needsLine != null) "$needsLine · $doing" else text)
    }
}
