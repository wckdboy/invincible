@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import sh.invincible.bot.core.Blocks

/** A block of an answer: what Markdown it writes comes to, as this app shows it. */
private sealed interface Part {
    data class Heading(val level: Int, val text: String) : Part
    data class Para(val text: String) : Part
    data class Item(val marker: String, val text: String) : Part
    data class Quote(val text: String) : Part
    /** A fenced block: code, or one of its answer blocks by its language. `open`: still being written. */
    data class Fence(val lang: String, val text: String, val open: Boolean) : Part
    data class Table(val rows: List<List<String>>) : Part
}

private val tableRule = Regex("^\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?$")
private val headingRule = Regex("^#{1,6} ")
private val bulletRule = Regex("^[-*+] ")
private val numberedRule = Regex("^\\d+[.)] ")

private fun cells(line: String): List<String> = line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

private fun parts(text: String): List<Part> {
    val out = ArrayList<Part>()
    val lines = text.replace("\r\n", "\n").split("\n")
    var i = 0
    val para = StringBuilder()
    fun flush() {
        if (para.isNotBlank()) out += Part.Para(para.toString().trim())
        para.clear()
    }
    while (i < lines.size) {
        val line = lines[i]
        val t = line.trimStart()
        when {
            t.startsWith("```") -> {
                flush()
                val lang = t.removePrefix("```").trim().substringBefore(' ').lowercase()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i])
                    i++
                }
                out += Part.Fence(lang, code.toString().trimEnd('\n'), open = i >= lines.size)
            }
            headingRule.containsMatchIn(t) -> {
                flush()
                val level = t.takeWhile { it == '#' }.length
                out += Part.Heading(level, t.drop(level).trim())
            }
            bulletRule.containsMatchIn(t) -> { flush(); out += Part.Item("•", t.drop(2)) }
            numberedRule.containsMatchIn(t) -> { flush(); val n = t.takeWhile { it.isDigit() }; out += Part.Item("$n.", t.drop(n.length + 2)) }
            t.startsWith(">") -> { flush(); out += Part.Quote(t.drop(1).trim()) }
            t.startsWith("|") && i + 1 < lines.size && tableRule.matches(lines[i + 1].trim()) -> {
                flush()
                val rows = arrayListOf(cells(t))
                i += 2
                while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                    rows += cells(lines[i])
                    i++
                }
                out += Part.Table(rows)
                continue
            }
            t.isEmpty() -> flush()
            else -> {
                if (para.isNotEmpty()) para.append('\n')
                para.append(line)
            }
        }
        i++
    }
    flush()
    return out
}

// The inline forms, each matched where it begins (matchAt): compiled once, and tried only at a character it can begin
// with. They were compiled again at every character of every line, on a copy of the rest of it, each time an answer
// was drawn: while it streamed in, and whenever it scrolled back into view.
private val tickRule = Regex("`([^`]+)`")
private val boldRule = Regex("\\*\\*(.+?)\\*\\*")
private val struckRule = Regex("~~(.+?)~~")
private val linkRule = Regex("\\[([^\\]]+)]\\((https?://[^)\\s]+)\\)")
private val bareLink = Regex("https?://[^\\s<>()]+[^\\s<>().,;:!?'\"]")
private val italicRule = Regex("[*_](?![*_\\s])(.+?)[*_]")
/** The characters an inline form begins with: everything else goes in as it is, a run at a time. */
private val marks = charArrayOf('`', '*', '~', '[', '_', 'h')

/** Bold, italics, struck through, code and links inside a line; a bare address is a link too. */
internal fun inline(text: String, code: SpanStyle, link: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    val linkStyle = TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))
    while (i < text.length) {
        val c = text[i]
        if (c !in marks) {
            val next = text.indexOfAny(marks, i).let { if (it < 0) text.length else it }
            append(text, i, next)
            i = next
            continue
        }
        val wordStart = i == 0 || !text[i - 1].isLetterOrDigit()
        val tick = if (c == '`') tickRule.matchAt(text, i) else null
        val bold = if (c == '*') boldRule.matchAt(text, i) else null
        val struck = if (c == '~') struckRule.matchAt(text, i) else null
        val a = if (c == '[') linkRule.matchAt(text, i) else null
        val bare = if (c == 'h' && wordStart) bareLink.matchAt(text, i) else null
        val italic = if ((c == '*' || c == '_') && wordStart) italicRule.matchAt(text, i) else null
        when {
            tick != null -> { withStyle(code) { append(tick.groupValues[1]) }; i += tick.value.length }
            bold != null -> { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inline(bold.groupValues[1], code, link)) }; i += bold.value.length }
            struck != null -> { withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(struck.groupValues[1]) }; i += struck.value.length }
            a != null -> { withLink(LinkAnnotation.Url(a.groupValues[2], linkStyle)) { append(a.groupValues[1]) }; i += a.value.length }
            bare != null -> { withLink(LinkAnnotation.Url(bare.value, linkStyle)) { append(bare.value) }; i += bare.value.length }
            italic != null -> { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(italic.groupValues[1]) }; i += italic.value.length }
            else -> { append(text[i]); i++ }
        }
    }
}

/**
 * An answer as it wrote it: headings, paragraphs, lists, quotes, tables and code, and its answer blocks drawn live
 * (a chart, figures, steps, choices to tap, a page). [choose], where given, sends a tapped choice as your reply.
 */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier, choose: ((String) -> Unit)? = null) {
    val blocks = remember(text) { parts(text) }
    val brand = LocalBrand.current
    val code = SpanStyle(fontFamily = FontFamily.Monospace, background = brand.raised)
    val type = MaterialTheme.typography
    // (Worked out once for its words: while an answer streams in, only its last block changes.)
    @Composable
    fun styled(words: String): AnnotatedString = remember(words, code, brand.working) { inline(words, code, brand.working) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Space.s2)) {
        for (b in blocks) when (b) {
            is Part.Heading -> SelectionContainer { Text(styled(b.text), style = if (b.level <= 2) type.titleLargeEmphasized else type.titleMediumEmphasized) }
            is Part.Para -> SelectionContainer { Text(styled(b.text), style = type.bodyLarge) }
            is Part.Item -> Row {
                Text(b.marker, style = type.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(24.dp))
                SelectionContainer { Text(styled(b.text), style = type.bodyLarge) }
            }
            is Part.Quote -> Row(Modifier.fillMaxWidth()) {
                Box(Modifier.width(3.dp).padding(vertical = 2.dp).background(brand.line))
                Text(styled(b.text), style = type.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = Space.s3))
            }
            is Part.Table -> TableBlock(b.rows, code)
            is Part.Fence -> FenceBlock(b, choose)
        }
    }
}

@Composable
private fun TableBlock(rows: List<List<String>>, code: SpanStyle) {
    val brand = LocalBrand.current
    val columns = rows.maxOf { it.size }
    Box(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).background(brand.raised).horizontalScroll(rememberScrollState())) {
        Column(Modifier.padding(vertical = Space.s1)) {
            rows.forEachIndexed { r, row ->
                Row {
                    for (c in 0 until columns) {
                        val cell = row.getOrElse(c) { "" }
                        Text(
                            remember(cell, code, brand.working) { inline(cell, code, brand.working) },
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (r == 0) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.width(120.dp).padding(horizontal = Space.s3, vertical = Space.s1),
                        )
                    }
                }
            }
        }
    }
}

private val pendingWords = mapOf(
    "chart" to "Drawing a chart…", "stats" to "Gathering figures…", "choices" to "Writing choices…", "steps" to "Planning steps…",
    "artifact" to "Making a page: it opens when it's done",
)

@Composable
private fun FenceBlock(b: Part.Fence, choose: ((String) -> Unit)?) {
    val lang = b.lang
    // (Read once for its words: a block's JSON isn't read again each time the answer is drawn.)
    val artifact = remember(lang, b.text) { if (lang == "artifact" || lang == "html") Blocks.artifact(b.text) else null }
    val page = lang == "artifact" || (lang == "html" && artifact is Blocks.Read.Ok)
    if ((lang in Blocks.kinds || page) && b.open) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s2)) {
            Dot(LocalBrand.current.working, live = true)
            Text(pendingWords[lang] ?: "Drawing…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    if (page) {
        when (val read = artifact ?: Blocks.artifact(b.text)) {
            is Blocks.Read.Ok -> PageCard(read.value)
            is Blocks.Read.No -> Refused("page", read.why, b.text)
        }
        return
    }
    when (lang) {
        "chart" -> when (val read = remember(b.text) { Blocks.chart(b.text) }) {
            is Blocks.Read.Ok -> ChartBlock(read.value)
            is Blocks.Read.No -> Refused("chart", read.why, b.text)
        }
        "stats" -> when (val read = remember(b.text) { Blocks.stats(b.text) }) {
            is Blocks.Read.Ok -> StatsBlock(read.value)
            is Blocks.Read.No -> Refused("figures", read.why, b.text)
        }
        "choices" -> when (val read = remember(b.text) { Blocks.choices(b.text) }) {
            is Blocks.Read.Ok -> ChoicesBlock(read.value, choose)
            is Blocks.Read.No -> Refused("choices", read.why, b.text)
        }
        "steps" -> when (val read = remember(b.text) { Blocks.steps(b.text) }) {
            is Blocks.Read.Ok -> StepsBlock(read.value)
            is Blocks.Read.No -> Refused("steps", read.why, b.text)
        }
        else -> CodeBlock(b.text)
    }
}

@Composable
fun CodeBlock(text: String) {
    SelectionContainer {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = FontFamily.Monospace,
            softWrap = false,
            modifier = Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.small)
                .background(LocalBrand.current.raised)
                .horizontalScroll(rememberScrollState())
                .padding(Space.s3),
        )
    }
}

/** A block that couldn't be drawn: why, then the code it is. */
@Composable
private fun Refused(what: String, why: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.s1)) {
        Text("This $what couldn't be drawn: $why.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        CodeBlock(text)
    }
}
