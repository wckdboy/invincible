package sh.invincible.bot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/*
 * A terminal in a sandbox on your node (an agent's VM), as the Apple app's Terminal.swift and the PWA hold one: what is
 * typed, sent in order (core's terminal-input.ts), what it shows as text, and the addresses a sign-in prints, picked
 * out so a phone can open them.
 */

object Terminals {
    // Colours, moves, titles: the escape sequences a terminal acts on, taken out.
    private val ESCAPES = Regex("\u001b\\][^\u0007\u001b]*(\u0007|\u001b\\\\)|\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>78]")
    private val LINK = Regex("https?://[^\\s\"'<>`]+")

    /** What a terminal shows, as text. */
    fun plain(text: String): String = text.replace(ESCAPES, "")

    /** The web addresses in what a terminal showed, in order: a sign-in's page to open on the phone. */
    fun links(text: String): List<String> = LINK.findAll(plain(text)).mapNotNull { found ->
        val address = found.value.trimEnd('.', ',', ';', ':', ')', ']', '}')
        val uri = runCatching { java.net.URI(address) }.getOrNull()
        address.takeIf { uri != null && (uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrEmpty() }
    }.toList()
}

/**
 * What is typed into a terminal, sent in order (core's `inputQueue`): one request at a time, and what is typed (or a new
 * size) while one is on its way goes next, together, the latest size only. A request that fails is told, and nothing
 * more is sent after it. A paste larger than one request goes in pieces, in order, never splitting a character.
 */
class TerminalInputQueue(
    private val scope: CoroutineScope,
    private val send: suspend (data: String?, cols: Int?, rows: Int?) -> Unit,
    private val failed: (Exception) -> Unit,
) {
    private val typed = StringBuilder()
    private var size: Pair<Int, Int>? = null
    private var sending = false
    private var broken = false

    fun type(data: String) {
        typed.append(data)
        flush()
    }

    fun resize(cols: Int, rows: Int) {
        size = cols to rows
        flush()
    }

    private fun flush() {
        if (broken || sending || (typed.isEmpty() && size == null)) return
        // A piece ends at the last whole character within the limit, counted in UTF-16 units as the node counts them.
        var end = 0
        while (end < typed.length) {
            val next = end + Character.charCount(Character.codePointAt(typed, end))
            if (next > MAX_DATA) break
            end = next
        }
        val piece = typed.substring(0, end)
        typed.delete(0, end)
        val sized = size
        size = null
        sending = true
        scope.launch {
            try {
                send(piece.ifEmpty { null }, sized?.first, sized?.second)
                sending = false
                flush()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                sending = false
                broken = true
                failed(e)
            }
        }
    }

    companion object {
        /** The most one request carries (the route's limit). */
        const val MAX_DATA = 65_536
    }
}
