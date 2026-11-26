package sh.invincible.bot.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the message box does while your agent works, and the words around it (the web's lib/turns.ts, the iPhone's
 * ComposerWords), held to the vectors' `composer`: what sending does, a side question typed into the box, the lines over
 * steers on their way and the queue, what didn't reach it, and the side question's words.
 */
class ComposerVectorsTest {
    private val c = Fixture.vectors["composer"]

    @Test fun whatSendingDoesWhileItWorks() {
        for (a in c["actions"].list) {
            val got = Composer.action(busy = a["busy"].bool!!, enter = Composer.Enter.valueOf(a["enter"].string!!.uppercase()), modifier = a["modifier"].bool!!, canQueue = a["canQueue"].bool!!)
            assertEquals(a.text(), a["action"].string, got.wire)
        }
    }

    @Test fun aSideQuestionTypedIntoTheBox() {
        for (a in c["asides"].list) assertEquals(a["text"].string, a["aside"].string, Composer.aside(a["text"].string!!))
    }

    @Test fun theLinesOverWhatWaits() {
        for (s in c["steering"].list) assertEquals(s["line"].string, Composer.steering(s["count"].int!!))
        for (h in c["heads"].list) {
            val got = Composer.queueHead(h["queued"].int!!, h["held"].string, h["busy"].bool!!)
            assertEquals(h.text(), h["count"].string, got.first)
            assertEquals(h.text(), h["rest"].string, got.second)
        }
        for (u in c["undelivered"].list) {
            val got = Composer.undelivered(u["texts"].int!!, u["queued"].bool!!)
            assertEquals(u.text(), u["title"].string, got.first)
            assertEquals(u.text(), u["detail"].string, got.second)
        }
        for (p in c["placeholders"].list) assertEquals(p["words"].string, Composer.placeholder(p["canQueue"].bool!!))
        assertEquals(c["filesWait"].string, Composer.FILES_WAIT)
        assertEquals(c["justStarting"].string, Composer.JUST_STARTING)
        assertEquals(c["notKept"].string, Composer.NOT_KEPT)
    }

    @Test fun theSideQuestionsWords() {
        for (n in c["asideNotes"].list) assertEquals(n["note"].string, Composer.asideNote(n["working"].bool!!))
        for (b in c["broughtBack"].list) assertEquals(b["words"].string, Composer.broughtBack(b["how"].string!!))
        assertEquals(c["nothingYet"]["title"].string, Composer.NOTHING_YET.first)
        assertEquals(c["nothingYet"]["detail"].string, Composer.NOTHING_YET.second)
        for (p in c["asidePlaceholders"].list) assertEquals(p["words"].string, Composer.asidePlaceholder(p["working"].bool!!))
        assertEquals(c["asideAnswering"].string, Composer.ASIDE_ANSWERING)
        assertEquals(c["asideFailed"].string, Composer.ASIDE_FAILED)
        assertEquals(c["bringBackFailed"].string, Composer.BRING_BACK_FAILED)
    }
}
