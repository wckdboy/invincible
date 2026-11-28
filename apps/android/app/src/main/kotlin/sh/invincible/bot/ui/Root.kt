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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Primary
import sh.invincible.bot.core.Roster
import sh.invincible.bot.core.Work
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string

/**
 * The app once it's paired (the owner's word, 28 November 2026: "use grok bot as the app look/UX. like a chat app, with the
 * primary at the top, the other agents, and a settings menu"): no tab bar, and it opens on the list (HomeList: your agent
 * pinned first, then the agents and rooms by what they last did). On a phone one page at a time, each opened from the list
 * and back to it. From 600 dp wide (a tablet, a foldable open), the list is a sidebar beside the page instead, and the
 * page at the root is your agent's chat. A tapped notification opens where it always did. Back, and Esc on a keyboard,
 * return the way you came.
 */
@Composable
fun Root(app: AppModel) {
    val stack = rememberSaveable { mutableStateOf(listOf(Nav.ROOT)) }
    val nav = remember { Nav(stack) }
    var giving by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    // A tablet, or a foldable open (the window's width, as Android's own size classes read it).
    val width: Dp = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.width.toDp() }
    val wide = width >= Space.wide
    val roomy = width >= Space.roomy
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
            // (No Needs you screen, the lead's defaults of 28 November 2026.) An approval, from its Approve… or a link to it,
            // opens in the chat it waits in, its card at once; anything else that waits on you, in your agent's chat with
            // every ask at once (and an approval not read yet there too, among them).
            o.address == "inbox" -> {
                app.approvalAsked.value = o.approval
                val agents = app.table.value.snapshot?.agents?.map { it.id } ?: emptyList()
                val by = o.approval?.let { id -> app.inbox.value.actions.firstOrNull { it["id"].string == id }?.get("by").string }
                val chat = by?.let { Roster.chatOf(it, agents) }
                nav.open(
                    when {
                        chat == null -> "inbox"
                        chat == Primary.HANDLE -> "chat"
                        else -> Nav.agent(chat)
                    },
                )
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
            if (wide) {
                // The list as the sidebar: your agent's row opens its chat at the root, beside the list.
                HomeList(
                    app,
                    open = { address -> nav.open(if (address == "chat") Nav.ROOT else address) },
                    settings = { nav.open("settings") },
                    current = if (nav.top == Nav.ROOT) "chat" else nav.top,
                    modifier = Modifier.width(Space.sidebar).fillMaxHeight(),
                )
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
                    Page(app, nav, address, wide, roomy, give = { giving = true })
                }
            }
        }
        // While the node can't be reached: said over the page, with Retry (its live stream told it within seconds).
        ReachBanner(app, Modifier.align(Alignment.TopCenter))
    } }
    content()
    if (giving) GiveDialog(app) { giving = false }
}

private val DIGITS = listOf(Key.One, Key.Two, Key.Three, Key.Four, Key.Five, Key.Six, Key.Seven, Key.Eight, Key.Nine)

/** The page at an address. */
@Composable
private fun Page(app: AppModel, nav: Nav, address: String, wide: Boolean, roomy: Boolean, give: () -> Unit) {
    val back = { nav.back(); Unit }
    val inbox by app.inbox.collectAsState()
    val table by app.table.collectAsState()
    val (kind, rest) = address.substringBefore(':') to address.substringAfter(':', "")
    when (kind) {
        // The list (a phone's home); on a tablet, where the list is the sidebar, your agent's chat at the root.
        "list" -> if (wide) ChatScreen(app, back = back, roster = null, root = true, openTask = { nav.go(Nav.task(it)) }, give = give, go = { nav.go(it) })
        else HomeList(app, open = { nav.go(it) }, settings = { nav.go("settings") })
        "chat" -> ChatScreen(app, back = back, roster = null, root = false, openTask = { nav.go(Nav.task(it)) }, give = give, go = { nav.go(it) })
        "chats" -> Chats(app, close = back, opened = { if (nav.under == "chat" || (wide && nav.under == Nav.ROOT)) nav.back() else nav.replace("chat") })
        "task" -> TaskScreen(app, rest, nav, wide, roomy)
        "agent" -> AgentScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) }, go = { nav.go(it) })
        "room" -> RoomScreen(app, rest, back = back, openTask = { nav.go(Nav.task(it)) })
        "agents" -> AgentsScreen(app, back = back, openChat = { app.chat.fresh(); nav.go("chat") }, openAgent = { nav.go(Nav.agent(it)) }, openRoom = { nav.go(Nav.room(it)) })
        // (What Needs you was: your agent's chat, every ask at once over it.)
        "inbox" -> ChatScreen(app, back = back, roster = null, root = false, openTask = { nav.go(Nav.task(it)) }, give = give, go = { nav.go(it) }, waiting = true)
        "search" -> SearchScreen(app, nav, back = back)
        // (Its list at "settings"; each of its pages one tap deep, at "settings:<page>".)
        "settings" -> SettingsScreen(app, page = rest.ifEmpty { null }, open = { nav.go("settings:$it") }, openKeys = { nav.go("keys") }, openConnectors = { nav.go("connectors") }, back = back)
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
