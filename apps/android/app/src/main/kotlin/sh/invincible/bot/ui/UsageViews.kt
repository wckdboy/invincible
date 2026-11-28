package sh.invincible.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.Usage
import sh.invincible.bot.core.UsageMeter

/*
 * The usage meter (the iPhone's UsageMeterView): this period's model calls at your prices against your budget, as a line
 * and a thin bar that stand still among the agents's head, a coding plan whose allowance is spent under it; tapped, what
 * they came to, what cost most, and your budget to set.
 */

/** The meter's line and bar: in the ink while there's budget left, in its red once it's spent. */
@Composable
fun UsageLine(m: UsageMeter, onClick: () -> Unit) {
    val brand = LocalBrand.current
    val spent = m.budgetUsd != null && (m.leftUsd ?: 0.0) <= 0
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) { role = Role.Button }
            .padding(horizontal = Space.margin, vertical = Space.s2),
        verticalArrangement = Arrangement.spacedBy(Space.s1),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(Usage.period(m), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(Usage.line(m), style = MaterialTheme.typography.labelMedium, color = if (spent) brand.failed else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Usage.share(m)?.let { UsageBar(it, spent) }
        // A plan passed over until its allowance resets: why an agent's work is on another model meanwhile.
        m.windows.forEach { Text(Usage.window(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A thin bar, filled as far as the budget is spent. */
@Composable
private fun UsageBar(share: Double, spent: Boolean) {
    val brand = LocalBrand.current
    Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)) {
        Box(Modifier.fillMaxWidth(share.toFloat().coerceIn(if (share > 0) 0.02f else 0f, 1f)).fillMaxHeight().clip(CircleShape).background(if (spent) brand.failed else brand.ink))
    }
}

/** What this period's calls came to: the figure large, what cost most, models with no price, plans spent, your budget. */
@Composable
fun UsageDialog(app: AppModel, m: UsageMeter, close: () -> Unit) {
    var per by remember { mutableStateOf(if (m.per == "day") "day" else "month") }
    var amount by remember { mutableStateOf(m.budgetUsd?.let { String.format(java.util.Locale.US, if (it < 10) "%.2f" else "%.0f", it) } ?: "") }
    var problem by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Usage") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.s3)) {
                Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                    Text(Usage.spentWords(m.spentUsd, m.complete, m.atMost), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                    Text(Usage.subline(m), style = MaterialTheme.typography.bodyMedium, color = quiet)
                    Usage.share(m)?.let { UsageBar(it, (m.leftUsd ?: 0.0) <= 0) }
                    Text("Since ${m.since} (UTC), on this node, at the prices you've set. ${Usage.tokens(m.tokens)} tokens in ${m.calls} call${if (m.calls == 1L) "" else "s"}.", style = MaterialTheme.typography.bodySmall, color = quiet)
                }
                if (m.top.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Text("What cost most", style = MaterialTheme.typography.labelLarge)
                        m.top.forEach { top ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(top.model, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
                                Text(top.usd?.let(Usage::money) ?: "${Usage.tokens(top.tokens)} tokens", style = MaterialTheme.typography.bodySmall, color = quiet, modifier = Modifier.padding(start = Space.s2))
                            }
                        }
                    }
                }
                if (m.windows.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Text("Passed over until their allowance resets", style = MaterialTheme.typography.labelLarge)
                        m.windows.forEach { w ->
                            Text(Usage.window(w), style = MaterialTheme.typography.bodyMedium)
                            Text(w.said, style = MaterialTheme.typography.bodySmall, color = quiet, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                        Text("Their models are skipped without asking until then, and the next on each role's list answers.", style = MaterialTheme.typography.bodySmall, color = quiet)
                    }
                }
                if (m.unpriced.isNotEmpty()) {
                    Text("No price for ${m.unpriced.joinToString(", ")}: ${if (m.unpriced.size == 1) "its" else "their"} tokens aren't in this. Set one with invincible price set.", style = MaterialTheme.typography.bodySmall, color = quiet)
                }
                Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
                    Text("Your budget", style = MaterialTheme.typography.labelLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                        FilterChip(selected = per == "day", onClick = { per = "day" }, label = { Text("Day") })
                        FilterChip(selected = per == "month", onClick = { per = "month" }, label = { Text("Month") })
                    }
                    OutlinedTextField(
                        value = amount,
                        onValueChange = { amount = it },
                        label = { Text("US dollars") },
                        placeholder = { Text("No budget") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("A line to watch, never a stop: work goes on past it. A task's own budget is what stops a task.", style = MaterialTheme.typography.bodySmall, color = quiet)
                    problem?.let { Text(it, color = LocalBrand.current.failed, style = MaterialTheme.typography.bodySmall) }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !saving, onClick = {
                val typed = Usage.budgetTyped(amount)
                typed.exceptionOrNull()?.let {
                    problem = it.message
                    return@TextButton
                }
                saving = true
                scope.launch {
                    try {
                        app.setBudget(typed.getOrNull(), per)
                        close()
                    } catch (e: NodeError) {
                        problem = e.message
                    } finally {
                        saving = false
                    }
                }
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = close) { Text("Close") } },
    )
}
