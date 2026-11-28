package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Settings' "This phone", in the web's words for a browser's "This device" (apps/web/src/views/settings.ts): the key and
 * the fleet cut short as shortId cuts them, the node by name and its address as location.host says it, the fleet by
 * name. (Made-up ids, in the ids' own form: two characters of kind, then the rest.)
 */
class ThisPhoneTest {
    @Test fun anIdIsCutAsTheWebsShortIdCutsItItsKindLeftOff() {
        assertEquals("0123456789abcdef", ThisPhone.shortId("c_0123456789abcdefghij", 16))
        assertEquals("0123456789", ThisPhone.shortId("f_0123456789abc", 10))
        assertEquals("01234567", ThisPhone.shortId("c_0123456789"))
        // A short one, whole: no longer than its kind and what would be kept.
        assertEquals("c_0123456789", ThisPhone.shortId("c_0123456789", 10))
    }

    @Test fun anAddressIsItsHostAndPortAsLocationHostSaysThem() {
        assertEquals("127.0.0.1:52608", ThisPhone.host("http://127.0.0.1:52608"))
        assertEquals("node.example.test", ThisPhone.host("https://node.example.test/"))
        assertEquals("node.example.test:8443", ThisPhone.host("https://node.example.test:8443/app?x=1"))
        // The scheme's own port goes unsaid, as a browser leaves it.
        assertEquals("node.example.test", ThisPhone.host("https://node.example.test:443"))
        assertEquals("192.0.2.10", ThisPhone.host("http://192.0.2.10:80/"))
        assertEquals("[::1]:7777", ThisPhone.host("http://[::1]:7777"))
    }

    @Test fun itTalksToItsNodeByNameThenWhere() {
        assertEquals("homelab · 127.0.0.1:52608", ThisPhone.talksTo("homelab", "http://127.0.0.1:52608"))
        // A pairing from before nodes were named: where, alone.
        assertEquals("node.example.test", ThisPhone.talksTo(null, "https://node.example.test"))
        assertEquals("node.example.test", ThisPhone.talksTo(" ", "https://node.example.test"))
    }

    @Test fun itsFleetByNameOrUnnamedThenItsIdCutShort() {
        assertEquals("measure · 0123456789", ThisPhone.fleet("measure", "f_0123456789abc"))
        assertEquals("unnamed · 0123456789", ThisPhone.fleet(null, "f_0123456789abc"))
        assertEquals("unnamed · 0123456789", ThisPhone.fleet("", "f_0123456789abc"))
    }
}
