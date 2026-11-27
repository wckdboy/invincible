package sh.invincible.bot.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

/**
 * An agent's desktop live as core, the PWA and the Apple app read it (the parity vectors' `desktopStream`): its frames as
 * their bytes come, the codec a keyframe is, its SPS and PPS as MediaCodec takes them, your take-over's end, and when to
 * watch again. The glass page's recording is parsed here; its decoding (MediaCodec) is an emulator's.
 */
class DesktopStreamTest {
    private val v: Json = Json.parse(javaClass.classLoader!!.getResource("core-vectors.json")!!.readText())["desktopStream"]!!
    private fun b64(text: String?): ByteArray = Base64.getDecoder().decode(text!!)
    private fun said(frames: List<DesktopFrame>) = frames.map { "${it.kind} ${it.time} ${Base64.getEncoder().encodeToString(it.payload)}" }

    @Test
    fun framesComeWholeHoweverTheirBytesAreCut() {
        val bytes = b64(v["bytes"].string)
        val want = v["frames"].list.map { "${it["kind"].int} ${it["time"].long} ${it["payload"].string}" }
        for (cut in v["cuts"].list) {
            val frames = DesktopFrames()
            val got = ArrayList<DesktopFrame>()
            var from = 0
            for (at in cut.list.map { it.int!! } + bytes.size) {
                got += frames.push(bytes, from, at)
                from = at
            }
            assertEquals("cut at $cut", want, said(got))
        }
        assertEquals(v["header"].int, DesktopFrames.HEADER)
        assertEquals(v["most"].int, DesktopFrames.MOST)
    }

    @Test
    fun whatIsNoStreamOfFramesIsRefusedNeverReadAsOne() {
        val refused = v["refused"].list
        assertEquals(3, refused.size)
        for (each in refused) assertThrows(DesktopFrames.NotFrames::class.java) { DesktopFrames().push(b64(each.string)) }
    }

    @Test
    fun aKeyframesCodecIsReadFromItsSPSAsThePWAReadsIt() {
        for (each in v["codecs"].list) assertEquals(each["payload"].string, each["codec"].string, DesktopStream.codec(b64(each["payload"].string)))
    }

    @Test
    fun aKeyframesParameterSetsGoToMediaCodecEachAfterItsStartCode() {
        val key = b64(v["frames"][0]["payload"].string)
        val (sps, pps) = DesktopStream.parameterSets(key)!!
        assertArrayEquals(byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0xC0.toByte(), 0x1F, 0xDA.toByte(), 0x01, 0x40), sps)
        assertArrayEquals(byteArrayOf(0, 0, 0, 1, 0x68, 0xCE.toByte(), 0x3C, 0x80.toByte()), pps)
        // A frame with no parameter sets has none to give.
        assertNull(DesktopStream.parameterSets(b64(v["frames"][1]["payload"].string)))
    }

    @Test
    fun aHoldEndsWhenTheNodeSaidAndWatchingAgainWaitsALittleLongerEachTime() {
        for (each in v["holds"].list) assertEquals(each["ends"].double!!, DesktopHold.of(each["held"])!!.ends(each["at"].double!!), 0.0)
        assertNull(DesktopHold.of(Json.Null))
        for (each in v["again"].list) assertEquals("try ${each["n"].int}", each["ms"].int, DesktopStream.againIn(each["n"].int!!))
        assertEquals(v["liveTries"].int, DesktopStream.LIVE_TRIES)
    }

    @Test
    fun theGlassPagesRecordingIsFramesAKeyframeFirstWithItsParameterSets() {
        val glass = v["glass"]
        val bytes = javaClass.classLoader!!.getResource(glass["fixture"].string!!)!!.readBytes()
        val frames = DesktopFrames().push(bytes)
        assertEquals(glass["frames"].list.map { it["kind"].int }, frames.map { it.kind })
        assertNotNull(DesktopStream.parameterSets(frames[0].payload))
        assertEquals("avc1.42C020", DesktopStream.codec(frames[0].payload))
    }
}
