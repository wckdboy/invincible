@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import sh.invincible.bot.core.Blocks

/*
 * Its answer blocks, drawn: a chart, figures, a plan's steps, choices to tap and a page. Nothing moves by itself; a
 * chart is still, as every state here is. Each says what it shows to a screen reader in words, not only in colour.
 */

/** Series colours, in a fixed order, apart from the four state colours (a series is no state). */
@Composable
private fun palette(): List<Color> = if (isSystemInDarkTheme()) {
    listOf(Color(0xFF7AA7FF), Color(0xFFF2A65A), Color(0xFF46C2B0), Color(0xFFB39BFF), Color(0xFFF07FB0), Color(0xFFA4ACB8))
} else {
    listOf(Color(0xFF2F64D0), Color(0xFFC8661A), Color(0xFF0F7F73), Color(0xFF7048CF), Color(0xFFB8336F), Color(0xFF59616E))
}

/** A unit joined to a figure as the PWA joins it: %, ° and ‰ close up, any other after a space. */
private fun withUnit(text: String, unit: String?): String = if (unit == null) text else if (unit in setOf("%", "°", "‰")) "$text$unit" else "$text $unit"

/** Clean round ticks over [lo, hi] (the PWA's niceTicks). */
fun niceTicks(lo0: Double, hi0: Double, count: Int = 4): List<Double> {
    var lo = lo0
    var hi = hi0
    if (lo == hi) { if (lo == 0.0) { lo = 0.0; hi = 1.0 } else { lo = minOf(0.0, lo); hi = maxOf(0.0, hi) } }
    val rough = (hi - lo) / count
    val magnitude = Math.pow(10.0, Math.floor(Math.log10(rough)))
    val step = magnitude * (listOf(1.0, 2.0, 2.5, 5.0, 10.0).firstOrNull { rough / magnitude <= it } ?: 10.0)
    val ticks = ArrayList<Double>()
    var v = Math.floor(lo / step) * step
    while (v <= hi + step * 1e-9) {
        ticks += String.format(java.util.Locale.US, "%.12g", v).toDouble()
        v += step
    }
    if (ticks.last() < hi) ticks += ticks.last() + step
    return ticks
}

@Composable
fun ChartBlock(c: Blocks.Chart) {
    val brand = LocalBrand.current
    val colors = palette()
    val measurer = rememberTextMeasurer()
    val bars = c.type == "bar" || c.type == "stacked"
    val n = c.labels.size
    val values = if (c.type == "stacked") (0 until n).map { i -> c.series.sumOf { it.second[i] ?: 0.0 } } else c.series.flatMap { s -> s.second.filterNotNull() }
    var lo = values.minOrNull() ?: 0.0
    var hi = values.maxOrNull() ?: 1.0
    if (c.type != "line") { lo = minOf(0.0, lo); hi = maxOf(0.0, hi) } else if (lo > 0 && lo / hi < 0.35) lo = 0.0
    val ticks = niceTicks(lo, hi)
    val bottom = ticks.first()
    val top = ticks.last()
    val tickStyle = TextStyle(fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    val said = "${c.type} chart${c.title?.let { ": $it" } ?: ""}. " + c.series.joinToString(". ") { (name, vs) ->
        "$name: " + c.labels.indices.joinToString(", ") { i -> "${c.labels[i]} ${vs[i]?.let { withUnit(Blocks.compactNumber(it), c.unit) } ?: "no value"}" }
    }
    Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(brand.raised).padding(Space.s3), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        c.title?.let { Text(it, style = MaterialTheme.typography.titleSmallEmphasized) }
        if (c.series.size > 1) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                c.series.forEachIndexed { i, (name, _) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.s1)) {
                        Dot(colors[i % colors.size])
                        Text(name, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
        Canvas(Modifier.fillMaxWidth().height(180.dp).semantics { contentDescription = said }) {
            val labelWidth = ticks.maxOf { measurer.measure(withUnit(Blocks.compactNumber(it), c.unit), tickStyle).size.width }.toFloat() + 8.dp.toPx()
            val plot = Size(size.width - labelWidth, size.height - 20.dp.toPx())
            fun y(v: Double) = (plot.height * (1 - (v - bottom) / (top - bottom))).toFloat()
            for (t in ticks) {
                val ty = y(t)
                drawLine(brand.line, Offset(labelWidth, ty), Offset(size.width, ty), strokeWidth = 1.dp.toPx())
                val text = measurer.measure(withUnit(Blocks.compactNumber(t), c.unit), tickStyle)
                drawText(text, topLeft = Offset(0f, (ty - text.size.height / 2f).coerceIn(0f, maxOf(0f, size.height - text.size.height))))
            }
            val slot = plot.width / n
            // The labels along the foot: as many as fit, evenly spread.
            val every = maxOf(1, Math.ceil(n / 6.0).toInt())
            for (i in 0 until n step every) {
                val text = measurer.measure(c.labels[i], tickStyle)
                val cx = if (bars || n == 1) labelWidth + slot * (i + 0.5f) else labelWidth + plot.width * i / (n - 1)
                drawText(text, topLeft = Offset((cx - text.size.width / 2f).coerceIn(labelWidth, maxOf(labelWidth, size.width - text.size.width)), plot.height + 4.dp.toPx()))
            }
            if (bars) {
                val group = slot * 0.7f
                for (i in 0 until n) {
                    var stack = 0.0
                    c.series.forEachIndexed { s, (_, vs) ->
                        val v = vs[i] ?: return@forEachIndexed
                        val color = colors[s % colors.size]
                        if (c.type == "stacked") {
                            val from = y(stack)
                            stack += v
                            drawRect(color, Offset(labelWidth + slot * i + (slot - group) / 2, y(stack)), Size(group, from - y(stack)))
                        } else {
                            val w = group / c.series.size
                            val base = y(maxOf(bottom, 0.0))
                            val at = y(v)
                            drawRect(color, Offset(labelWidth + slot * i + (slot - group) / 2 + w * s, minOf(at, base)), Size(w * 0.86f, Math.abs(base - at)))
                        }
                    }
                }
            } else {
                c.series.forEachIndexed { s, (_, vs) ->
                    val color = colors[s % colors.size]
                    fun x(i: Int) = if (n == 1) labelWidth + plot.width / 2 else labelWidth + plot.width * i / (n - 1)
                    var path: Path? = null
                    var start = 0
                    fun close(end: Int) {
                        val p = path ?: return
                        if (c.type == "area") {
                            val fill = Path().apply { addPath(p); lineTo(x(end), y(maxOf(bottom, 0.0))); lineTo(x(start), y(maxOf(bottom, 0.0))); close() }
                            drawPath(fill, color.copy(alpha = 0.18f))
                        }
                        drawPath(p, color, style = Stroke(width = 2.dp.toPx()))
                        path = null
                    }
                    for (i in 0 until n) {
                        val v = vs[i]
                        if (v == null) { close(i - 1); continue }
                        if (path == null) { path = Path().apply { moveTo(x(i), y(v)) }; start = i } else path!!.lineTo(x(i), y(v))
                        drawCircle(color, 3.dp.toPx(), Offset(x(i), y(v)))
                    }
                    close(n - 1)
                }
            }
        }
    }
}

@Composable
fun StatsBlock(stats: List<Blocks.Stat>) {
    val brand = LocalBrand.current
    Column(verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        for (pair in stats.chunked(2)) Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            for (s in pair) {
                val shown = s.number?.let { Blocks.compactNumber(it) } ?: s.text ?: ""
                val delta = s.delta
                val good = if (delta == null || delta == 0.0 || s.good == null) null else (delta > 0) == (s.good == "up")
                Column(Modifier.weight(1f).clip(MaterialTheme.shapes.medium).background(brand.raised).padding(Space.s3), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(s.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(if (s.number != null) withUnit(shown, s.unit) else shown, style = MaterialTheme.typography.headlineSmallEmphasized)
                    if (delta != null) {
                        val sign = if (delta > 0) "+" else if (delta < 0) "−" else "±"
                        val arrow = if (delta > 0) "↑ " else if (delta < 0) "↓ " else ""
                        val change = "$sign${withUnit(Blocks.compactNumber(Math.abs(delta)), s.unit)}${s.note?.let { " $it" } ?: ""}"
                        // (Whether the change is good is said in words to a screen reader, as the PWA says it: never colour alone.)
                        Text(
                            "$arrow$change",
                            style = MaterialTheme.typography.bodySmall,
                            color = when (good) { true -> brand.done; false -> brand.failed; null -> MaterialTheme.colorScheme.onSurfaceVariant },
                            modifier = Modifier.semantics { contentDescription = change + when (good) { true -> " (good)"; false -> " (not good)"; null -> "" } },
                        )
                    } else s.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            if (pair.size == 1) Spacer(Modifier.weight(1f))
        }
    }
}

/**
 * A choice's look in the chat, as the web's (ui/blocks.ts choicesRow): offered while none is chosen; once one is, none is
 * (one answer only), the one chosen keeps its ink and the others step back; an older answer's are shown, not offered, in a
 * dashed outline.
 */
internal data class ChoiceLook(val tappable: Boolean, val faded: Boolean, val inked: Boolean, val dashed: Boolean)

internal fun choiceLook(choice: String, chosen: String?, offered: Boolean) = ChoiceLook(
    tappable = offered && chosen == null,
    faded = chosen != null && chosen != choice,
    inked = chosen == choice,
    dashed = !offered,
)

/** A choice's words: as the web's, a step firmer than the body. */
private val ChoiceWords = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight(550))

/**
 * Answers to tap, as the web's lighter chips: pills that wrap, each its words on the page's surface in a firm outline; one
 * tapped is sent as your reply, and then none is offered. Without [choose] (an older answer) they're shown, not offered.
 */
@Composable
fun ChoicesBlock(choices: List<String>, choose: ((String) -> Unit)?) {
    val brand = LocalBrand.current
    // The web's --border-strong: a pill's outline a step firmer than a card's hairline, on each page.
    val outline = if (brand.paper.luminance() < 0.5f) Color(0xFF2E2E33) else Color(0xFFD4D4D8)
    var chosen by rememberSaveable(choices) { mutableStateOf<String?>(null) }
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s2), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        for (c in choices) {
            val look = choiceLook(c, chosen, offered = choose != null)
            val pill = androidx.compose.foundation.shape.CircleShape
            Box(
                Modifier
                    .heightIn(min = Space.touch)
                    .let { if (look.faded) it.then(Modifier.alpha(0.5f)) else it }
                    .clip(pill)
                    .background(MaterialTheme.colorScheme.surface)
                    .then(
                        if (look.dashed) Modifier.drawBehind {
                            val inset = 0.5.dp.toPx()
                            drawRoundRect(
                                outline,
                                topLeft = Offset(inset, inset),
                                size = Size(size.width - 2 * inset, size.height - 2 * inset),
                                cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2),
                                style = Stroke(1.dp.toPx(), pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
                            )
                        } else Modifier.border(1.dp, if (look.inked) brand.ink else outline, pill),
                    )
                    .then(if (look.tappable) Modifier.clickable(role = Role.Button) { chosen = c; choose?.invoke(c) } else Modifier)
                    .semantics { if (look.inked) selected = true }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(c, style = ChoiceWords, color = if (look.dashed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}

@Composable
fun StepsBlock(steps: List<Blocks.Step>) {
    val brand = LocalBrand.current
    Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(brand.raised).padding(Space.s3), verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        for (s in steps) {
            val (mark, color, word) = when (s.state) {
                "done" -> Triple(CheckIcon, brand.done, "done")
                "doing" -> Triple(DotIcon, brand.working, "doing")
                "failed" -> Triple(CloseIcon, brand.failed, "failed")
                "skipped" -> Triple(DashIcon, MaterialTheme.colorScheme.onSurfaceVariant, "skipped")
                else -> Triple(RingIcon, MaterialTheme.colorScheme.onSurfaceVariant, "to do")
            }
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "${s.text}, $word" }, horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
                androidx.compose.material3.Icon(mark, null, tint = color, modifier = Modifier.padding(top = 2.dp).size(20.dp))
                Text(s.text, style = MaterialTheme.typography.bodyLarge, textDecoration = if (s.state == "skipped") TextDecoration.LineThrough else null)
            }
        }
    }
}

/** A page it made: its title, and Open. It opens in a viewer of its own, cut off from the network. */
@Composable
fun PageCard(page: String) {
    var open by remember { mutableStateOf(false) }
    val title = remember(page) { Blocks.artifactTitle(page) } ?: "A page"
    Row(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(LocalBrand.current.raised).padding(Space.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("A page", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(title, style = MaterialTheme.typography.titleMediumEmphasized)
        }
        AnswerPill("Open", { open = true })
    }
    if (open) PageView(page, title) { open = false }
}

/**
 * The page as it made it, in a WebView that reaches nothing: no network, no files, no address of its own. Its scripts
 * run only when you say so (as the PWA asks before running a page's scripts).
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PageView(page: String, title: String, close: () -> Unit) {
    var scripts by remember { mutableStateOf(false) }
    val hasScripts = remember(page) { Regex("<script", RegexOption.IGNORE_CASE).containsMatchIn(page) }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column {
                Row(Modifier.fillMaxWidth().padding(Space.s2), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = close) { Text("Close") }
                    Text(title, style = MaterialTheme.typography.titleMediumEmphasized, modifier = Modifier.weight(1f))
                    if (hasScripts && !scripts) TextButton(onClick = { scripts = true }) { Text("Run its scripts") }
                }
                Box(Modifier.fillMaxSize()) {
                    AndroidView(
                        factory = { context ->
                            WebView(context).apply {
                                settings.apply {
                                    javaScriptEnabled = false
                                    blockNetworkLoads = true
                                    allowFileAccess = false
                                    allowContentAccess = false
                                    setGeolocationEnabled(false)
                                }
                            }
                        },
                        update = { web ->
                            if (web.settings.javaScriptEnabled != scripts || web.tag == null) {
                                web.settings.javaScriptEnabled = scripts
                                web.tag = scripts
                                web.loadDataWithBaseURL("about:blank", page, "text/html", "utf-8", null)
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}
