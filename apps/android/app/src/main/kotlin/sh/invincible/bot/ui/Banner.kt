package sh.invincible.bot.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary

/**
 * The banner over the page while the node can't be reached (its live stream down: a dead link is told within seconds),
 * with Retry, and "Reconnected" for a moment once it is again. The web's words (lib/alerts.ts CONNECTION), with the
 * primary's name.
 */
@Composable
fun ReachBanner(app: AppModel, modifier: Modifier = Modifier) {
    val online by app.online.collectAsState()
    var said by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(online) {
        when (online) {
            false -> said = UNREACHABLE
            true -> if (said == UNREACHABLE) {
                said = RECONNECTED
                delay(1_800)
                said = null
            }
            null -> said = null
        }
    }
    val brand = LocalBrand.current
    AnimatedVisibility(said != null, modifier, enter = fadeIn(), exit = fadeOut()) {
        Row(
            Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .widthIn(max = 560.dp)
                .background(brand.raised, RoundedCornerShape(50))
                .border(1.dp, brand.line, RoundedCornerShape(50))
                .padding(start = 14.dp, end = 4.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(if (said == RECONNECTED) CheckIcon else AlertIcon, null, Modifier.size(16.dp), tint = brand.ink)
            Text(
                if (said == RECONNECTED) "Reconnected" else "Can't reach ${Primary.name} right now. What you see may be out of date.",
                Modifier.weight(1f, fill = false).padding(vertical = 10.dp),
                color = brand.ink,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
            )
            if (said == UNREACHABLE) TextButton(onClick = { app.reconnect() }) { Text("Retry", color = brand.ink) }
        }
    }
}

private const val UNREACHABLE = "unreachable"
private const val RECONNECTED = "reconnected"
