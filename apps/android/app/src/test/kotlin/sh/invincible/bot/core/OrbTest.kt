package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The primary's orb, as the PWA draws it (lib/orb.ts, through the parity vectors the Apple app is held to): the same colours
 * and the same parts at every size, its data ring and its sphere of glyphs among them.
 */
class OrbTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["orb"]!!

    private fun hex(color: Long) = "#%06x".format(color)

    @Test fun eachStatesColoursAreThePWAs() {
        assertEquals(v["palettes"].fields.keys, Orb.Tone.entries.map { it.wire }.toSet())
        for (tone in Orb.Tone.entries) {
            val theirs = v["palettes"][tone.wire]
            val mine = Orb.palette(tone)
            assertEquals(tone.wire, listOf(theirs["tint"].string, theirs["light"].string, theirs["deep"].string), listOf(hex(mine.tint), hex(mine.light), hex(mine.deep)))
        }
    }

    @Test fun eachLevelIsDrawnFromThePWAsParts() {
        assertEquals(setOf("badge", "seat", "full"), v["levels"].fields.keys)
        for ((level, parts) in v["levels"].fields) {
            val size = when (level) { "badge" -> 28.0; "seat" -> 64.0; else -> 168.0 }
            assertEquals(level, parts.list.map(::part), Orb.parts(size))
        }
        // Every level has its sphere of glyphs round its nucleus, drawn last; all of it has its data ring too.
        for (size in listOf(28.0, 64.0, 168.0)) assertEquals(listOf("nucleus", "sphere"), Orb.parts(size).takeLast(2).map { it.name })
        assertEquals(listOf("data"), Orb.parts(168.0).filterIsInstance<Orb.Part.Glyphs>().map { it.name })
    }

    @Test fun eachSizeShowsAsMuchOfHimAsThePWAs() {
        for (s in v["sizes"].list) assertEquals("${s["size"].double}", s["level"].string, Orb.level(s["size"].double!!).wire)
    }

    @Test fun hisLinesToneIsHisOrbs() {
        assertEquals(listOf(Orb.Tone.NEUTRAL, Orb.Tone.ACCENT, Orb.Tone.WARN, Orb.Tone.OK, Orb.Tone.NEUTRAL), listOf("neutral", "accent", "warn", "ok", "pulse").map(Orb::tone))
        assertEquals(Orb.Tone.WARN, Orb.tone(AgentState.NEEDS))
        assertEquals(Orb.Tone.ACCENT, Orb.tone(AgentState.WORKING))
        assertEquals(Orb.Tone.OK, Orb.tone(AgentState.UNREAD))
        assertEquals(Orb.Tone.NEUTRAL, Orb.tone(AgentState.RESTING))
    }

    @Test fun whereHeStandsIsHisSeatsColourAsThePWAs() {
        for (s in v["states"].list) {
            val state = AgentState.entries.first { it.wire == s["state"].string }
            assertEquals(s["state"].string, s["tone"].string, Orb.tone(state).wire)
        }
    }

    /** A part as lib/orb.ts wrote it, as this app's own (what it doesn't carry is NaN, which no number of this app's is). */
    private fun part(j: Json): Orb.Part {
        fun n(key: String) = j[key].double ?: Double.NaN
        fun ink(value: Json?) = Orb.Ink.entries.first { it.name.lowercase() == value.string }
        val stops = j["stops"].list.map { Orb.Stop(it["at"].double ?: Double.NaN, ink(it["ink"]), it["opacity"].double ?: Double.NaN) }
        val name = j["name"].string ?: ""
        return when (j["kind"].string) {
            "disc" -> Orb.Part.Disc(name, n("r"), n("cx"), n("cy"), n("spread"), stops)
            "ring" -> Orb.Part.Ring(name, n("r"), n("width"), ink(j["ink"]), n("opacity"), (j["arcs"] as? Json.Arr)?.items?.map { Orb.Arc(it[0].double ?: Double.NaN, it[1].double ?: Double.NaN) })
            "ticks" -> Orb.Part.Ticks(name, n("r"), j["count"].int ?: -1, n("offset"), n("length"), n("width"), ink(j["ink"]), n("opacity"))
            "glyphs" -> Orb.Part.Glyphs(name, n("r"), j["count"].int ?: -1, n("size"), n("share"), ink(j["ink"]))
            "sphere" -> Orb.Part.Sphere(name, n("r"), j["count"].int ?: -1, n("glyph"), ink(j["second"]))
            else -> error("a part this app doesn't draw: ${j.text()}")
        }
    }
}
