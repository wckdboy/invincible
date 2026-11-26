package sh.invincible.bot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.AgentMark
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError

/**
 * An agent's colour, as you choose it (the PWA's avatarEditor): its mark as it will be, the eight colours of the Grille to
 * choose from, each by its name, and "The node's choice". Nothing is saved until you touch it: then Save sends its mark
 * with the colour you chose and its form kept (`{ "v": 3, "color", "form" }`), or null, which asks the node for the one it
 * would give now; Cancel leaves what is saved as it was. The node takes the agent's name and its avatar alone.
 */
@Composable
fun ColourDialog(app: AppModel, id: String, name: String, profile: Json?, done: () -> Unit) {
    val mark = remember(id, profile) { AgentMark.markOf(id, profile) }
    var chosen by remember(id) { mutableStateOf<Int?>(mark.color) }
    var touched by remember(id) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current
    val dark = brand.paper.luminance() < 0.5f
    val shown = chosen?.let { AgentMark.markProfile(mark.copy(color = it)) }
    val choose = { color: Int? ->
        chosen = color
        touched = true
    }
    AlertDialog(
        onDismissRequest = done,
        title = { Text("$name's colour") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s4)) {
                    AgentMarkView(id, shown ?: profile, 96.dp, description = "$name's mark")
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Text(
                            if (chosen != null) "${AgentMark.PALETTE[chosen!!].name}, the same on every device." else "The node gives it a colour no other agent has, while one is free.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { choose(null) }) { Text("The node's choice") }
                    }
                }
                FlowRow(Modifier.selectableGroup()) {
                    AgentMark.PALETTE.forEachIndexed { n, hue ->
                        val picked = chosen == n
                        Box(
                            Modifier
                                .size(Space.touch)
                                .selectable(selected = picked, role = Role.RadioButton, onClick = { choose(n) })
                                .semantics { contentDescription = hue.name },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier.size(40.dp).then(if (picked) Modifier.border(2.dp, brand.ink, CircleShape) else Modifier),
                                contentAlignment = Alignment.Center,
                            ) { Box(Modifier.size(32.dp).clip(CircleShape).background(Color(0xff000000 or (if (dark) hue.dark else hue.light).substring(1).toLong(16)))) }
                        }
                    }
                }
                problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.danger) }
            }
        },
        confirmButton = {
            TextButton(enabled = touched && !saving, onClick = {
                saving = true
                scope.launch {
                    try {
                        app.client?.post("/api/team/agents", Json.obj("id" to id, "name" to name, "avatar" to (shown ?: Json.Null)))
                        app.refresh()
                        done()
                    } catch (e: NodeError) {
                        problem = e.message
                    } finally {
                        saving = false
                    }
                }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = done) { Text("Cancel") } },
    )
}
