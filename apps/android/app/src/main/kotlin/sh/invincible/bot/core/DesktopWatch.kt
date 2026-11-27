package sh.invincible.bot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * An agent's screen kept live (C1 step 9.4), as the web app's viewer and the Apple app's DesktopWatch keep it: the node's
 * stream watched while the screen is on screen and the app is in front. A stream that ends is watched again a little
 * later each time (0.5, 1, 2 and 4 s), its last frame kept on screen meanwhile. After [DesktopStream.LIVE_TRIES] ends in a
 * row it gives way to the picture every two seconds, saying why; at once, saying nothing, when the node refuses it (an
 * older node, a VM with no stream: a 4xx, or 501). A node that didn't answer isn't a refusal: it is asked again. A frame
 * drawn starts the count again.
 *
 * The stream, the drawing and the waiting are handed in (DesktopScreen hands in the node's, its DesktopDecoder's and a
 * delay), so the tests run it on stand-ins.
 */
class DesktopWatch {
    /** Why it gave way to the picture: tried, and the stream didn't come through (said); or the node refused it. */
    enum class GivenUp { TRIED, REFUSED }

    /**
     * How it stands: the stream drawing now (what is done there asks no picture back, and the picture loop rests); its
     * last frame what the box shows (from its first frame drawn, between one stream and the next too, until it gives way);
     * and whether it gave way to the picture, and why.
     */
    data class State(val watching: Boolean = false, val drawn: Boolean = false, val givenUp: GivenUp? = null)

    private val now = MutableStateFlow(State())
    val state: StateFlow<State> = now.asStateFlow()

    /**
     * Watches until it gives way to the picture, or until it is cancelled (the screen left, the app behind: watched from
     * the start again when it is back, with nothing counted). [open]: the node's stream of the screen; [show]: one frame
     * drawn, and whether it reached the screen; [ended]: the stream is over (its decoder let go, even when it is left);
     * [wait]: the pause before watching again, in ms; [began], [stopped]: a stream's first frame drawn, and a stream that
     * was drawing ended.
     */
    suspend fun run(
        open: () -> Flow<DesktopFrame>,
        show: suspend (DesktopFrame) -> Boolean,
        ended: suspend () -> Unit,
        wait: suspend (Long) -> Unit,
        began: () -> Unit = {},
        stopped: () -> Unit = {},
    ) {
        var tries = 0
        while (now.value.givenUp == null) {
            currentCoroutineContext().ensureActive()
            var refused = false
            try {
                open().collect { frame ->
                    if (show(frame) && !now.value.watching) {
                        now.value = now.value.copy(watching = true, drawn = true)
                        tries = 0
                        began()
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                refused = refuses(e)
            } finally {
                withContext(NonCancellable) { ended() }
                if (now.value.watching) {
                    now.value = now.value.copy(watching = false)
                    stopped()
                }
            }
            tries += 1
            if (refused || tries >= DesktopStream.LIVE_TRIES) {
                now.value = now.value.copy(drawn = false, givenUp = if (refused) GivenUp.REFUSED else GivenUp.TRIED)
                return
            }
            wait(DesktopStream.againIn(tries).toLong())
        }
    }

    /** The screen lost its last frame (a surface made again starts empty): the picture until the next frame is drawn. */
    fun forget() {
        now.value = now.value.copy(drawn = false)
    }

    companion object {
        /**
         * The node's refusal, which asking again doesn't mend: a 4xx, or 501 where it has no stream. A node that didn't
         * answer, or a proxy that answered for one that's away, is asked again.
         */
        fun refuses(e: Throwable): Boolean = e is NodeError && !e.unreachable && (e.status in 400..499 || e.status == 501)
    }
}
