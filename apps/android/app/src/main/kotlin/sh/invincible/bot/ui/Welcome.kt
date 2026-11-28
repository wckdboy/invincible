package sh.invincible.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.RelativeTime
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.int
import sh.invincible.bot.core.long
import sh.invincible.bot.core.string
import java.time.ZoneId
import java.util.Locale

/*
 * A new chat's welcome, as the web's (views/chat.ts emptyState and recentChats): your agent's mark, large; "At your
 * service." and what it does; what you might ask it first, as pills; then your recent chats, each a tap away, and All
 * chats. What happened while you were away stays as the chat draws it, under them.
 */

/** Your recent chats on a new chat's welcome: your latest kept chats, four at most, as the node lists them (the latest first). */
internal fun recentChats(kept: List<Json>): List<Json> = kept.take(4)

/**
 * A recent chat's line, in the web's words (chatRow): how many messages it holds and when it last moved ("2 messages · just
 * now"). The web names its project first, from the projects it reads; a phone doesn't read them, so it leaves that out.
 */
internal fun recentLine(c: Json, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    listOfNotNull(
        c["count"].int?.let { "$it message${if (it == 1) "" else "s"}" },
        c["updatedAt"].long?.let { RelativeTime.of(it, now, zone, locale) },
    ).joinToString(" · ")

/** The welcome's head: your agent's mark, large and centred (in pearl where this phone is set so), "At your service." and the web's line. */
@Composable
internal fun WelcomeHero() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s6, bottom = Space.s3),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        PrimaryMark(96.dp)
        Text("At your service.", style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold), textAlign = TextAlign.Center, modifier = Modifier.padding(top = Space.s3))
        Text(
            "Ask anything. Your agent recalls what your fleet remembers, and uses its tools. Keys belong in the vault, never here.",
            style = Type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/** What you might ask it first, centred, as pills (the answers' look): a press puts its words in the message box. */
@Composable
internal fun WelcomeAsks(asks: List<Pair<String, String>>, ask: (String) -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = Space.margin, vertical = Space.s2),
        horizontalArrangement = Arrangement.spacedBy(Space.s2, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(Space.s2),
    ) {
        for ((label, words) in asks) Pill(label, { ask(words) })
    }
}

/** Your recent chats under the welcome: "Recent", four at most, each its title (a dot where an answer in it is new to you) and its line, opening it; then All chats. */
@Composable
internal fun RecentChatsList(chats: List<Json>, open: (String) -> Unit, all: () -> Unit) {
    val recent = recentChats(chats)
    if (recent.isEmpty()) return
    val brand = LocalBrand.current
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    val now = remember(chats) { System.currentTimeMillis() }
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.margin).padding(top = Space.s4), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        Text("Recent", style = Type.meta, color = quiet)
        Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(brand.raised)) {
            recent.forEachIndexed { i, c ->
                if (i > 0) Hairline(inset = Space.s3)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = Space.touch)
                        .clickable(role = Role.Button) { c["id"].string?.let(open) }
                        .padding(horizontal = Space.s3, vertical = Space.s2),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.s3),
                ) {
                    Box(Modifier.size(32.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface), contentAlignment = Alignment.Center) {
                        Icon(ChatsIcon, null, Modifier.size(16.dp), tint = quiet)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (c["unread"].bool == true) Dot(brand.done)
                            Text(c["title"].string ?: "A chat", style = Type.rowTitle.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        recentLine(c, now).takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.meta, color = quiet, maxLines = 1) }
                    }
                }
            }
        }
        TextButton(onClick = all, modifier = Modifier.align(Alignment.CenterHorizontally).heightIn(min = Space.touch)) {
            Icon(ClockIcon, null, Modifier.size(16.dp), tint = quiet)
            Text("All chats", style = Type.meta, color = quiet, modifier = Modifier.padding(start = 6.dp))
        }
    }
}
