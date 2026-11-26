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
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.Avatar
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.AgentState
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Orb
import sh.invincible.bot.core.OrbMotion

/**
 * An agent's colour, as you choose it (the PWA's avatarEditor): its orb as it will be, the 24 colours to choose from, each
 * by its name, and the one its handle gives it. Nothing is saved until you touch it: then Save sends the colour you
 * chose (`{ "v": 2, "color" }`) or, for its handle's colour, null; Cancel leaves what is saved as it was. The node takes
 * the agent's name and its avatar alone, and keeps everything else about it as it was.
 */
@Composable
fun ColourDialog(app: AppModel, id: String, name: String, profile: Json?, done: () -> Unit) {
    var chosen by remember(id) { mutableStateOf(Avatar.chosen(profile)) }
    var touched by remember(id) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current
    val shown = chosen?.let(Avatar::orbProfile)
    val handles = Avatar.AGENT_TINT_NAMES.getOrNull(Avatar.AGENT_TINTS.indexOf(Avatar.agentColors(id).tint)) ?: "this colour"
    val choose = { color: String? ->
        chosen = color
        touched = true
    }
    AlertDialog(
        onDismissRequest = done,
        title = { Text("$name's colour") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s4)) {
                    AgentOrb(id, shown, 96.dp, OrbMotion.moodOfExpression("idle"), "$name's orb", key = "face:$id")
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Text(
                            if (chosen != null) "The colour you chose." else "Its handle gives it $handles, the same on every device, until you choose one.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { choose(null) }) { Text("Its handle's colour") }
                    }
                }
                FlowRow(Modifier.selectableGroup()) {
                    Avatar.AGENT_TINTS.forEachIndexed { n, tint ->
                        val picked = chosen == tint
                        Box(
                            Modifier
                                .size(Space.touch)
                                .selectable(selected = picked, role = Role.RadioButton, onClick = { choose(tint) })
                                .semantics { contentDescription = Avatar.AGENT_TINT_NAMES[n] },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier.size(40.dp).then(if (picked) Modifier.border(2.dp, brand.ink, CircleShape) else Modifier),
                                contentAlignment = Alignment.Center,
                            ) { Box(Modifier.size(32.dp).clip(CircleShape).background(Color(0xff000000 or Avatar.rgb(tint)))) }
                        }
                    }
                }
                problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = brand.failed) }
            }
        },
        confirmButton = {
            TextButton(enabled = touched && !saving, onClick = {
                saving = true
                scope.launch {
                    try {
                        app.client?.post("/api/team/agents", Json.obj("id" to id, "name" to name, "avatar" to Avatar.edited(chosen, touched)))
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
