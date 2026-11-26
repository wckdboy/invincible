package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** JSON as core writes it (canonical.ts): what the node checks a signature against must come out byte for byte. */
class JsonTest {
    @Test fun keysAreSortedByUtf16CodeUnitsAndNothingElseMoves() {
        val v = Json.parse("""{"b":1,"a":[3,{"z":null,"y":true}],"B":"x","é":0,"😀":0,"ﬁ":0}""")
        // "B" (0x42) before "a"; "é" (0xE9) before "😀" (a surrogate pair, 0xD83D…) before "ﬁ" (0xFB01): JavaScript's
        // order, by code unit, not by code point (core's canonical() wrote this very string).
        assertEquals("""{"B":"x","a":[3,{"y":true,"z":null}],"b":1,"é":0,"😀":0,"ﬁ":0}""", v.canonical())
        assertEquals("""{"b":1,"a":[3,{"z":null,"y":true}],"B":"x","é":0,"😀":0,"ﬁ":0}""", v.text())
    }

    @Test fun numbersAreWrittenAsJavaScriptWritesThem() {
        val cases = mapOf(
            0.0 to "0", -0.0 to "0", 1.0 to "1", -42.0 to "-42", 0.1 to "0.1", 123.456 to "123.456", 1.5e-7 to "1.5e-7",
            1e-7 to "1e-7", 0.000001 to "0.000001", 1e20 to "100000000000000000000", 1e21 to "1e+21", 1.7976931348623157e308 to "1.7976931348623157e+308",
            9007199254740993.0 to "9007199254740992", 2.5e-5 to "0.000025", 1794000000000.0 to "1794000000000",
        )
        for ((x, js) in cases) assertEquals("$x", js, jsNumber(x))
    }

    @Test fun stringsAreEscapedAsJsonStringifyEscapesThem() {
        val out = StringBuilder()
        jsString("a\"b\\c\n\t\u0001\u001f/é😀\b\u000C\r", out)
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001\\u001f/é😀\\b\\f\\r\"", out.toString())
        // A lone surrogate is written as its escape.
        val lone = StringBuilder()
        jsString("x\uD83Dy", lone)
        assertEquals("\"x\\ud83dy\"", lone.toString())
    }

    @Test fun whatIsReadIsWhatWasWritten() {
        val text = """{"id":"a_1","n":[1,2.5,-3e-7],"ok":false,"s":"é\n\"q\"","none":null}"""
        val v = Json.parse(text)
        assertEquals("é\n\"q\"", v["s"].string)
        assertEquals(2.5, v["n"][1].double!!, 0.0)
        assertEquals(Json.parse(v.text()), v)
        assertThrows(JsonError::class.java) { Json.parse("""{"a":1,}""") }
        assertThrows(JsonError::class.java) { Json.parse("""{"a":1} x""") }
    }

    @Test fun nullsAreLeftOutOfAnObjectAsUndefinedIs() {
        assertEquals("""{"a":1,"c":[null]}""", Json.obj("a" to 1, "b" to null, "c" to listOf(null)).canonical())
    }
}
