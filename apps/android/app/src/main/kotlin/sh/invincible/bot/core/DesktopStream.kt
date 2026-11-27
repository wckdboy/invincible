package sh.invincible.bot.core

/**
 * An agent's desktop live (C1 step 9.4), as core's desktop-frames.ts, the PWA's lib/desktop-stream.ts and the Apple
 * app's DesktopStream.swift read it: the node's stream of its screen (POST /api/team/desktop/stream), frames read whole
 * as their bytes come; the codec a keyframe is; its SPS and PPS, which MediaCodec takes as csd-0 and csd-1; your
 * take-over as the node says it; and when to watch again. Pure: DesktopDecoder decodes. Held to the parity vectors'
 * `desktopStream`.
 *
 * Each frame: a 4-byte big-endian length of what follows it, a byte for its kind (0 a beat, 1 a keyframe, 2 any other;
 * one this app doesn't know is passed by), an 8-byte big-endian time in milliseconds since the epoch, then its payload:
 * the screen's H.264 NAL units, Annex B, Constrained Baseline; nothing for a beat.
 */
class DesktopFrame(val kind: Int, val time: Long, val payload: ByteArray) {
    companion object {
        const val BEAT = 0
        const val KEY = 1
        const val DELTA = 2
    }
}

/** A stream's frames as its bytes come. A length no frame has is no stream of frames: it throws. */
class DesktopFrames {
    class NotFrames(val length: Long) : Exception("not a desktop frame: a length of $length bytes")

    private var held = ByteArray(64)
    private var count = 0
    /** What follows the 4-byte length, once it is read; -1 before. */
    private var length = -1

    /** One byte more of the stream (0 to 255): the frame it ends, if it ends one. */
    fun push(byte: Int): DesktopFrame? {
        if (count == held.size) held = held.copyOf(held.size * 2)
        held[count++] = byte.toByte()
        if (length < 0) {
            if (count < 4) return null
            val n = ((held[0].toLong() and 0xFF) shl 24) or ((held[1].toLong() and 0xFF) shl 16) or ((held[2].toLong() and 0xFF) shl 8) or (held[3].toLong() and 0xFF)
            if (n < HEADER - 4 || n > MOST) throw NotFrames(n)
            length = n.toInt()
            if (held.size < 4 + length) held = held.copyOf(4 + length)
            return null
        }
        if (count < 4 + length) return null
        var time = 0L
        for (i in 5 until HEADER) time = (time shl 8) or (held[i].toLong() and 0xFF)
        val frame = DesktopFrame(held[4].toInt() and 0xFF, time, held.copyOfRange(HEADER, count))
        count = 0
        length = -1
        return frame
    }

    /** Bytes of the stream, in a piece of any size: the frames they end. */
    fun push(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): List<DesktopFrame> {
        val frames = ArrayList<DesktopFrame>()
        for (i in from until to) push(bytes[i].toInt() and 0xFF)?.let { frames.add(it) }
        return frames
    }

    companion object {
        /** The length, the kind and the time: what comes before a frame's payload. */
        const val HEADER = 13
        /** The most a frame may be (core's DESKTOP_FRAME_MAX). */
        const val MOST = 8 * 1024 * 1024
    }
}

object DesktopStream {
    /** After this many ends in a row, the live screen gives way to a picture every two seconds, and says so. */
    const val LIVE_TRIES = 4

    /** Each NAL unit of an Annex B stretch, without its start code (00 00 01, or 00 00 00 01). */
    fun nalUnits(annexB: ByteArray): List<ByteArray> {
        val starts = ArrayList<Int>()
        var i = 0
        while (i + 2 < annexB.size) {
            if (annexB[i].toInt() == 0 && annexB[i + 1].toInt() == 0 && annexB[i + 2].toInt() == 1) {
                starts.add(i + 3)
                i += 3
            } else i++
        }
        return starts.mapIndexed { n, start ->
            var end = if (n + 1 < starts.size) starts[n + 1] - 3 else annexB.size
            // (A four-byte start code's leading zero belongs to it, not to the unit before.)
            if (n + 1 < starts.size && end > start && annexB[end - 1].toInt() == 0) end--
            annexB.copyOfRange(start, end)
        }
    }

    /** A NAL unit's type (5 an IDR slice, 7 an SPS, 8 a PPS, 9 an access unit delimiter). */
    fun type(unit: ByteArray): Int = if (unit.isEmpty()) 0 else unit[0].toInt() and 0x1F

    /** The codec a keyframe is (RFC 6381): avc1, then its SPS's profile, constraints and level. Null with no SPS. */
    fun codec(keyframe: ByteArray): String? {
        val sps = nalUnits(keyframe).firstOrNull { type(it) == 7 && it.size >= 4 } ?: return null
        return "avc1." + (1..3).joinToString("") { "%02X".format(sps[it].toInt() and 0xFF) }
    }

    /**
     * A keyframe's SPS and PPS, the first of each, each after a 4-byte start code: MediaCodec's csd-0 and csd-1 for
     * "video/avc". Null without both.
     */
    fun parameterSets(keyframe: ByteArray): Pair<ByteArray, ByteArray>? {
        val units = nalUnits(keyframe)
        val sps = units.firstOrNull { type(it) == 7 } ?: return null
        val pps = units.firstOrNull { type(it) == 8 } ?: return null
        val start = byteArrayOf(0, 0, 0, 1)
        return (start + sps) to (start + pps)
    }

    /** How long to wait before watching again after the stream's nth end in a row (from 1): 0.5, 1, 2 and 4 s, then 5 s. */
    fun againIn(n: Int): Int = minOf(5000, 500 * (1 shl (n - 1).coerceIn(0, 10)))
}

/** Your take-over as the node says it (`held`, on each answer of /api/team/desktop and of take and release). */
data class DesktopHold(val since: Double, val idleSec: Double, val mostSec: Double, val endsInSec: Double) {
    /** When it ends by this device's clock, in milliseconds, if nothing more is done there: [said], when the node said it. */
    fun ends(said: Double): Double = said + endsInSec * 1000

    companion object {
        /** The node's `held`: null when you don't have it (or from an image older than take-over). */
        fun of(held: Json?): DesktopHold? {
            val since = held["since"].double ?: return null
            return DesktopHold(since, held["idleSec"].double ?: 0.0, held["mostSec"].double ?: 0.0, held["endsInSec"].double ?: 0.0)
        }
    }
}
