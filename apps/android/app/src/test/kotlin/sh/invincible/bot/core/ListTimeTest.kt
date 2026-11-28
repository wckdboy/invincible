package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

/**
 * When, as the list that is home says it (apps/web/src/lib/time.ts listTime), held to the vectors the PWA's own code
 * wrote: a fixed now, in Copenhagen and in British English, so every app checks the same strings. The patterns are the
 * ones Android's DateFormat makes for British English (its clock, "Hm", and its numeric date, "yMd"); on a phone they are
 * the phone's own.
 */
class ListTimeTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["listTimes"]!!
    private val now = v["now"].long!!
    private val british = ListTime(ZoneId.of(v["zone"].string!!), Locale.forLanguageTag(v["locale"].string!!), clock = "HH:mm", date = "dd/MM/y")

    @Test fun eachTimeIsSaidAsThePwaSaysIt() {
        val cases = v["cases"].list
        assertTrue(cases.size >= 12)
        for (c in cases) assertEquals("at ${c["at"].long}", c["words"].string, british.of(c["at"].long!!, now))
    }

    @Test fun itsDigitsAreTheLocalesOwn() {
        // (Egyptian Arabic writes its own digits, as the web and the iPhone write them there: java.time alone writes 0-9.)
        val egypt = ListTime(ZoneId.of(v["zone"].string!!), Locale.forLanguageTag("ar-EG"), clock = "HH:mm", date = "d/M/y")
        val today = v["cases"].list.first()
        assertEquals("١٤:٠٥", egypt.of(today["at"].long!!, now))
        assertEquals("٢١/١١/٢٠٢٦", egypt.of(v["cases"].list.first { it["words"].string == "21/11/2026" }["at"].long!!, now))
    }

    @Test fun aPatternJavaTimeCantReadIsTheLocalesOwnShortForm() {
        // (A pattern a phone's java.time doesn't know, as an older one doesn't know a day period's "B", draws no blank row.)
        val odd = ListTime(ZoneId.of(v["zone"].string!!), Locale.forLanguageTag(v["locale"].string!!), clock = "h:mm {", date = "d {")
        val today = v["cases"].list.first()
        assertEquals(today["words"].string, odd.of(today["at"].long!!, now))
        assertEquals("21/11/2026", odd.of(v["cases"].list.first { it["words"].string == "21/11/2026" }["at"].long!!, now))
    }
}
