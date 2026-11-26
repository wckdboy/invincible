package sh.invincible.bot

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.Attachments
import sh.invincible.bot.app.Notices
import sh.invincible.bot.core.Joining
import sh.invincible.bot.core.Share
import sh.invincible.bot.ui.InvincibleTheme
import sh.invincible.bot.ui.JoinScreen
import sh.invincible.bot.ui.Root

class MainActivity : ComponentActivity() {
    private val app by lazy { AppModel.of(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        take(intent)
        // The node is asked only while the app is on screen. What it kept for this phone's notifications is collected
        // beside the first look, not before it: that was a whole round trip before the agents could fill in.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.front.value = true
                try {
                    launch { app.inFront() }
                    app.poll()
                } finally {
                    app.front.value = false
                }
            }
        }
        setContent {
            InvincibleTheme {
                Surface(Modifier.fillMaxSize()) {
                    val paired by app.paired.collectAsState()
                    if (paired == null) JoinScreen(app) else Root(app)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    /**
     * A tapped notification opens where it says; an `invincible:` link carrying an invite, opened or shared on this phone,
     * fills in the join; anything else shared from another app goes to a new chat's message box, unsent.
     */
    private fun take(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(Notices.OPEN)?.let { open ->
            app.opening.value = open to intent.getStringExtra(Notices.CONVERSATION)
            return
        }
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        (intent.dataString ?: text)?.let(Joining::handed)?.let {
            app.handed.value = it
            return
        }
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        val pictures = if (intent.type?.startsWith("image/") != true) emptyList() else if (intent.action == Intent.ACTION_SEND_MULTIPLE) streams(intent) else listOfNotNull(stream(intent))
        val words = Share.read(intent.getStringExtra(Intent.EXTRA_SUBJECT), text)
        if (words != null || pictures.isNotEmpty()) app.shared.value = AppModel.Shared(words, pictures.take(Attachments.PER_MESSAGE))
    }

    private fun stream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)

    private fun streams(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
}
