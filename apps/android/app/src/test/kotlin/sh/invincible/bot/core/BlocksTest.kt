package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** Answer blocks read as core reads them (blocks.ts), held to the vectors: what is drawn, what is refused and why. */
class BlocksTest {
    private val v = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["blocks"]

    private fun <T> check(name: String, read: (String) -> Blocks.Read<T>, same: (T, Json) -> Unit) {
        for (c in v[name].list) {
            val want = c["read"]
            val got = read(c["text"].string!!)
            if (want["ok"].bool == true) {
                assertEquals(c["text"].string, Blocks.Read.Ok::class, got::class)
                @Suppress("UNCHECKED_CAST") same((got as Blocks.Read.Ok<T>).value, want["value"]!!)
            } else {
                assertEquals(c["text"].string, want["why"].string, (got as? Blocks.Read.No)?.why)
            }
        }
    }

    private fun num(j: Json?): Double? = (j as? Json.Num)?.value

    @Test fun charts() = check("charts", Blocks::chart) { got, want ->
        assertEquals(want["type"].string, got.type)
        assertEquals(want["title"].string, got.title)
        assertEquals(want["unit"].string, got.unit)
        assertEquals(want["labels"].list.map { it.string }, got.labels)
        assertEquals(want["series"].list.map { s -> s["name"].string to s["values"].list.map(::num) }, got.series)
    }

    @Test fun stats() = check("stats", Blocks::stats) { got, want ->
        assertEquals(want.list.size, got.size)
        for ((w, g) in want.list.zip(got)) {
            assertEquals(w["label"].string, g.label)
            assertEquals(num(w["value"]), g.number)
            assertEquals(w["value"].string, g.text)
            assertEquals(listOf(w["unit"].string, num(w["delta"]), w["note"].string, w["good"].string), listOf(g.unit, g.delta, g.note, g.good))
        }
    }

    @Test fun choices() = check("choices", Blocks::choices) { got, want -> assertEquals(want.list.map { it.string }, got) }

    @Test fun steps() = check("steps", Blocks::steps) { got, want -> assertEquals(want.list.map { it["text"].string to it["state"].string }, got.map { it.text to it.state }) }

    @Test fun pages() {
        for (c in v["artifacts"].list) {
            // (The vector of a page too long keeps its length, not its text: <p>, that many x, </p>, as vectors.ts made it.)
            val got = Blocks.artifact(c["text"].string ?: "<p>${"x".repeat(c["xs"].int!!)}</p>")
            if (c["ok"].bool == true) {
                assertEquals(c["title"].string, Blocks.artifactTitle((got as Blocks.Read.Ok).value))
            } else {
                assertEquals(c["why"].string, (got as Blocks.Read.No).why)
            }
        }
    }

    @Test fun figuresAsPeopleReadThem() {
        for (c in v["numbers"].list) assertEquals(c.text(), c["text"].string, Blocks.compactNumber(num(c["n"])!!))
    }
}
