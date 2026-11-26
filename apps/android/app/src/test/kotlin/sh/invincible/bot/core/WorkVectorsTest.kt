package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The work by attention (the PWA's lib/work.ts) against the vectors' `work` section: every task a row of three lines in
 * one of four sections, the projects' keys and badges, read marks, the at-a-glance line, and what opening a task marks.
 * Words exactly; money to a billionth.
 */
class WorkVectorsTest {
    private val w = Fixture.vectors["work"]!!
    private val now = w["now"].long!!
    private val snapshot = w["snapshot"]!!
    private val agents = snapshot["agents"].list.map(Agent::of)
    private val tasks = TeamTask.all(snapshot)
    private val seen = (snapshot["seen"] as? Json.Obj)?.fields?.mapValues { it.value.long!! }
    private val projects = w["projects"].list.map { ProjectName(it["name"].string!!, it["repo"].string) }
    private val asks = w["asks"].list.map { Ask(it["by"].string!!, it["connector"].string, it["tool"].string) }

    private fun shown(work: Work.Attended): Json = Json.obj(
        "needs" to work.needs.map(::row),
        "active" to work.active.map(::row),
        "working" to work.working.map(::row),
        "done" to work.done.map(::row),
        "projects" to work.projects.map { Json.obj("key" to it.key, "name" to it.name, "badge" to it.badge, "count" to it.count) },
    )

    private fun row(r: Work.Row): Json = Json.Obj(
        linkedMapOf(
            "id" to Json.of(r.id), "room" to Json.of(r.room), "title" to Json.of(r.title),
            "project" to Json.obj("key" to r.project.key, "name" to r.project.name, "badge" to r.project.badge),
            "agent" to Json.obj("id" to r.agent, "name" to r.agentName),
            "state" to Json.of(r.state.wire), "attention" to Json.of(r.attention.wire), "word" to Json.of(r.word), "tone" to Json.of(r.tone.name.lowercase()),
            "age" to Json.of(r.age), "detail" to Json.of(r.detail), "mono" to Json.of(r.mono), "at" to Json.of(r.at),
        ),
    )

    private val read = Work.attended(agents, tasks, seen, projects, asks, now)

    @Test fun everyTaskIsARowInItsSectionAsThePwaDrawsIt() {
        // (Compared as canonical JSON: the same rows in the same order, each field exactly.)
        assertEquals(w["attended"]!!.canonical(), shown(read).canonical())
    }

    @Test fun aNodeThatKeepsNoMarksShowsResultsNewForHalfADay() {
        assertEquals(w["newForMs"].long, Work.NEW_FOR_MS)
        assertEquals(w["unmarked"]!!.canonical(), shown(Work.attended(agents, tasks, null, projects, asks, now)).canonical())
    }

    @Test fun byAttentionAndByProject() {
        assertEquals(w["order"].list.map { it.string }, Work.byAttention(read).map { it.id })
        for (o in w["only"].list) {
            val key = o["key"].string
            assertEquals(key, o["ids"].list.map { it.string }, Work.byAttention(Work.inProject(read, key)).map { it.id })
        }
    }

    @Test fun spansBadgesAndKeys() {
        for (s in w["spans"].list) assertEquals("${s["ms"].long}", s["span"].string, Work.shortSpan(s["ms"].long!!))
        for (b in w["badges"].list) assertEquals(b["name"].string, b["badge"].string, Work.projectBadge(b["name"].string!!))
        for (k in w["keys"].list) assertEquals(k["repo"].string, k["key"].string, Work.projectKey(k["repo"].string!!))
    }

    @Test fun whatATaskIsDoingAndWhereItFailed() {
        for (d in w["doing"].list) {
            val got = Work.doingNow(d["progress"].string!!)
            assertEquals(d["progress"].string, d["text"].string, got.text)
            assertEquals(d["progress"].string, d["mono"].bool, got.mono)
        }
        for (g in w["failedGates"].list) assertEquals(g["progress"].string, g["gate"].int, Work.failedGate(g["progress"].string!!))
    }

    @Test fun theGlanceTheInboxBeyondAndWhatOpeningMarks() {
        val none = Work.attended(agents, emptyList(), seen, projects, emptyList(), now)
        for (g in w["glances"].list) {
            val got = Work.atAGlance((if (g["working"].bool == true) read else none).working, g["count"].int!!, g["its"].string!!)
            assertEquals(g["text"].string, got.text)
            assertEquals(g["needs"].bool, got.needs)
        }
        for (b in w["beyond"].list) assertEquals(b["beyond"].int, Work.inboxBeyond(b["inbox"].int!!, asks, read.needs))
        for (o in w["opened"].list) {
            val marks = o["marks"]
            assertEquals(o["id"].string, if (marks == null || marks == Json.Null) null else marks["agent"].string, Work.seenOnOpen(o["id"].string!!, tasks, seen))
        }
    }

    /** (The tasks these are of are made in apps/apple/scripts/vectors.ts and not written to the vectors: the same here.) */
    @Test fun whatAnAgentsEndedTasksCost() {
        val prices = w["prices"].fields.mapValues { Price.of(it.value)!! }
        fun at(minutesAgo: Int) = now - minutesAgo * 60_000L
        fun usage(model: String, calls: Int, input: Int, output: Int, cached: Int = 0, unknown: Int = 0) =
            UsageLine("engineer", model, calls.toDouble(), unknown.toDouble(), input.toDouble(), output.toDouble(), cached.toDouble(), 0.0)
        fun task(assignee: String, record: TeamTask.Record?) = TeamTask("", "", assignee, "", "", emptyList(), emptyList(), "done", false, "", "", null, 0, 0, record = record)
        fun record(started: Int, ended: Int, spent: List<UsageLine>) = TeamTask.Record(at(started), at(ended), "done", spent)
        val ended = listOf(
            task("ada", record(300, 200, listOf(usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000, cached = 40_000)))),
            task("ada", record(60, 30, listOf(usage("mistral/mistral-large", 2, 30_000, 2_000)))),
            task("bea", record(60, 30, listOf(usage("unknown/model", 3, 10_000, 1_000)))),
            task("cy", record(60, 30, listOf(usage("deepseek/deepseek-v4-pro", 2, 0, 0, unknown = 2)))),
            task("dee", record(60, 30, listOf(usage("deepseek/deepseek-v4-pro", 3, 9_000, 900, unknown = 1)))),
            task("eli", null),
        )
        for (s in w["spent"].list) {
            val got = Work.spentSince(ended, s["agent"].string!!, s["since"].long!!, prices)
            val want = s["spent"]
            val at = "${s["agent"].string} since ${s["since"].long}"
            if (want == null || want == Json.Null) assertEquals(at, null, got)
            else {
                Fixture.near(want["usd"].double, got!!.usd, "$at usd")
                assertEquals(at, want["complete"].bool, got.complete)
            }
        }
    }
}
