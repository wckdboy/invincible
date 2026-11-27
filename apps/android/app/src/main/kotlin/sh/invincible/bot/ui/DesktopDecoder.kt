package sh.invincible.bot.ui

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import java.nio.ByteBuffer
import sh.invincible.bot.core.DesktopFrame
import sh.invincible.bot.core.DesktopStream

/**
 * An agent's desktop live on this phone (C1 step 9.4): each frame of the node's stream handed to MediaCodec (the
 * hardware's H.264 decoder) as it comes, and shown on [surface] at once. The decoder is made from each keyframe whose SPS
 * is new (its SPS and PPS as csd-0 and csd-1); a frame before the first keyframe is passed by, as the node sends none.
 * Its calls wait on the codec: it runs off the main thread. DesktopScreen watches; this shows.
 */
class DesktopDecoder(private val surface: Surface) {
    private var codec: MediaCodec? = null
    private var sps: ByteArray? = null
    private val info = MediaCodec.BufferInfo()

    /** The screen's size in its own pixels, as the decoder found it in the stream: where a tap lands. */
    var size: Pair<Int, Int>? = null
        private set

    /** One frame, decoded and shown: whether a frame reached the surface. */
    fun show(frame: DesktopFrame): Boolean {
        if (frame.kind != DesktopFrame.KEY && frame.kind != DesktopFrame.DELTA) return false
        if (frame.kind == DesktopFrame.KEY) {
            val sets = DesktopStream.parameterSets(frame.payload)
            if (sets != null && !sets.first.contentEquals(sps)) {
                release()
                // (The size here is a first guess: the decoder takes the SPS's own, and says it as its output's format.)
                val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 800).apply {
                    setByteBuffer("csd-0", ByteBuffer.wrap(sets.first))
                    setByteBuffer("csd-1", ByteBuffer.wrap(sets.second))
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
                    configure(format, surface, null, 0)
                    start()
                }
                sps = sets.first
            }
        }
        val codec = codec ?: return false
        val input = codec.dequeueInputBuffer(50_000)
        if (input >= 0) {
            val buffer = codec.getInputBuffer(input)!!
            buffer.clear()
            buffer.put(frame.payload)
            codec.queueInputBuffer(input, 0, frame.payload.size, frame.time * 1000, if (frame.kind == DesktopFrame.KEY) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        }
        var shown = false
        while (true) {
            val out = codec.dequeueOutputBuffer(info, if (shown) 0 else 20_000)
            when {
                out >= 0 -> {
                    codec.releaseOutputBuffer(out, true)
                    shown = true
                }
                out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val f = codec.outputFormat
                    val crop = f.containsKey("crop-right") && f.containsKey("crop-bottom")
                    size = if (crop) (f.getInteger("crop-right") - f.getInteger("crop-left") + 1) to (f.getInteger("crop-bottom") - f.getInteger("crop-top") + 1)
                    else f.getInteger(MediaFormat.KEY_WIDTH) to f.getInteger(MediaFormat.KEY_HEIGHT)
                }
                else -> break
            }
        }
        return shown
    }

    /** The decoder let go: the stream's next keyframe makes it anew. */
    fun release() {
        codec?.let {
            runCatching { it.stop() }
            it.release()
        }
        codec = null
        sps = null
    }
}
