package sh.invincible.bot.ui

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
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The inline forms of an answer (bold, italics, struck through, code, links): drawn exactly as they were before 21 November
 * 2026, when the styler compiled six patterns at every character of every line, on a copy of the rest of it, each time an
 * answer was drawn. That one is kept here as it was, as the reference the one the app draws with must equal.
 */
class MarkdownTest {
    private val code = SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0xFF2A2A2E))
    private val link = Color(0xFF6AA7FF)

    private val bareLinkThen = Regex("^https?://[^\\s<>()]+[^\\s<>().,;:!?'\"]")

    private fun then(text: String): AnnotatedString = buildAnnotatedString {
        var i = 0
        val linkStyle = TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))
        while (i < text.length) {
            val rest = text.substring(i)
            val tick = Regex("^`([^`]+)`").find(rest)
            val bold = Regex("^\\*\\*(.+?)\\*\\*").find(rest)
            val struck = Regex("^~~(.+?)~~").find(rest)
            val a = Regex("^\\[([^\\]]+)]\\((https?://[^)\\s]+)\\)").find(rest)
            val bare = if (i == 0 || !text[i - 1].isLetterOrDigit()) bareLinkThen.find(rest) else null
            val italic = Regex("^[*_](?![*_\\s])(.+?)[*_]").find(rest)
            when {
                tick != null -> { withStyle(code) { append(tick.groupValues[1]) }; i += tick.value.length }
                bold != null -> { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(then(bold.groupValues[1])) }; i += bold.value.length }
                struck != null -> { withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(struck.groupValues[1]) }; i += struck.value.length }
                a != null -> { withLink(LinkAnnotation.Url(a.groupValues[2], linkStyle)) { append(a.groupValues[1]) }; i += a.value.length }
                bare != null -> { withLink(LinkAnnotation.Url(bare.value, linkStyle)) { append(bare.value) }; i += bare.value.length }
                italic != null && (i == 0 || !text[i - 1].isLetterOrDigit()) -> { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(italic.groupValues[1]) }; i += italic.value.length }
                else -> { append(text[i]); i++ }
            }
        }
    }

    private val lines = listOf(
        "",
        "plain words, nothing marked",
        "Three things stand out, and **one needs you**:",
        "The *release* is on track.",
        "CI on `main` is green: https://github.com/wckdboy/invincible/actions.",
        "~~Friday~~ Monday is the new date.",
        "See [the board](https://example.com/board) and [the log](http://example.com/log?x=1).",
        "snake_case_name stays as it is, and so does 2*3*4",
        "**bold with `code` and *italic* inside**",
        "an unclosed **bold and an unclosed `tick and [a link](nowhere",
        "_underscored_ and *starred* and * spaced * and ** not bold **",
        "a link at the end: http://example.com/path).",
        "https://start.example.com begins it, xhttps://not.example.com doesn't",
        "hhh http hhttps://x.example.com h",
        "first line\nsecond **line** with a\n`third`",
        "nested ~~struck **bold**~~ and **bold ~~struck~~**",
        "émoji ✓ and ünïcode `cødé` **bóld**",
        "*",
        "**",
        "`",
        "[",
        "_a_b_",
        "***both***",
    )

    @Test fun drawsEveryLineAsItWasDrawn() {
        for (line in lines) assertEquals(line, then(line), inline(line, code, link))
    }

    @Test fun drawsTheStandInsAnswerAsItWasDrawn() {
        // The words of apps/apple/scripts/dev-node.ts's answer, the one that holds everything an answer can.
        val answer = "## What I found\n\nThree things stand out, and **one needs you**:\n\n1. The *release* is on track.\n2. CI on `main` is green: https://github.com/wckdboy/invincible/actions.\n3. ~~Friday~~ Monday is the new date.\n   - It moved for the review.\n\n> The gate held: nothing ships unreviewed.\n\n| Check | Result | Time |\n|:--|:--:|--:|\n| Unit tests | passed | 41 s |"
        for (line in answer.split("\n")) assertEquals(line, then(line), inline(line, code, link))
    }

    @Test fun aLongLineIsDrawnInOnePass() {
        // 40,000 characters: the reference took seconds on this (a pattern compiled at every character, on a copy).
        val long = buildString { repeat(2_000) { append("word **bold** `tick` plain _it_ ") } }
        // Timed by its own thread's CPU, not the wall's: on a Mac shared with other work it once took 516 ms of the wall's
        // (27 November 2026, at a load of 53), waiting for a CPU, not working longer. It works about 40 ms; drawn as the
        // reference drew it, it works seconds.
        val cpu = java.lang.management.ManagementFactory.getThreadMXBean()
        val started = cpu.currentThreadCpuTime
        val drawn = inline(long, code, link)
        val ms = (cpu.currentThreadCpuTime - started) / 1_000_000
        // (Each repeat loses its eight marks: two pairs of stars, a pair of ticks, a pair of underscores.)
        assertEquals(long.length - 2_000 * 8, drawn.text.length)
        assert(ms < 500) { "took $ms ms of CPU" }
    }
}
