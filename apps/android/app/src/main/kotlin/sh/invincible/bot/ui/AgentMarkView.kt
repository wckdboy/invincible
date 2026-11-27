package sh.invincible.bot.ui

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.Glass
import sh.invincible.bot.core.Json

/*
 * An agent's mark: its glass (core/Glass.kt, drawn by GlassView.kt; core's glass.ts, the owner's word of 27 November 2026
 * that the Grille goes), its shape and its ramp as its node gave them, the same on every device. What the Grille said in
 * its shape is a dot beside the word now: working, needs you, failed, and idle for the rest (Glass.state), the line beside
 * it saying which. Where no state is given (a speaker, a pick list), no dot.
 */

/** An agent's mark, by its handle and saved avatar ([profile]: its glass, v 4; a mark, v 3, or a colour chosen before
 * the marks, v 2, whose colour it keeps; or nothing), its dot showing [state] where one is given. Decorative beside its
 * name; named ([description]) where it stands alone. */
@Composable
fun AgentMarkView(id: String, profile: Json?, size: Dp, state: AgentMark.State? = null, description: String? = null) {
    val glass = remember(id, profile) { Glass.of(id, profile) }
    GlassMark(glass, size, state?.let(Glass::state), description)
}

/** An agent's mark or the primary's by handle ("primary" is the primary's: your agent's mark), with a dot only where a
 * state is given (the primary's has none). */
@Composable
fun Face(id: String, profile: Json?, size: Dp, state: AgentMark.State? = null, description: String? = null) {
    if (id == "primary") PrimaryMark(size, description) else AgentMarkView(id, profile, size, state, description)
}

/** Whether things may move: not while the phone's animations are off (Settings › Accessibility › Remove animations,
 * which sets the animator duration scale to 0). Read once, then watched for the app's life. */
@Composable
internal fun motionAllowed(): Boolean {
    val context = LocalContext.current
    return remember(context) { MotionSetting.allowed(context) }.value
}

private object MotionSetting {
    private var state: MutableState<Boolean>? = null

    fun allowed(context: Context): State<Boolean> = state ?: run {
        val app = context.applicationContext ?: context
        val watched = mutableStateOf(on(app))
        app.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) {
                    watched.value = on(app)
                }
            },
        )
        state = watched
        watched
    }

    private fun on(context: Context) = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
}
