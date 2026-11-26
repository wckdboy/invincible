package sh.invincible.bot.core

import kotlin.math.floor

/**
 * An agent's desktop, watched and taken over (POST /api/team/desktop), as the PWA's lib/desktop.ts and the Apple app's
 * Desktop.swift read it: where a tap on the picture lands on the agent's own screen, what counts as an address for its
 * browser, the picture the node sends, and the node's refusal that a VM has no desktop. Held to the parity vectors'
 * `desktop`.
 */
object Desktop {
    /** The keys offered beside the picture, by the names X gives them. */
    val keys = listOf("Return" to "Return", "Tab" to "Tab", "Escape" to "Escape", "Backspace" to "BackSpace")

    data class Point(val x: Int, val y: Int)

    /**
     * A tap on the picture as a place on the agent's screen, in the screen's own pixels: the picture is drawn at
     * ([left], [top]), [width] by [height]. Null for a tap beside it, or on a picture not drawn yet.
     */
    fun point(tapX: Double, tapY: Double, left: Double, top: Double, width: Double, height: Double, screenWidth: Int, screenHeight: Int): Point? {
        if (!(width > 0 && height > 0)) return null
        val across = (tapX - left) / width
        val down = (tapY - top) / height
        if (!(across >= 0 && across <= 1 && down >= 0 && down <= 1)) return null
        return Point(minOf(screenWidth - 1, floor(across * screenWidth).toInt()), minOf(screenHeight - 1, floor(down * screenHeight).toInt()))
    }

    private val SCHEMED = Regex("^(https?://|file://|about:)")
    // (A colon before a digit is a port, not a scheme: localhost:3000.)
    private val OTHER_SCHEME = Regex("^[a-z][a-z0-9+.-]*:(?!\\d)", RegexOption.IGNORE_CASE)

    /** An address as the desktop's browser takes it: http, https, file or about as written, a bare host with https. Null: not one. */
    fun address(text: String): String? {
        val typed = text.trim()
        if (typed.isEmpty() || typed.any { it.isWhitespace() }) return null
        val address = if (SCHEMED.containsMatchIn(typed)) typed else if (OTHER_SCHEME.containsMatchIn(typed)) null else "https://$typed"
        return address?.takeIf { it.length <= 2000 }
    }

    private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

    /** Whether the node's answer is a picture this app shows: a JPEG or a PNG in base64, of a screen with a size. */
    fun shown(view: Json): Boolean {
        val type = view["shot"]["mediaType"].string
        val data = view["shot"]["data"].string ?: return false
        return (type == "image/jpeg" || type == "image/png") && BASE64.matches(data) && (view["width"].int ?: 0) > 0 && (view["height"].int ?: 0) > 0
    }

    /** The picture's bytes, when it is one ([shown]). */
    fun picture(view: Json): ByteArray? =
        if (shown(view)) runCatching { java.util.Base64.getDecoder().decode(view["shot"]["data"].string) }.getOrNull() else null

    /** The node's refusal that this VM has no desktop (it says how to get one), told apart from every other. */
    fun saysNoDesktop(e: NodeError): Boolean = e.status == 424 && e.message?.contains("no desktop") == true

    /* One thing done on the desktop, as the node takes it (core's DesktopAction). */
    fun click(x: Int, y: Int) = Json.obj("do" to "click", "x" to x, "y" to y)
    fun scroll(up: Boolean, times: Int) = Json.obj("do" to "scroll", "direction" to if (up) "up" else "down", "times" to times)
    fun type(text: String) = Json.obj("do" to "type", "text" to text)
    fun key(key: String) = Json.obj("do" to "key", "keys" to listOf(key))
    fun open(address: String) = Json.obj("do" to "open", "address" to address)
}
