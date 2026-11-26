package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.min

/**
 * How the primary's orb moves (your word, 24 November 2026: "pulsing/moving when doing a task, sitting idle, waiting,
 * done"), as the PWA moves it (lib/orb-motion.ts, through the parity vectors the Apple app is held to): the same moods,
 * the same clock a step at a time, and the same frame at the same moment, to a billionth.
 */
class OrbMotionTest {
    private val all: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())
    private val v: Json = all["orb"]!!["motion"]!!

    private fun mood(wire: String?): OrbMotion.Mood = OrbMotion.Mood.entries.first { it.wire == wire }
    private fun num(j: Json?): Double = j.double ?: error("not a number: $j")
    private fun close(what: String, theirs: Double, mine: Double) = assertTrue("$what: $theirs ≠ $mine", abs(theirs - mine) <= 1e-9)
    /** Two angles, the short way round: 359.9999999999 and 0 are the same place. */
    private fun closeAngle(what: String, theirs: Double, mine: Double) = assertTrue("$what: $theirs ≠ $mine", min(abs(theirs - mine), 360 - abs(theirs - mine)) <= 1e-9)

    @Test fun eachMoodMovesAsThePWAs() {
        assertEquals(v["moods"].fields.keys, OrbMotion.Mood.entries.map { it.wire }.toSet())
        for ((wire, theirs) in v["moods"].fields) {
            val mine = OrbMotion.motion(mood(wire))
            assertEquals(wire, num(theirs["breath"]), mine.breath, 0.0)
            assertEquals(wire, num(theirs["swell"]), mine.swell, 0.0)
            assertEquals(wire, listOf(num(theirs["turn"]["ring"]), num(theirs["turn"]["ticks"]), num(theirs["turn"]["segments"])), listOf(mine.turn.ring, mine.turn.ticks, mine.turn.segments))
            assertEquals(wire, theirs["comet"]?.takeIf { it !is Json.Null }?.let { OrbMotion.Comet(num(it["speed"]), num(it["tail"])) }, mine.comet)
            assertEquals(wire, theirs["ripple"].double, mine.ripple)
            assertEquals(wire, OrbMotion.Motes(theirs["motes"]["count"].int!!, num(theirs["motes"]["speed"]), num(theirs["motes"]["sway"]), OrbMotion.Flow.entries.first { it.wire == theirs["motes"]["flow"].string }), mine.motes)
            assertEquals(wire, num(theirs["aura"]), mine.aura, 0.0)
        }
        assertEquals(listOf(num(v["arrive"]), num(v["burst"]), num(v["burstMotes"]), num(v["ease"]), num(v["longestStep"])), listOf(OrbMotion.ARRIVE, OrbMotion.BURST, OrbMotion.BURST_MOTES.toDouble(), OrbMotion.EASE, OrbMotion.LONGEST_STEP))
    }

    @Test fun eachStateHasThePWAsMood() {
        for (s in v["states"].list) {
            val wire = s["state"].string
            assertEquals("$wire", s["mood"].string, OrbMotion.mood(wire).wire)
            AgentState.entries.firstOrNull { it.wire == wire }?.let { assertEquals("$wire", s["mood"].string, OrbMotion.mood(it).wire) }
        }
        assertEquals(OrbMotion.Mood.IDLE, OrbMotion.mood(null as AgentState?))
    }

    @Test fun whatAnAgentIsDoingIsItsOrbsMoodAsThePWAs() {
        val moods = all["faces"]["moods"].list
        assertEquals(11, moods.size)
        for (m in moods) assertEquals(m["expression"].string, m["mood"].string, OrbMotion.moodOfExpression(m["expression"].string).wire)
        assertEquals(OrbMotion.Mood.IDLE, OrbMotion.moodOfExpression(null))
        assertEquals(OrbMotion.Mood.IDLE, OrbMotion.moodOfExpression("constructor"))
    }

    @Test fun itBurstsWhereThePWAsDoes() {
        for (b in v["bursts"].list) {
            val from = b["from"].string?.let(::mood)
            assertEquals("${from?.wire} → ${b["to"].string}", b["bursts"].bool, OrbMotion.bursts(from, mood(b["to"].string)))
        }
    }

    @Test fun eachStageAndEachMoveIsThePWAs() {
        assertEquals(v["stages"].fields.keys, OrbMotion.stages.keys)
        for ((name, theirs) in v["stages"].fields) {
            val mine = OrbMotion.stages.getValue(name)
            assertEquals(
                name,
                listOf(theirs["reach"], theirs["band"][0], theirs["band"][1], theirs["mote"], theirs["share"], theirs["waves"][0], theirs["waves"][1], theirs["wave"]).map(::num),
                listOf(mine.reach, mine.bandFrom, mine.bandTo, mine.mote, mine.share, mine.wavesFrom, mine.wavesTo, mine.wave),
            )
            assertEquals(name, theirs["comet"]?.takeIf { it !is Json.Null }?.let { OrbMotion.StageComet(num(it["r"]), num(it["width"])) }, mine.comet)
        }
        for (level in Orb.Level.entries) assertEquals(OrbMotion.stages.getValue(level.wire), OrbMotion.stage(level))
        val moves = v["moves"]
        fun names(key: String) = moves[key].list.map { it.string }
        assertEquals(listOf(names("ring"), names("ticks"), names("segments"), names("swell"), names("glow")), listOf(OrbMotion.Moves.ring, OrbMotion.Moves.ticks, OrbMotion.Moves.segments, OrbMotion.Moves.swell, OrbMotion.Moves.glow))
        assertEquals(moves["lightsBefore"].string, OrbMotion.Moves.LIGHTS_BEFORE)
    }

    @Test fun itsRandomNumbersAreThePWAs() {
        for (s in v["seeds"].list) assertEquals(s["name"].string, s["seed"].long, OrbMotion.seed(s["name"].string!!))
        for (r in v["rands"].list) assertEquals("${r["seed"].long} ${r["i"].int} ${r["k"].int}", num(r["value"]), OrbMotion.rand(r["seed"].long!!, r["i"].int!!, r["k"].int!!), 0.0)
    }

    @Test fun eachClockIsThePWAsFirstSightAndStepByStep() {
        for (c in v["clocks"].list) clock("${c["mood"].string} ${c["seed"].long}", c["clock"], OrbMotion.clock(mood(c["mood"].string), c["seed"].long!!))
        var clock = OrbMotion.clock(OrbMotion.Mood.IDLE, 5)
        clock("start", v["start"], clock)
        for ((n, s) in v["steps"].list.withIndex()) {
            clock = OrbMotion.step(clock, mood(s["mood"].string), num(s["dt"]))
            clock("step $n (${s["mood"].string}, ${num(s["dt"])})", s["clock"], clock)
        }
    }

    @Test fun eachFrameIsThePWAsAtTheSameMoment() {
        assertTrue(v["frames"].list.size >= 20)
        for ((n, f) in v["frames"].list.withIndex()) {
            val what = "frame $n (${f["mood"].string} from ${f["from"].string}, t ${num(f["t"])}, since ${f["since"].double})"
            val from = f["from"].string?.let(::mood)
            val mood = mood(f["mood"].string)
            assertEquals(what, f["burst"].bool, OrbMotion.bursts(from, mood))
            val mine = OrbMotion.frame(mood, readClock(f["clock"]), num(f["t"]), f["seed"].long!!, f["since"].double, from, f["burst"].bool == true)
            val theirs = f["frame"]
            for ((name, value) in listOf("scale" to mine.scale, "glow" to mine.glow, "aura" to mine.aura)) close("$what $name", num(theirs[name]), value)
            for ((name, value) in listOf("ring" to mine.ring, "ticks" to mine.ticks, "segments" to mine.segments)) closeAngle("$what $name", num(theirs[name]), value)
            val comet = theirs["comet"]
            if (comet == null || comet is Json.Null) assertNull(what, mine.comet)
            else {
                closeAngle("$what head", num(comet["head"]), mine.comet!!.head)
                close("$what tail", num(comet["tail"]), mine.comet!!.tail)
                close("$what light", num(comet["alpha"]), mine.comet!!.alpha)
            }
            assertEquals("$what ripples", theirs["ripples"].list.size, mine.ripples.size)
            for ((i, gone) in theirs["ripples"].list.withIndex()) close("$what ripple $i", num(gone), mine.ripples[i])
            motes("$what motes", theirs["motes"], mine.motes)
            motes("$what leaving", theirs["leaving"], mine.leaving)
            motes("$what sparks", theirs["sparks"], mine.sparks)
        }
    }

    @Test fun stillIsTheOrbUnmoved() {
        assertEquals(OrbMotion.Frame(1.0, 1.0, 0.0, 0.0, 0.0, 0.0, null, emptyList(), emptyList(), emptyList(), emptyList()), OrbMotion.STILL)
        // A stage too small for motes shows none; a mood's share is rounded as the PWA rounds it (half up: 30 at 0.35 is 11).
        val frame = OrbMotion.frame(OrbMotion.Mood.DONE, OrbMotion.clock(OrbMotion.Mood.DONE), 3.0, since = 0.4, from = OrbMotion.Mood.WORKING, burst = true)
        assertEquals(emptyList<OrbMotion.Mote>(), OrbMotion.shownMotes(frame, OrbMotion.stage(Orb.Level.BADGE)))
        fun shown(mood: OrbMotion.Mood) = Math.round(OrbMotion.motion(mood).motes.count * 0.35).toInt()
        assertEquals(shown(OrbMotion.Mood.DONE) + shown(OrbMotion.Mood.WORKING) + OrbMotion.BURST_MOTES, OrbMotion.shownMotes(frame, OrbMotion.RING).size)
        assertEquals(11, OrbMotion.shownMotes(OrbMotion.STILL.copy(motes = List(30) { OrbMotion.Mote(0.0, 0.5, 1.0, 1.0) }), OrbMotion.RING).size)
    }

    @Test fun itIsDrawnAsFewTimesASecondAsLookSmooth() {
        val m = OrbMotion.Mood.entries.associateBy { it.wire }
        assertEquals(
            listOf(30, 15, 15, 30, 15),
            listOf(
                OrbMotion.fps(m.getValue("working"), "ring", null), OrbMotion.fps(m.getValue("idle"), "ring", null), OrbMotion.fps(m.getValue("waiting"), "seat", null),
                OrbMotion.fps(m.getValue("done"), "badge", 0.4), OrbMotion.fps(m.getValue("done"), "badge", OrbMotion.BURST),
            ),
        )
        // Its home's orb, twice as often.
        assertEquals(listOf(60, 30, 60), listOf(OrbMotion.fps(m.getValue("working"), "full", null), OrbMotion.fps(m.getValue("idle"), "full", null), OrbMotion.fps(m.getValue("failed"), "full", 1.0)))
    }

    private fun motes(what: String, theirs: Json?, mine: List<OrbMotion.Mote>) {
        assertEquals("$what count", theirs.list.size, mine.size)
        for ((i, m) in theirs.list.withIndex()) {
            closeAngle("$what $i angle", num(m["angle"]), mine[i].angle)
            close("$what $i u", num(m["u"]), mine[i].u)
            close("$what $i size", num(m["size"]), mine[i].size)
            close("$what $i alpha", num(m["alpha"]), mine[i].alpha)
        }
    }

    private fun readClock(j: Json?): OrbMotion.Clock = OrbMotion.Clock(
        num(j["ring"]), num(j["ticks"]), num(j["segments"]), num(j["head"]),
        num(j["ringSpeed"]), num(j["ticksSpeed"]), num(j["segmentsSpeed"]), num(j["headSpeed"]),
        num(j["tail"]), num(j["breath"]), num(j["swell"]), num(j["light"]), num(j["aura"]),
    )

    private fun clock(what: String, theirs: Json?, mine: OrbMotion.Clock) {
        for ((name, value) in listOf("ring" to mine.ring, "ticks" to mine.ticks, "segments" to mine.segments, "head" to mine.head)) closeAngle("$what $name", num(theirs[name]), value)
        for ((name, value) in listOf("ringSpeed" to mine.ringSpeed, "ticksSpeed" to mine.ticksSpeed, "segmentsSpeed" to mine.segmentsSpeed, "headSpeed" to mine.headSpeed, "tail" to mine.tail, "swell" to mine.swell, "light" to mine.light, "aura" to mine.aura)) close("$what $name", num(theirs[name]), value)
        // (A breath is a share of one, round again: 0.9999999999 and 0 are the same place in it.)
        val breath = abs(num(theirs["breath"]) - mine.breath)
        assertTrue("$what breath", min(breath, 1 - breath) <= 1e-9)
    }
}
