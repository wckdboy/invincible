@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string

/**
 * The app once it's paired (your words, 26 November 2026: "agent first (the primary)", T3 Code's panes on a wide screen): no
 * tab bar, and Home is the primary. On a phone one page at a time, opened from Home and back to it; on a tablet or an open
 * foldable, the work's sidebar beside the page, as T3 Code's. Every page the app had is still here: Home holds what needs
 * you and the work, "…" everything else (the agents, the Inbox, its chats, keys, connectors, settings), and a tapped
 * notification opens where it always did. Back, and Esc on a keyboard, return the way you came.
 */
@Composable
fun Root(app: AppModel) {
    val stack = rememberSaveable { mutableStateOf(listOf(Nav.HOME)) }
    val nav = remember { Nav(stack) }
    var places by remember { mutableStateOf(false) }
    var giving by remember { mutableStateOf(false) }
    var folded by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    // A tablet, or a foldable open (the window's width, as Android's own size classes read it).
    val width: Dp = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.width.toDp() }
    val wide = width >= Space.wide
    val roomy = width >= Space.roomy
    val sidebar = wide && !folded
    val motion = MaterialTheme.motionScheme
    val brand = LocalBrand.current

    // A tapped notification: the page it was about (a chat by its conversation), opened straight from Home.
    val opening by app.opening.collectAsState()
    LaunchedEffect(opening) {
        val (open, conversation) = opening ?: return@LaunchedEffect
        when (open) {
            "chat" -> {
                conversation?.let(app.chat::open)
                nav.open("chat")
            }
            "inbox" -> nav.open("inbox")
            "settings" -> nav.open("settings")
            else -> nav.open("agents")
        }
        app.opening.value = null
    }
    // Something shared from another app: a new chat, with it in the message box (the chat's composer takes it from there).
    val shared by app.shared.collectAsState()
    LaunchedEffect(shared != null) {
        if (shared == null) return@LaunchedEffect
        app.chat.fresh()
        nav.open("chat")
    }

    BackHandler(enabled = nav.depth > 1) { nav.back() }
    val work = if (wide) rememberWork(app) else null

    Box(
        Modifier
            .fillMaxSize()
            .background(brand.paper)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            // On a keyboard: Esc goes back; Ctrl (⌘) and a digit opens that task of the work, in the order of attention.
            .onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when {
                    e.key == Key.Escape -> nav.back()
                    (e.isCtrlPressed || e.isMetaPressed) && e.key in DIGITS -> {
                        val row = work?.let { Work.byAttention(it).getOrNull(DIGITS.indexOf(e.key)) } ?: return@onPreviewKeyEvent false
                        nav.open(Nav.task(row.id))
                        true
                    }
                    else -> false
                }
            },
    ) {
        Row(Modifier.fillMaxSize()) {
            if (sidebar) {
                Sidebar(app, nav, give = { giving = true }, places = { places = true }, collapse = { folded = true })
                VerticalDivider(thickness = Dp.Hairline, color = brand.line)
            }
            // A page opens from the side and closes back to it (shared axis); one place gives way to another in place.
            AnimatedContent(
                targetState = nav.top to nav.depth,
                transitionSpec = {
                    val slide = motion.defaultSpatialSpec<IntOffset>()
                    val fade = motion.defaultEffectsSpec<Float>()
                    when {
                        targetState.second > initialState.second -> (slideInHorizontally(slide) { it / 10 } + fadeIn(fade)) togetherWith fadeOut(fade)
                        targetState.second < initialState.second -> fadeIn(fade) togetherWith (slideOutHorizontally(slide) { it / 10 } + fadeOut(fade))
                        else -> fadeIn(fade) togetherWith fadeOut(fade)
                    }
                },
                modifier = Modifier.weight(1f).fillMaxHeight(),
                label = "page",
            ) { (address, _) ->
                // A tap that nothing on the page takes puts the keyboard away, as Back does (your word, 23 November 2026:
                // it can always be closed, so you never get stuck under it).
                Column(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onTap = { focus.clearFocus() }) }) {
                    Page(app, nav, address, wide, roomy, places = { places = true }, give = { giving = true })
                }
            }
        }
        if (wide && folded) {
            IconButton(onClick = { folded = false }, modifier = Modifier.align(Alignment.BottomStart).semantics { contentDescription = "Show the sidebar" }) { Icon(PanelIcon, null) }
        }
    }
    if (places) PlacesSheet(app, nav, give = { giving = true }, close = { places = false })
    if (giving) GiveDialog(app) { giving = false }
}

private val DIGITS = listOf(Key.One, Key.Two, Key.Three, Key.Four, Key.Five, Key.Six, Key.Seven, Key.Eight, Key.Nine)

/** The page at an address. */
@Composable
private fun Page(app: AppModel, nav: Nav, address: String, wide: Boolean, roomy: Boolean, places: () -> Unit, give: () -> Unit) {
    val back = { nav.back(); Unit }
    val inbox by app.inbox.collectAsState()
    val table by app.table.collectAsState()
    val (kind, rest) = address.substringBefore(':') to address.substringAfter(':', "")
    when (kind) {
        "chat" -> ChatScreen(app, back = back, openTask = { nav.go(Nav.task(it)) })
        "chats" -> Chats(app, close = back, opened = { nav.replace("chat") })
        "task" -> TaskScreen(app, rest, nav, wide, roomy)
        "agent" -> AgentScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) })
        "room" -> RoomScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) })
        "agents" -> AgentsScreen(app, back = back, openChat = { app.chat.fresh(); nav.go("chat") }, openAgent = { nav.go(Nav.agent(it)) }, openRoom = { nav.go(Nav.room(it)) })
        "inbox" -> InboxScreen(app, watch = { nav.go("mac:$it") }, back = back)
        "settings" -> SettingsScreen(app, openKeys = { nav.go("keys") }, openConnectors = { nav.go("connectors") }, back = back)
        "keys" -> KeysScreen(app, back)
        "connectors" -> ConnectorsScreen(app, back)
        "mac" -> DesktopScreen(app, rest, inbox.screens.firstOrNull { it["node"].string == rest }?.let { it["nodeName"].string } ?: "The Mac", onMac = true, back = back)
        "desktop" -> DesktopScreen(app, rest, table.snapshot?.agents?.firstOrNull { it.id == rest }?.name ?: rest, back = back)
        "terminal" -> {
            val sandbox = rest.substringBefore(':')
            val agent = rest.substringAfter(':', "")
            TerminalScreen(app, sandbox, table.snapshot?.agents?.firstOrNull { it.id == agent }?.name ?: "Its VM", back)
        }
        else -> HomeScreen(app, nav, places = places, give = give)
    }
}
