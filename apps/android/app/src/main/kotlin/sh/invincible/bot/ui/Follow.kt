package sh.invincible.bot.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel

/**
 * What a screen shows, read again as the live stream says one of its topics moved (AppModel.follow), as the web's pages
 * follow theirs: never on a timer while the stream is up, so a screen at rest asks nothing. The screen reads it once as
 * it opens; this, after, for as long as it is on screen. [read] says whether it got an answer.
 */
@Composable
fun FollowTopics(app: AppModel, topics: List<String>, key: Any?, everyMs: Long?, gapMs: Long, read: suspend () -> Boolean) {
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(read)
    DisposableEffect(app, key) {
        val stop = app.follow(topics, everyMs, gapMs) { done ->
            scope.launch {
                var ok = false
                try {
                    ok = latest()
                } finally {
                    done(ok)
                }
            }
        }
        onDispose { stop() }
    }
}
