package sh.invincible.bot.ui

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.TerminalInputQueue
import sh.invincible.bot.core.Terminals
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string

/**
 * A terminal in an agent's VM (the PWA's, the Apple app's): a login shell on a real terminal, drawn by the node's own
 * emulator (/term.js, the PWA's) in a page of its own, with the keys a phone's keyboard lacks below it. What its sign-ins
 * print to open (Claude Code's page, Codex's) is a button: the vendor's own sign-in, done in its own tool in the VM, so
 * what it signs in stays there and the primary never holds it. One already open in the VM is taken up again; leaving closes
 * it, and with it its shell. Watched only while the app is in front.
 */
@Composable
fun TerminalScreen(app: AppModel, sandbox: String, name: String, back: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val front by app.front.collectAsState()
    val bridge = remember { TerminalBridge(context, app.client?.origin ?: "") }
    var status by remember { mutableStateOf("Opening…") }
    var ended by remember { mutableStateOf(false) }
    var link by remember { mutableStateOf<String?>(null) }
    var id by remember { mutableStateOf<String?>(null) }
    var queue by remember { mutableStateOf<TerminalInputQueue?>(null) }
    var signing by remember { mutableStateOf(false) }
    fun type(data: String) {
        if (!ended) queue?.type(data)
    }
    // Leaving with Back closes it, and its shell (on the app's own scope: it outlives this screen). A rotation doesn't:
    // the screen comes back and takes the terminal up again.
    fun leave() {
        val client = app.client
        val open = id
        if (client != null && open != null && !ended) app.launch { runCatching { client.post("/api/terminals/close", Json.obj("terminal" to open)) } }
        back()
    }
    BackHandler { leave() }
    DisposableEffect(Unit) { onDispose { bridge.webView.destroy() } }

    LaunchedEffect(front) {
        val client = app.client ?: return@LaunchedEffect
        if (!front || ended) return@LaunchedEffect
        bridge.failed = { status = it }
        // The emulator fits itself first, so the shell starts at the size it is shown at.
        repeat(50) { if (bridge.size == null) delay(100) }
        val size = bridge.size ?: (80 to 24)
        val opened = id ?: try {
            val open = client.get("/api/terminals")["terminals"].list.firstOrNull { it["sandbox"].string == sandbox && it["exitCode"].int == null }
            (open ?: client.post("/api/terminals", Json.obj("sandbox" to sandbox, "size" to Json.obj("cols" to size.first, "rows" to size.second)))["terminal"])?.get("id").string
        } catch (e: NodeError) {
            status = e.message ?: "The terminal couldn't be opened."
            return@LaunchedEffect
        } ?: return@LaunchedEffect
        id = opened
        val input = queue ?: TerminalInputQueue(scope, send = { data, cols, rows ->
            client.post("/api/terminals/input", Json.obj("terminal" to opened, "data" to data, "size" to cols?.let { Json.obj("cols" to it, "rows" to rows) }))
        }, failed = { if (!ended) status = it.message ?: "What was typed didn't reach the terminal." }).also { queue = it }
        bridge.onKeys = { type(it) }
        bridge.onSize = { (cols, rows) -> if (!ended) input.resize(cols, rows) }
        bridge.focus()
        var lately = ""
        var tries = 0
        while (!ended) {
            try {
                var first = true
                client.events("/api/terminals/watch", Json.obj("terminal" to opened)).collect { event ->
                    // Taken up (again): what the node kept is drawn on a clean screen, and the shell is told its size.
                    if (first) {
                        first = false
                        tries = 0
                        bridge.reset()
                        lately = ""
                        bridge.size?.let { (cols, rows) -> input.resize(cols, rows) }
                        status = ""
                    }
                    when (event["type"].string) {
                        "output" -> event["data"].string?.let { data ->
                            bridge.write(data)
                            val text = runCatching { String(java.util.Base64.getDecoder().decode(data), Charsets.UTF_8) }.getOrDefault("")
                            lately = (lately + text).takeLast(16_000)
                            Terminals.links(lately).lastOrNull()?.let { link = it }
                        }
                        "exit" -> {
                            ended = true
                            status = "Its shell ended (exit ${event["code"].int ?: 0}). Back closes this."
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: NodeError) {
                if (e.status == 404) {
                    ended = true
                    status = "This terminal is gone: it was closed, or nobody watched it for 15 minutes."
                    return@LaunchedEffect
                }
            }
            if (ended) return@LaunchedEffect
            status = "Reconnecting…"
            delay(minOf(10_000L, 500L * (1 shl minOf(tries, 5))))
            tries += 1
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        PageBar("$name's terminal", { leave() }) {
            Box {
                TextButton(onClick = { signing = true }, enabled = !ended && id != null) { Text("Sign a tool in") }
                // The vendors' own sign-ins, typed for you into this shell: they run in the VM, and keep what they sign in there.
                DropdownMenu(expanded = signing, onDismissRequest = { signing = false }) {
                    DropdownMenuItem(text = { Text("Sign Claude Code in") }, onClick = { signing = false; type("claude auth login\r") })
                    DropdownMenuItem(text = { Text("Sign Codex in") }, onClick = { signing = false; type("codex login --device-auth\r") })
                }
            }
        }
        AndroidView(
            factory = { bridge.webView },
            modifier = Modifier.weight(1f).fillMaxWidth().background(TERMINAL).semantics { contentDescription = "$name's terminal" },
        )
        link?.let { address ->
            Button(
                onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s1),
            ) { Text("Open ${Uri.parse(address).host ?: "the page"} to sign in") }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Space.margin, vertical = Space.s2), horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            for ((label, keys, spoken) in KEYS) {
                OutlinedButton(onClick = { type(keys); bridge.focus() }, enabled = !ended, modifier = Modifier.semantics { contentDescription = spoken }) { Text(label) }
            }
            OutlinedButton(onClick = {
                val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
                clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.let { type(it) }
            }, enabled = !ended) { Text("Paste") }
        }
        if (status.isNotEmpty()) {
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = Space.margin, end = Space.margin, bottom = Space.s2))
        }
    }
}

private val TERMINAL = Color(0xFF060607)

/** Keys a phone's keyboard lacks, as a terminal takes them (the PWA's), with what a screen reader says. */
private val KEYS = listOf(
    Triple("esc", "\u001b", "Escape"), Triple("tab", "\t", "Tab"), Triple("^C", "\u0003", "Control C"), Triple("^D", "\u0004", "Control D"),
    Triple("←", "\u001b[D", "Left"), Triple("↑", "\u001b[A", "Up"), Triple("↓", "\u001b[B", "Down"), Triple("→", "\u001b[C", "Right"),
)

/**
 * The terminal shown and typed into: the node's emulator, the PWA's own, in a page of this app's that loads it from the
 * node and nothing else (nothing kept, no navigating away). What is typed comes back here; what to show goes in, as the
 * node sent it in base64, so nothing in it can break out of the call.
 */
@SuppressLint("SetJavaScriptEnabled")
class TerminalBridge(context: Context, origin: String) {
    val webView = WebView(context)
    var onKeys: (String) -> Unit = {}
    var onSize: (Pair<Int, Int>) -> Unit = {}
    var failed: (String) -> Unit = {}
    /** Its size in characters, once the emulator has fitted it to its box. */
    var size: Pair<Int, Int>? = null
        private set
    private val waiting = ArrayList<String>()
    private var started = false
    private val main = Handler(Looper.getMainLooper())

    init {
        // Its own size, not its content's: a web view that wraps its content gives the page no height to fill.
        webView.layoutParams = android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
        webView.setBackgroundColor(android.graphics.Color.rgb(6, 6, 7))
        webView.settings.javaScriptEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.domStorageEnabled = false
        // Only the page itself is loaded: nothing it shows can take the view elsewhere.
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        webView.addJavascriptInterface(Relay(), "invincibleApp")
        webView.loadDataWithBaseURL(origin.trimEnd('/') + "/", PAGE, "text/html", "utf-8", null)
    }

    /** What the terminal shows next, as the node sent it. */
    fun write(base64: String) {
        if (!BASE64.matches(base64)) return
        if (started) run("terminal.write('$base64')") else waiting += base64
    }

    fun reset() {
        if (started) run("terminal.reset()") else waiting.clear()
    }

    fun focus() {
        if (started) run("terminal.focus()")
    }

    private fun run(script: String) = webView.evaluateJavascript(script, null)

    /** The page's calls, taken on the main thread. (Public: the web view calls it by reflection.) */
    inner class Relay {
        @JavascriptInterface
        fun post(name: String, value: String) {
            main.post {
                when (name) {
                    "keys" -> onKeys(value)
                    "failed" -> failed(value.ifEmpty { "The terminal couldn't be drawn." })
                    else -> {
                        val fitted = runCatching { Json.parse(value) }.getOrNull() ?: return@post
                        if (name == "ready" && !started) {
                            started = true
                            for (chunk in waiting) run("terminal.write('$chunk')")
                            waiting.clear()
                        }
                        // A size counts once the page is laid out: one a terminal can have (the route's bounds), not
                        // the nothing it fits to before the view has its own.
                        val cols = fitted["cols"].int?.takeIf { it >= 10 } ?: return@post
                        val rows = fitted["rows"].int?.takeIf { it >= 4 } ?: return@post
                        size = cols.coerceAtMost(500) to rows.coerceAtMost(200)
                        onSize(size!!)
                    }
                }
            }
        }
    }

    companion object {
        private val BASE64 = Regex("^[A-Za-z0-9+/=]*$")
        private const val PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#060607;overflow:hidden}#s{position:absolute;inset:6px}</style>
<div id="s"></div>
<script type="module">
const post = (name, value) => window.terminalApp.post(name, typeof value === "string" ? value : JSON.stringify(value));
try {
  const { mountEmulator } = await import("/term.js");
  const box = document.getElementById("s");
  const em = mountEmulator(box);
  window.terminal = {
    write: (b) => em.write(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))),
    reset: () => em.reset(),
    focus: () => em.focus(),
  };
  em.onKeys((data) => post("keys", data));
  new ResizeObserver(() => post("size", em.fit())).observe(box);
  post("ready", em.fit());
} catch (error) { post("failed", String(error)); }
</script>"""
    }
}
