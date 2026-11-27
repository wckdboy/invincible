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
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch

/**
 * The app once it's paired (the owner's word, 27 November 2026: "something like t3code on desktop, and openmausbot/grokbot
 * on mobile"): no tab bar, and it opens on the primary's conversation. On a phone one page at a time, opened from the
 * roster and back to the conversation, and the roster a drawer (ModalNavigationDrawer: what needs you, your agent, the
 * agents, the rooms, then the work, Settings and everything else), from the conversation's top-left or a swipe from its
 * left edge; Back closes it. From 600 dp wide (a tablet, a foldable open), the roster is a sidebar beside the page instead,
 * as T3 Code's. A tapped notification opens where it always did. Back, and Esc on a keyboard, return the way you came.
 */
@Composable
fun Root(app: AppModel) {
    val stack = rememberSaveable { mutableStateOf(listOf(Nav.ROOT)) }
    val nav = remember { Nav(stack) }
    var places by remember { mutableStateOf(false) }
    var giving by remember { mutableStateOf(false) }
    var folded by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    // A tablet, or a foldable open (the window's width, as Android's own size classes read it).
    val width: Dp = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.width.toDp() }
    val wide = width >= Space.wide
    val drawer = androidx.compose.material3.rememberDrawerState(androidx.compose.material3.DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val roomy = width >= Space.roomy
    val sidebar = wide && !folded
    val motion = MaterialTheme.motionScheme
    val brand = LocalBrand.current

    // A tapped notification, one of its buttons, or an `invincible:` link: the page it was about, opened straight from Home.
    // The very task (its ship asked, from Ship it…), an agent, a chat by its conversation, the Inbox (an approval's card
    // first, from Approve… or a link to it).
    val opening by app.opening.collectAsState()
    LaunchedEffect(opening) {
        val o = opening ?: return@LaunchedEffect
        when {
            o.address == "chat" -> {
                o.conversation?.let(app.chat::open)
                nav.open("chat")
            }
            // (An agent's page, from an `invincible://agent/<handle>` link.)
            o.address.startsWith("agent:") -> nav.open(o.address)
            o.address.startsWith("task:") -> {
                if (o.ship) app.shipAsked.value = o.address.removePrefix("task:")
                nav.open(o.address)
            }
            o.address == "inbox" -> {
                app.approvalAsked.value = o.approval
                nav.open("inbox")
            }
            o.address == "settings" -> nav.open("settings")
            else -> nav.open(Nav.ROOT)
        }
        app.opening.value = null
    }
    // What the app shows, so a notification about that very thing is told quietly (Notices).
    LaunchedEffect(nav.top) { app.showing.value = nav.top }
    // Something shared from another app: a new chat, with it in the message box (the chat's composer takes it from there).
    val shared by app.shared.collectAsState()
    LaunchedEffect(shared != null) {
        if (shared == null) return@LaunchedEffect
        app.chat.fresh()
        nav.open("chat")
    }

    BackHandler(enabled = nav.depth > 1) { nav.back() }
    // (Declared after Back's own, so while the drawer is open, Back closes it first.)
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
    val work = if (wide) rememberWork(app) else null

    val content: @Composable () -> Unit = { Box(
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
                    Page(app, nav, address, wide, roomy, drawer = if (sidebar || wide) null else ({ scope.launch { drawer.open() } }), give = { giving = true })
                }
            }
        }
        if (wide && folded) {
            IconButton(onClick = { folded = false }, modifier = Modifier.align(Alignment.BottomStart).semantics { contentDescription = "Show the sidebar" }) { Icon(PanelIcon, null) }
        }
        // While the node can't be reached: said over the page, with Retry (its live stream told it within seconds).
        ReachBanner(app, Modifier.align(Alignment.TopCenter))
    } }
    if (wide) content() else androidx.compose.material3.ModalNavigationDrawer(
        drawerState = drawer,
        // (From the conversation's left edge only, at the root: elsewhere that edge goes back.)
        gesturesEnabled = drawer.isOpen || nav.depth == 1,
        drawerContent = {
            androidx.compose.material3.ModalDrawerSheet(drawerContainerColor = brand.paper, windowInsets = WindowInsets.safeDrawing) {
                Drawer(
                    app,
                    current = nav.top,
                    go = { address -> scope.launch { drawer.close() }; nav.open(address) },
                    places = { scope.launch { drawer.close() }; places = true },
                    close = { scope.launch { drawer.close() } },
                )
            }
        },
        content = content,
    )
    if (places) PlacesSheet(app, nav, give = { giving = true }, close = { places = false })
    if (giving) GiveDialog(app) { giving = false }
}

private val DIGITS = listOf(Key.One, Key.Two, Key.Three, Key.Four, Key.Five, Key.Six, Key.Seven, Key.Eight, Key.Nine)

/** The page at an address. [drawer] opens the roster (a phone's; null where the roster is a sidebar). */
@Composable
private fun Page(app: AppModel, nav: Nav, address: String, wide: Boolean, roomy: Boolean, drawer: (() -> Unit)?, give: () -> Unit) {
    val back = { nav.back(); Unit }
    val inbox by app.inbox.collectAsState()
    val table by app.table.collectAsState()
    val (kind, rest) = address.substringBefore(':') to address.substringAfter(':', "")
    when (kind) {
        // (At the root its top-left opens the roster, a phone's drawer; over another page it goes back.)
        "chat" -> ChatScreen(app, back = back, roster = if (nav.depth == 1) drawer else null, root = nav.depth == 1, openTask = { nav.go(Nav.task(it)) }, give = give)
        "chats" -> Chats(app, close = back, opened = { if (nav.under == Nav.ROOT) nav.back() else nav.replace("chat") })
        "task" -> TaskScreen(app, rest, nav, wide, roomy)
        "agent" -> AgentScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) })
        "room" -> RoomScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) })
        "agents" -> AgentsScreen(app, back = back, openChat = { app.chat.fresh(); nav.go("chat") }, openAgent = { nav.go(Nav.agent(it)) }, openRoom = { nav.go(Nav.room(it)) })
        "inbox" -> InboxScreen(app, watch = { nav.go("mac:$it") }, back = back, openTask = { nav.go(Nav.task(it)) }, openConnectors = { nav.go("connectors") })
        "search" -> SearchScreen(app, nav, back = back)
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
        else -> HomeScreen(app, nav, back = back)
    }
}
