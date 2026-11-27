package sh.invincible.bot.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import sh.invincible.bot.core.Json

/**
 * What the feed offers over this build (Updates.newer): the roster's foot says "Update Invincible" while it offers one,
 * and Settings has its download. Only a later build of this app, published where its source is.
 */
class UpdatesTest {
    private val mine = "202612011200"
    private val url = "https://github.com/wckdboy/invincible/releases/download/android-202612051200/invincible-202612051200.apk"

    private fun feed(build: Any? = "202612051200", link: Any? = url, version: String = "0.5.0", size: Double = 31_400_000.0): Json =
        Json.obj("build" to build, "url" to link, "version" to version, "size" to size)

    @Test fun aLaterBuildIsOffered() {
        assertEquals(Updates.Newer("202612051200", "0.5.0", url, "31.4 MB"), Updates.newer(feed(), mine))
    }

    @Test fun thisBuildOrAnEarlierOneIsNot() {
        assertNull(Updates.newer(feed(build = mine), mine))
        assertNull(Updates.newer(feed(build = "202611011200"), mine))
    }

    @Test fun nothingPublishedElsewhereOrMalformedIs() {
        assertNull("another place", Updates.newer(feed(link = "https://example.test/invincible.apk"), mine))
        assertNull("another repository", Updates.newer(feed(link = "https://github.com/someone/invincible/releases/download/x/y.apk"), mine))
        assertNull("not a build number", Updates.newer(feed(build = "latest"), mine))
        assertNull("no build", Updates.newer(feed(build = null), mine))
        assertNull("no link", Updates.newer(feed(link = null), mine))
        assertNull("an empty feed, as today's", Updates.newer(Json.obj(), mine))
    }
}
