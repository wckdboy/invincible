package sh.invincible.bot.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.Notices
import sh.invincible.bot.app.UnifiedPush
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Reach
import sh.invincible.bot.core.Primary

/**
 * The card at the top of the primary's home while it can't reach this phone when Invincible is closed (the web app's and the
 * iPhone's): no device of yours can be reached, this phone's were lost, or they were turned off elsewhere while it
 * thought itself on. Turn on (Android asks from your tap, on 13 and later), or Open settings when Android blocks them;
 * Not now puts it away until the app next comes to the front.
 */
@Composable
fun ReachCard(app: AppModel) {
    val card by app.reach.collectAsState()
    val shown = card ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current
    var busy by remember { mutableStateOf(false) }
    var said by remember { mutableStateOf<String?>(null) }
    fun start() {
        val client = app.client ?: return
        busy = true
        scope.launch {
            try {
                Notices.turnOn(context, client)
                UnifiedPush.distributors(context).singleOrNull()?.let { Notices.makeInstant(context, client, it) }
                app.putReachAway()
            } catch (e: NodeError) {
                said = e.message
            } finally {
                busy = false
            }
        }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) start() else said = "Android won't show them until notifications are allowed for Invincible."
    }
    Panel {
        Text("${Primary.name} can't reach this phone when the app is closed.", style = MaterialTheme.typography.titleSmallEmphasized)
        when {
            shown.offElsewhere -> Text("They were turned off for this phone on another device of yours.", style = MaterialTheme.typography.bodyMedium)
            shown.lost != null -> Text(shown.lost, style = MaterialTheme.typography.bodyMedium)
        }
        if (shown.step == Reach.Step.SETTINGS) Text("Android isn't showing them: notifications are off for Invincible.", style = MaterialTheme.typography.bodyMedium, color = brand.needs)
        said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
        // (Its buttons wrap where it is narrow, a tablet's sidebar: there Not now was squeezed into a column of letters.)
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
            if (shown.step == Reach.Step.SETTINGS) {
                Button(onClick = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("Open settings") }
            } else {
                Button(enabled = !busy, onClick = { if (Build.VERSION.SDK_INT >= 33 && !Notices.allowed(context)) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS) else start() }) { Text("Turn on notifications") }
            }
            TextButton(onClick = { app.putReachAway() }) { Text("Not now") }
        }
    }
}
