package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * An `invincible:` link opens its exact place and only navigates (the iPhone's Push.link, I9): a task, an agent, an
 * approval, a chat. Anything else is no link of these (an invite is the join's), and nothing in one acts on its own.
 */
class LinksTest {
    @Test fun aLinkOpensATaskAnAgentAnApprovalOrAChatAndNothingElse() {
        assertEquals(Links.Place("task:task-abcdefghijkl"), Links.of("invincible://task/task-abcdefghijkl"))
        assertEquals(Links.Place("agent:writer"), Links.of("invincible://agent/writer"))
        assertEquals(Links.Place("inbox", approval = "a_1234567890123456789012"), Links.of("invincible://approval/a_1234567890123456789012"))
        assertEquals(Links.Place("chat", conversation = "cv_1234567890123456789012"), Links.of("invincible://chat/cv_1234567890123456789012"))
        for (bad in listOf(
            "invincible://task/../etc", "invincible://agent/Writer", "invincible://settings/x", "https://task/task-abcdefghijkl",
            "invincible://task/task-abcdefghijkl/more", "invincible://pair#pair=gi1.x", "invincible://task/task-abcdefghijkl?ship=1",
            "invincible://approval/a_1234567890123456789012#approve", "INVINCIBLE://task/task-abcdefghijkl", "invincible:task/task-abcdefghijkl",
        )) {
            assertNull(bad, Links.of(bad))
        }
    }
}
