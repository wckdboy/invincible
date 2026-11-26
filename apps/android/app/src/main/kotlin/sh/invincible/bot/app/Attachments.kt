package sh.invincible.bot.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeClient
import sh.invincible.bot.core.get

/**
 * A file for a message of yours, as the Apple app and the PWA send them (core's attachments.ts): a picture drawn again
 * at most 1568 pixels on its long side, upright, as a new image with none of the photo's own metadata (where it was
 * taken), a PNG where it was one and still fits, else a JPEG; or a text, as it is, up to 256 KB. Kept on the node by the
 * SHA-256 of its bytes (POST /api/uploads); the message then names it.
 */
object Attachments {
    const val PER_MESSAGE = 8
    private const val SIDE = 1568
    private const val PICTURE_BYTES = 5 * 1024 * 1024
    private const val TEXT_BYTES = 256 * 1024

    data class Prepared(val name: String, val type: String, val bytes: ByteArray)

    class Refused(why: String) : Exception(why)

    private fun nameOf(context: Context, uri: Uri): String =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }?.replace(Regex("[/\\\\\\u0000-\\u001f\\u007f]"), "")?.trim()?.take(200)?.ifEmpty { null } ?: "file"

    /**
     * A picture from the photo picker, drawn again as it goes, called [name] (the picker's own names are its media ids,
     * so the message says "Photo", as the Apple app's do).
     */
    suspend fun picture(context: Context, uri: Uri, name: String): Prepared = withContext(Dispatchers.IO) {
        val bitmap = try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
                val (w, h) = info.size.width to info.size.height
                val scale = minOf(1.0, SIDE.toDouble() / maxOf(w, h))
                decoder.setTargetSize(maxOf(1, (w * scale).toInt()), maxOf(1, (h * scale).toInt()))
                // Software, so it can be compressed; drawn upright by the decoder (its EXIF turn applied, then dropped).
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } catch (e: Exception) {
            throw Refused("That picture couldn't be read.")
        }
        val keepPng = context.contentResolver.getType(uri) == "image/png"
        fun encoded(format: Bitmap.CompressFormat, quality: Int) = ByteArrayOutputStream().also { bitmap.compress(format, quality, it) }.toByteArray()
        val png = if (keepPng) encoded(Bitmap.CompressFormat.PNG, 100).takeIf { it.size <= PICTURE_BYTES } else null
        val out = png?.let { Prepared("$name.png", "image/png", it) } ?: Prepared("$name.jpg", "image/jpeg", encoded(Bitmap.CompressFormat.JPEG, 86))
        if (out.bytes.size > PICTURE_BYTES) throw Refused("That picture is too big to send, even made smaller.")
        out
    }

    /** A text file, as it is: UTF-8, up to 256 KB. */
    suspend fun text(context: Context, uri: Uri): Prepared = withContext(Dispatchers.IO) {
        // (Read no further than the limit: a file past it is refused, not read whole.)
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (out.size() <= TEXT_BYTES) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
            }
            out.toByteArray()
        } ?: throw Refused("That file couldn't be read.")
        if (bytes.size > TEXT_BYTES) throw Refused("A text file goes up to 256 KB.")
        if (runCatching { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)) }.isFailure) throw Refused("That file isn't text.")
        Prepared(nameOf(context, uri), "text/plain", bytes)
    }

    /** Kept on the node: its reference, which the message names. */
    suspend fun upload(client: NodeClient, file: Prepared): Json {
        val body = Json.obj("name" to file.name, "type" to file.type, "data" to java.util.Base64.getEncoder().encodeToString(file.bytes))
        return client.post("/api/uploads", body)["attachment"] ?: throw Refused("The node kept nothing.")
    }
}
