package sh.invincible.bot.app

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.canonical
import sh.invincible.bot.core.get
import sh.invincible.bot.core.string

/**
 * A newer build, as invincible.sh says it (android/latest.json, which apps/android/scripts/publish.sh writes with each
 * release, as the Mac app's feed is written): asked at most once a day, with nothing of yours in the request. A phone
 * installs it over this one because every build is signed with the same key. A developer's build asks nothing.
 */
object Updates {
    private const val FEED = "https://invincible.sh/android/latest.json"
    private const val DAY = 24 * 3_600_000L

    data class Newer(val build: String, val version: String, val url: String, val size: String)

    /** This build's number (yyyymmddHHMM), from its version name; null for a developer's build. */
    fun build(context: Context): String? = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull()?.let { Regex("\\((20\\d{10})\\)").find(it)?.groupValues?.get(1) }

    suspend fun newer(context: Context): Newer? {
        val mine = build(context) ?: return null
        val prefs = context.getSharedPreferences("invincible", Context.MODE_PRIVATE)
        val cached = prefs.getString("update", null)?.let { runCatching { Json.parse(it) }.getOrNull() }
        val fresh = System.currentTimeMillis() - prefs.getLong("update-at", 0) < DAY
        val feed = if (fresh && cached != null) cached else fetch()?.also {
            prefs.edit().putString("update", it.canonical()).putLong("update-at", System.currentTimeMillis()).apply()
        } ?: cached ?: return null
        return newer(feed, mine)
    }

    /** What [feed] (invincible.sh's android/latest.json) offers over this build ([mine]): a later build of this app, else none. */
    fun newer(feed: Json, mine: String): Newer? {
        val build = feed["build"].string ?: return null
        val url = feed["url"].string ?: return null
        // Only a build of this app, published where the source is: anything else in the feed is no update.
        if (!Regex("^20\\d{10}$").matches(build) || build <= mine || !url.startsWith("https://github.com/wckdboy/invincible/releases/download/")) return null
        val bytes = (feed["size"] as? Json.Num)?.value ?: 0.0
        return Newer(build, feed["version"].string ?: "", url, "%.1f MB".format(java.util.Locale.US, bytes / 1e6))
    }

    private suspend fun fetch(): Json? = withContext(Dispatchers.IO) {
        runCatching {
            val c = URL(FEED).openConnection() as HttpURLConnection
            try {
                c.connectTimeout = 10_000
                c.readTimeout = 10_000
                c.instanceFollowRedirects = false
                c.useCaches = false
                if (c.responseCode != 200) null else c.inputStream.use { Json.parse(String(it.readBytes(), Charsets.UTF_8)) }
            } finally {
                c.disconnect()
            }
        }.getOrNull()
    }
}
