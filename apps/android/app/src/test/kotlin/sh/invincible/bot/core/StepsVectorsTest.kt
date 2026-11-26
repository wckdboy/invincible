package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A task's work folded as T3 Code folds it, and what proves it (the PWA's lib/steps.ts), against the vectors' `steps`
 * section: what each command was, the groups, the summary and "Worked for", each gate as its latest round left it, the
 * reviewer, the live line, the proof and the cost line. Everything exactly.
 */
class StepsVectorsTest {
    private val s = Fixture.vectors["steps"]!!
    private val now = Fixture.vectors["work"]["now"].long!!

    private fun trail(j: Json?): List<TrailEntry> = j.list.map(TrailEntry::of)
    private val trails = s["trails"].fields.mapValues { trail(it.value) }
    private fun trailNamed(name: String?): List<TrailEntry> = when (name) {
        "none" -> emptyList()
        "one" -> trails.getValue("full").take(1)
        else -> trails.getValue(name!!)
    }

    private fun group(g: Steps.Group): Json = Json.Obj(
        linkedMapOf(
            "kind" to Json.of(g.kind.wire), "text" to Json.of(g.text),
            "items" to Json.Arr(g.items.map { Json.Obj(linkedMapOf("text" to Json.of(it.text), "exit" to Json.of(it.exit))) }),
            "tone" to Json.of(g.tone.wire), "from" to Json.of(g.from), "to" to Json.of(g.to), "at" to Json.of(g.at),
        ),
    )

    private fun gateRow(r: Steps.GateRow): Json = Json.Obj(
        linkedMapOf(
            "command" to Json.of(r.command), "state" to Json.of(r.state.wire), "exit" to Json.of(r.exit), "ms" to Json.of(r.ms),
            "said" to Json.of(r.said), "before" to Json.of(r.before),
        ),
    )

    private fun review(r: Steps.Review?): Json = r?.let { Json.obj("verdict" to it.verdict, "notes" to it.notes, "at" to it.at) } ?: Json.Null

    private fun record(j: Json?): TeamTask.Record? = (j as? Json.Obj)?.let { r ->
        TeamTask.Record(r["startedAt"].long!!, r["endedAt"].long!!, r["ended"].string ?: "", r["spent"].list.map(UsageLine::of))
    }

    @Test fun whatEachCommandWas() {
        for (c in s["commands"].list) {
            val got = Steps.commandKind(c["command"].string!!)
            assertEquals(c["command"].string, c["kind"].string, got.kind.wire)
            assertEquals(c["command"].string, c["path"].string, got.path)
        }
    }

    @Test fun theWorkFolded() {
        for ((name, want) in s["groups"].fields) {
            assertEquals(name, want.canonical(), Json.Arr(Steps.groups(trailNamed(name)).map(::group)).canonical())
        }
    }

    @Test fun whatItCameTo() {
        for (c in s["summaries"].list) {
            val got = Steps.summary(trailNamed(c["trail"].string), c["record"].takeIf { it is Json.Obj }?.let { TeamTask.Record(it["startedAt"].long!!, it["endedAt"].long!!, "", emptyList()) })
            val want = c["summary"]
            val at = "${c["trail"].string} ${c["record"]?.text()}"
            assertEquals(at, listOf(want["ms"].long, want["commands"].long, want["failed"].long, want["read"].long, want["edited"].long), listOf(got.ms, got.commands.toLong(), got.failed.toLong(), got.read.toLong(), got.edited.toLong()))
        }
        for (c in s["workedFor"].list) assertEquals("${c["ms"].long}", c["words"].string, Steps.workedFor(c["ms"].long!!))
        for (c in s["summaryWords"].list) {
            val m = c["summary"]
            val summary = Steps.Summary(m["ms"].long!!, m["commands"].int!!, m["failed"].int!!, m["read"].int!!, m["edited"].int!!)
            assertEquals(c["words"].string, Steps.summaryWords(summary))
        }
    }

    @Test fun eachGateTheReviewerAndTheLiveLine() {
        for (g in s["gates"].list) {
            val got = Steps.gateRows(g["gates"].list.map { it.string!! }, trailNamed(g["trail"].string), g["running"].bool!!)
            assertEquals("${g["trail"].string} running ${g["running"].bool}", g["rows"]!!.canonical(), Json.Arr(got.map(::gateRow)).canonical())
        }
        for ((name, want) in s["reviews"].fields) assertEquals(name, want.canonical(), review(Steps.reviewOf(trailNamed(name))).canonical())
        for ((name, want) in s["sameModel"].fields) assertEquals(name, want.bool, Steps.sameModelReview(trailNamed(name)))
        for (l in s["live"].list) {
            val text = l["text"].string
            // (Each a trail of its one line, three minutes before the vectors' now.)
            val got = Steps.liveStep(if (text == null) emptyList() else listOf(TrailEntry(1, now - 3 * 60_000, text)))
            val want = l["live"]
            if (want == null || want == Json.Null) assertEquals(text, null, got)
            else assertEquals(text, want.canonical(), Json.obj("text" to got!!.text, "command" to got.command, "since" to got.since).canonical())
        }
    }

    @Test fun whatProvesATask() {
        for (p in s["proofs"].list) {
            val entries = p["entries"]?.let(::trail) ?: trailNamed(p["trail"].string)
            val task = p["task"]
            val got = Steps.proofOf(task["status"].string!!, task["gates"].list.map { it.string!! }, entries)
            val shown = Json.Obj(
                linkedMapOf(
                    "gates" to Json.Arr(got.gates.map(::gateRow)), "passed" to Json.of(got.passed), "review" to review(got.review),
                    "reviewer" to Json.of(got.reviewer), "sameModel" to Json.of(got.sameModel), "provesNothing" to Json.of(got.provesNothing),
                ),
            )
            assertEquals("${p["trail"].string} ${task?.text()}", p["proof"]!!.canonical(), shown.canonical())
        }
    }

    @Test fun whatATaskCost() {
        val prices = s["prices"].fields.mapValues { Price.of(it.value)!! }
        for (c in s["costs"].list) {
            assertEquals(c.text(), c["words"].string, Steps.costWords(c["budgetUsd"].double, record(c["record"]), prices))
        }
    }

    @Test fun aTrailIsReadPageByPage() {
        val full = trails.getValue("full")
        val first = Steps.take(Steps.Trail(), full.take(10))
        assertEquals(10L, first.after)
        // A page that comes twice, or late, adds nothing.
        assertEquals(first, Steps.take(first, full.take(10)))
        val all = Steps.take(first, full.drop(5))
        assertEquals(full, all.entries)
        assertEquals(Steps.Next.NOW, Steps.next("done", more = true, took = true))
        assertEquals(Steps.Next.WAIT, Steps.next("running", more = true, took = false))
        assertEquals(Steps.Next.WAIT, Steps.next("queued", more = false, took = false))
        assertEquals(Steps.Next.DONE, Steps.next("failed", more = false, took = true))
    }
}
