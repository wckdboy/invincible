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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.Brush
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
import sh.invincible.bot.core.Glass
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError

/**
 * An agent's glass, as you choose it (the PWA's avatarEditor): it as it will be, the eight colours (its ramps) and the 22
 * shapes to choose from, each by its name, and "The node's choice". Nothing is saved until you touch it: then Save sends
 * its glass with what you chose and the rest as it is (`{ "v": 4, "color", "shape" }`), or null, which asks the node for
 * the one it would give now; Cancel leaves what is saved as it was. The node takes the agent's name and its avatar alone.
 */
@Composable
fun GlassDialog(app: AppModel, id: String, name: String, profile: Json?, done: () -> Unit) {
    val now = remember(id, profile) { Glass.of(id, profile) }
    // (What the node would give it now: after the glass the others wear, as the node reckons it.)
    val others = app.table.value.snapshot?.agents.orEmpty().filter { it.id != id }.map { Glass.of(it.id, it.avatar) }
    var chosenColor by remember(id) { mutableStateOf<Int?>(null) }
    var chosenShape by remember(id) { mutableStateOf<Int?>(null) }
    var touched by remember(id) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current
    val dark = brand.paper.luminance() < 0.5f
    val nodes = !touched || (chosenColor == null && chosenShape == null)
    val shown = when {
        !touched -> now
        chosenColor == null && chosenShape == null -> Glass.assign(id, others)
        else -> Glass(chosenColor ?: now.color, chosenShape ?: now.shape)
    }
    val choose = { color: Int?, shape: Int? ->
        if (color == null && shape == null) {
            chosenColor = null
            chosenShape = null
        } else {
            chosenColor = color ?: chosenColor ?: shown.color
            chosenShape = shape ?: chosenShape ?: shown.shape
        }
        touched = true
    }
    AlertDialog(
        onDismissRequest = done,
        title = { Text("$name's glass") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s4)) {
                    GlassMark(shown, 96.dp, description = "$name's glass")
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Text(
                            when {
                                touched && !nodes -> "${AgentMark.PALETTE[shown.color].name}, ${Glass.SHAPES[shown.shape].name}: as you chose, the same on every device."
                                !touched -> "The glass its node gave it. Choose a colour or a shape, and the other stays as it is."
                                else -> "The node gives it a colour and a shape no agent near it has, while there are some to go round."
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { choose(null, null) }) { Text("The node's choice") }
                    }
                }
                FlowRow(Modifier.selectableGroup()) {
                    Glass.RAMPS.forEachIndexed { n, ramp ->
                        val picked = shown.color == n
                        val stops = ramp.on(dark)
                        Box(
                            Modifier
                                .size(Space.touch)
                                .selectable(selected = picked, role = Role.RadioButton, onClick = { choose(n, null) })
                                .semantics { contentDescription = AgentMark.PALETTE[n].name },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier.size(40.dp).then(if (picked) Modifier.border(2.dp, brand.ink, CircleShape) else Modifier),
                                contentAlignment = Alignment.Center,
                            ) { Box(Modifier.size(32.dp).clip(CircleShape).background(Brush.linearGradient(listOf(Color(hex(stops.a)), Color(hex(stops.b)))))) }
                        }
                    }
                }
                FlowRow(Modifier.selectableGroup()) {
                    Glass.SHAPES.forEachIndexed { n, shape ->
                        val picked = shown.shape == n
                        Box(
                            Modifier
                                .size(Space.touch)
                                .then(if (picked) Modifier.border(2.dp, brand.ink, RoundedCornerShape(10.dp)) else Modifier)
                                .selectable(selected = picked, role = Role.RadioButton, onClick = { choose(null, n) })
                                .semantics { contentDescription = shape.name },
                            contentAlignment = Alignment.Center,
                        ) { GlassMark(Glass(shown.color, n), 28.dp) }
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
                        app.client?.post("/api/team/agents", Json.obj("id" to id, "name" to name, "avatar" to (if (nodes) Json.Null else Glass.profile(shown))))
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
