package sh.invincible.bot.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.group
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/*
 * The app's few icons, drawn here (no icon library): 24 dp, one stroke 1.8 wide, tinted by where they're used.
 */

private fun icon(name: String, mirrored: Boolean = false, draw: ImageVector.Builder.() -> Unit): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f, autoMirror = mirrored).apply(draw).build()

private fun ImageVector.Builder.line(draw: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) =
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = draw)

/** Back: an arrow to the start (mirrored where text runs right to left). */
val BackIcon: ImageVector = icon("Back", mirrored = true) {
    line { moveTo(19f, 12f); lineTo(5f, 12f); moveTo(11f, 6f); lineTo(5f, 12f); lineTo(11f, 18f) }
}

/** Remove: a cross. */
val CloseIcon: ImageVector = icon("Close") {
    line { moveTo(6.5f, 6.5f); lineTo(17.5f, 17.5f); moveTo(17.5f, 6.5f); lineTo(6.5f, 17.5f) }
}

/** Search: a lens and its handle. */
val SearchIcon: ImageVector = icon("Search") {
    line { moveTo(4.5f, 10.5f); arcToRelative(6f, 6f, 0f, true, true, 12f, 0f); arcToRelative(6f, 6f, 0f, true, true, -12f, 0f); close(); moveTo(15f, 15f); lineTo(19.5f, 19.5f) }
}

/** A file carried by a message: a paperclip, three loops, at a slant. */
val AttachIcon: ImageVector = icon("Attach") {
    group(rotate = 40f, pivotX = 12f, pivotY = 12f) {
        line {
            moveTo(15.75f, 9f); lineTo(15.75f, 15.5f)
            arcTo(3.5f, 3.5f, 0f, false, true, 8.75f, 15.5f)
            lineTo(8.75f, 6f)
            arcTo(2.5f, 2.5f, 0f, false, true, 13.75f, 6f)
            lineTo(13.75f, 15f)
            arcTo(1.25f, 1.25f, 0f, false, true, 11.25f, 15f)
            lineTo(11.25f, 8.5f)
        }
    }
}

/** A step done: a check. */
val CheckIcon: ImageVector = icon("Done") {
    line { moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 7f) }
}

/** A step skipped: a dash. */
val DashIcon: ImageVector = icon("Skipped") {
    line { moveTo(7f, 12f); lineTo(17f, 12f) }
}

/** A step still to do: an empty ring. */
val RingIcon: ImageVector = icon("To do") {
    line { moveTo(6f, 12f); arcToRelative(6f, 6f, 0f, true, true, 12f, 0f); arcToRelative(6f, 6f, 0f, true, true, -12f, 0f); close() }
}

/** A step being done: a filled dot. */
val DotIcon: ImageVector = icon("Doing") {
    path(fill = SolidColor(Color.Black)) { moveTo(7.5f, 12f); arcToRelative(4.5f, 4.5f, 0f, true, true, 9f, 0f); arcToRelative(4.5f, 4.5f, 0f, true, true, -9f, 0f); close() }
}

/** A tray, for the Inbox. */
val TrayIcon: ImageVector = icon("Tray") {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f) {
        moveTo(3.5f, 13f); lineTo(6.5f, 5f); lineTo(17.5f, 5f); lineTo(20.5f, 13f); lineTo(20.5f, 19f); lineTo(3.5f, 19f); close()
        moveTo(3.5f, 13f); lineTo(8.5f, 13f); lineTo(9.5f, 15.5f); lineTo(14.5f, 15.5f); lineTo(15.5f, 13f); lineTo(20.5f, 13f)
    }
}

/** Three dots, for More. */
val MoreIcon: ImageVector = icon("More") {
    for (x in listOf(5f, 12f, 19f)) path(fill = SolidColor(Color.Black)) {
        moveTo(x - 1.8f, 12f); arcToRelative(1.8f, 1.8f, 0f, true, true, 3.6f, 0f); arcToRelative(1.8f, 1.8f, 0f, true, true, -3.6f, 0f); close()
    }
}

/** Add one: a plus. */
val PlusIcon: ImageVector = icon("Add") {
    line { moveTo(12f, 5f); lineTo(12f, 19f); moveTo(5f, 12f); lineTo(19f, 12f) }
}

/** When it looks again: a clock, its hands at ten past. */
val ClockIcon: ImageVector = icon("Clock") {
    line {
        moveTo(20.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 3.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 20.5f, 12f); close()
        moveTo(12f, 7.5f); lineTo(12f, 12f); lineTo(15f, 13.8f)
    }
}

/** Send: an arrow up, as the iPhone's message box has it. */
val SendIcon: ImageVector = icon("Send") {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 2.2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
        moveTo(12f, 19f); lineTo(12f, 5.5f); moveTo(6f, 11.5f); lineTo(12f, 5.5f); lineTo(18f, 11.5f)
    }
}

/** Stop its answer: a filled square, a little rounded. */
val StopIcon: ImageVector = icon("Stop") {
    path(fill = SolidColor(Color.Black)) {
        moveTo(8.5f, 7f); lineTo(15.5f, 7f); arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, 1.5f); lineTo(17f, 15.5f)
        arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, 1.5f); lineTo(8.5f, 17f); arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, -1.5f)
        lineTo(7f, 8.5f); arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, -1.5f); close()
    }
}

/** More, right: a chevron (mirrored where text runs right to left). */
val ChevronIcon: ImageVector = icon("Open", mirrored = true) {
    line { moveTo(9.5f, 6f); lineTo(15.5f, 12f); lineTo(9.5f, 18f) }
}

/** A task to give: three layers, stacked. */
val LayersIcon: ImageVector = icon("Give a task") {
    line {
        moveTo(12f, 4f); lineTo(20f, 8.5f); lineTo(12f, 13f); lineTo(4f, 8.5f); close()
        moveTo(4f, 12.5f); lineTo(12f, 17f); lineTo(20f, 12.5f)
        moveTo(4f, 16.25f); lineTo(12f, 20.75f); lineTo(20f, 16.25f)
    }
}

/** Its conversations: a speech bubble. */
val ChatsIcon: ImageVector = icon("Chats") {
    line {
        moveTo(5f, 5.5f); lineTo(19f, 5.5f); arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, 1.5f); lineTo(20.5f, 15f)
        arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, 1.5f); lineTo(10f, 16.5f); lineTo(6f, 20f); lineTo(6f, 16.5f); lineTo(5f, 16.5f)
        arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, -1.5f); lineTo(3.5f, 7f); arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, -1.5f); close()
    }
}

/** Keys: a key. */
val KeyIcon: ImageVector = icon("Keys") {
    line {
        moveTo(11f, 9.5f); arcTo(4f, 4f, 0f, true, true, 3f, 9.5f); arcTo(4f, 4f, 0f, true, true, 11f, 9.5f); close()
        moveTo(10f, 12f); lineTo(20f, 20f); moveTo(16.5f, 17.2f); lineTo(18.5f, 15f); moveTo(14f, 15.2f); lineTo(15.8f, 13.2f)
    }
}

/** Connectors: a plug. */
val PlugIcon: ImageVector = icon("Connectors") {
    line {
        moveTo(9f, 3.5f); lineTo(9f, 8f); moveTo(15f, 3.5f); lineTo(15f, 8f)
        moveTo(6f, 8f); lineTo(18f, 8f); lineTo(18f, 11f); arcTo(6f, 6f, 0f, false, true, 6f, 11f); close()
        moveTo(12f, 17f); lineTo(12f, 20.5f)
    }
}

/** Settings: a sun of a cog, eight teeth round a ring. */
val GearIcon: ImageVector = icon("Settings") {
    line {
        moveTo(15f, 12f); arcTo(3f, 3f, 0f, true, true, 9f, 12f); arcTo(3f, 3f, 0f, true, true, 15f, 12f); close()
        for (k in 0 until 8) {
            val a = Math.toRadians(k * 45.0)
            val (c, s) = Math.cos(a).toFloat() to Math.sin(a).toFloat()
            moveTo(12f + 6.2f * c, 12f + 6.2f * s); lineTo(12f + 8.6f * c, 12f + 8.6f * s)
        }
        moveTo(18.2f, 12f); arcTo(6.2f, 6.2f, 0f, true, true, 5.8f, 12f); arcTo(6.2f, 6.2f, 0f, true, true, 18.2f, 12f); close()
    }
}

/** A command run: a terminal's prompt. */
val TerminalIcon: ImageVector = icon("Terminal") {
    line {
        moveTo(4.5f, 5f); lineTo(19.5f, 5f); lineTo(19.5f, 19f); lineTo(4.5f, 19f); close()
        moveTo(8f, 9.5f); lineTo(10.5f, 12f); lineTo(8f, 14.5f); moveTo(12.5f, 15f); lineTo(16f, 15f)
    }
}

/** A file read. */
val FileIcon: ImageVector = icon("File") {
    line {
        moveTo(6.5f, 3.5f); lineTo(13.5f, 3.5f); lineTo(18.5f, 8.5f); lineTo(18.5f, 20.5f); lineTo(6.5f, 20.5f); close()
        moveTo(13.5f, 3.5f); lineTo(13.5f, 8.5f); lineTo(18.5f, 8.5f)
    }
}

/** A file edited: a pencil. */
val EditIcon: ImageVector = icon("Edit") {
    line {
        moveTo(15.5f, 4.5f); lineTo(19.5f, 8.5f); lineTo(8.5f, 19.5f); lineTo(4.5f, 19.5f); lineTo(4.5f, 15.5f); close()
        moveTo(13f, 7f); lineTo(17f, 11f)
    }
}

/** Submitted for its gates and review: a shield with a check. */
val ShieldIcon: ImageVector = icon("Proof") {
    line {
        moveTo(12f, 3.5f); lineTo(19f, 6f); lineTo(19f, 11.5f); curveTo(19f, 16f, 16f, 19f, 12f, 20.5f); curveTo(8f, 19f, 5f, 16f, 5f, 11.5f); lineTo(5f, 6f); close()
        moveTo(9f, 12f); lineTo(11.2f, 14.2f); lineTo(15.2f, 10f)
    }
}

/** A warning: a triangle with a stroke. */
val AlertIcon: ImageVector = icon("Warning") {
    line {
        moveTo(12f, 4f); lineTo(21f, 19.5f); lineTo(3f, 19.5f); close()
        moveTo(12f, 10f); lineTo(12f, 14f); moveTo(12f, 16.8f); lineTo(12f, 17f)
    }
}

/** A note: an i in a ring. */
val InfoIcon: ImageVector = icon("Note") {
    line {
        moveTo(20.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 3.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 20.5f, 12f); close()
        moveTo(12f, 11f); lineTo(12f, 16.5f); moveTo(12f, 7.8f); lineTo(12f, 8f)
    }
}

/** A plan: lines of a list. */
val PlanIcon: ImageVector = icon("Plan") {
    line { moveTo(9f, 7f); lineTo(19f, 7f); moveTo(9f, 12f); lineTo(19f, 12f); moveTo(9f, 17f); lineTo(16f, 17f); moveTo(5f, 7f); lineTo(5.1f, 7f); moveTo(5f, 12f); lineTo(5.1f, 12f); moveTo(5f, 17f); lineTo(5.1f, 17f) }
}

/** The reviewer: an eye. */
val ReviewIcon: ImageVector = icon("Review") {
    line {
        moveTo(2.5f, 12f); curveTo(5f, 7.5f, 8.5f, 5.5f, 12f, 5.5f); curveTo(15.5f, 5.5f, 19f, 7.5f, 21.5f, 12f); curveTo(19f, 16.5f, 15.5f, 18.5f, 12f, 18.5f); curveTo(8.5f, 18.5f, 5f, 16.5f, 2.5f, 12f); close()
        moveTo(14.75f, 12f); arcTo(2.75f, 2.75f, 0f, true, true, 9.25f, 12f); arcTo(2.75f, 2.75f, 0f, true, true, 14.75f, 12f); close()
    }
}

/** An agent's VM: a screen on a stand. */
val MonitorIcon: ImageVector = icon("Its VM") {
    line { moveTo(3.5f, 5f); lineTo(20.5f, 5f); lineTo(20.5f, 16f); lineTo(3.5f, 16f); close(); moveTo(9f, 20f); lineTo(15f, 20f); moveTo(12f, 16f); lineTo(12f, 20f) }
}

/** A branch, and changes: angle brackets. */
val CodeIcon: ImageVector = icon("Code") {
    line { moveTo(8.5f, 7f); lineTo(3.5f, 12f); lineTo(8.5f, 17f); moveTo(15.5f, 7f); lineTo(20.5f, 12f); lineTo(15.5f, 17f) }
}

/** Out to where it is: an arrow leaving a box. */
val ExternalIcon: ImageVector = icon("Open elsewhere") {
    line { moveTo(13.5f, 4.5f); lineTo(19.5f, 4.5f); lineTo(19.5f, 10.5f); moveTo(19.5f, 4.5f); lineTo(11f, 13f); moveTo(17f, 14f); lineTo(17f, 19.5f); lineTo(4.5f, 19.5f); lineTo(4.5f, 7f); lineTo(10f, 7f) }
}

/** The details beside a thread: a panel. */
val PanelIcon: ImageVector = icon("Details") {
    line { moveTo(4f, 5f); lineTo(20f, 5f); lineTo(20f, 19f); lineTo(4f, 19f); close(); moveTo(14.5f, 5f); lineTo(14.5f, 19f) }
}

/** A newer build to take: an arrow down onto a line. */
val UpdateIcon: ImageVector = icon("Update") {
    line { moveTo(12f, 4.5f); lineTo(12f, 15f); moveTo(7.5f, 10.5f); lineTo(12f, 15f); lineTo(16.5f, 10.5f); moveTo(5f, 19.5f); lineTo(19f, 19.5f) }
}

/** Again: a turning arrow. */
val RetryIcon: ImageVector = icon("Again") {
    line { moveTo(19.5f, 12f); arcTo(7.5f, 7.5f, 0f, true, true, 17.3f, 6.7f); moveTo(19.5f, 4f); lineTo(19.5f, 8.5f); lineTo(15f, 8.5f) }
}

/** A gate running: a play mark. */
val PlayIcon: ImageVector = icon("Running") {
    path(fill = SolidColor(Color.Black)) { moveTo(8f, 5.5f); lineTo(18.5f, 12f); lineTo(8f, 18.5f); close() }
}

/** A gate failed: a cross, bolder than Close. */
val CrossIcon: ImageVector = icon("Failed") {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 2.4f, strokeLineCap = StrokeCap.Round) { moveTo(7f, 7f); lineTo(17f, 17f); moveTo(17f, 7f); lineTo(7f, 17f) }
}

/** The primary's own conversation, a new one: a pencil on a page's corner (T3's "new"). */
val ComposeIcon: ImageVector = icon("New") {
    line {
        moveTo(11f, 4.5f); lineTo(5.5f, 4.5f); lineTo(5.5f, 18.5f); lineTo(19.5f, 18.5f); lineTo(19.5f, 13f)
        moveTo(17f, 3.5f); lineTo(20.5f, 7f); lineTo(13f, 14.5f); lineTo(9.5f, 14.5f); lineTo(9.5f, 11f); close()
    }
}

/** The agents: two people, one before the other (the iPhone's person.3, in this set's line). */
val agentsIcon: ImageVector = icon("Agents") {
    line {
        // The one in front: a head, and its shoulders.
        moveTo(6f, 9f); arcToRelative(3.2f, 3.2f, 0f, true, true, 6.4f, 0f); arcToRelative(3.2f, 3.2f, 0f, true, true, -6.4f, 0f); close()
        moveTo(3.5f, 19.5f); curveTo(3.5f, 15.9f, 6f, 14f, 9.2f, 14f); curveTo(12.4f, 14f, 14.9f, 15.9f, 14.9f, 19.5f)
        // The one behind: its head, and its shoulder past the first's.
        moveTo(14.2f, 5.9f); arcToRelative(3f, 3f, 0f, true, true, 1.6f, 5.9f)
        moveTo(17.4f, 14.2f); curveTo(19.4f, 14.8f, 20.5f, 16.6f, 20.5f, 19.5f)
    }
}

/** Notifications: a bell, and its clapper under it. */
val BellIcon: ImageVector = icon("Notifications") {
    line {
        moveTo(6f, 16.5f); lineTo(6f, 11f); curveTo(6f, 7.4f, 8.6f, 4.8f, 12f, 4.8f); curveTo(15.4f, 4.8f, 18f, 7.4f, 18f, 11f); lineTo(18f, 16.5f); lineTo(19.5f, 18f); lineTo(4.5f, 18f); close()
        moveTo(10f, 20.5f); lineTo(14f, 20.5f)
    }
}

/** Appearance: a ring, its one half filled (light and dark). */
val ContrastIcon: ImageVector = icon("Appearance") {
    line { moveTo(20.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 3.5f, 12f); arcTo(8.5f, 8.5f, 0f, true, true, 20.5f, 12f); close() }
    path(fill = SolidColor(Color.Black)) { moveTo(12f, 3.5f); arcTo(8.5f, 8.5f, 0f, false, true, 12f, 20.5f); close() }
}

/** This device: a phone, and its one button. */
val PhoneIcon: ImageVector = icon("This device") {
    line {
        moveTo(8.5f, 3f); lineTo(15.5f, 3f); curveTo(16.6f, 3f, 17.5f, 3.9f, 17.5f, 5f); lineTo(17.5f, 19f); curveTo(17.5f, 20.1f, 16.6f, 21f, 15.5f, 21f); lineTo(8.5f, 21f); curveTo(7.4f, 21f, 6.5f, 20.1f, 6.5f, 19f); lineTo(6.5f, 5f); curveTo(6.5f, 3.9f, 7.4f, 3f, 8.5f, 3f); close()
        moveTo(11f, 18f); lineTo(13f, 18f)
    }
}

/** Providers: a chip, its pins on each side. */
val ChipIcon: ImageVector = icon("Providers") {
    line {
        moveTo(7f, 7f); lineTo(17f, 7f); lineTo(17f, 17f); lineTo(7f, 17f); close()
        moveTo(10f, 10f); lineTo(14f, 10f); lineTo(14f, 14f); lineTo(10f, 14f); close()
        moveTo(10f, 3.5f); lineTo(10f, 7f); moveTo(14f, 3.5f); lineTo(14f, 7f); moveTo(10f, 17f); lineTo(10f, 20.5f); moveTo(14f, 17f); lineTo(14f, 20.5f)
        moveTo(3.5f, 10f); lineTo(7f, 10f); moveTo(3.5f, 14f); lineTo(7f, 14f); moveTo(17f, 10f); lineTo(20.5f, 10f); moveTo(17f, 14f); lineTo(20.5f, 14f)
    }
}
