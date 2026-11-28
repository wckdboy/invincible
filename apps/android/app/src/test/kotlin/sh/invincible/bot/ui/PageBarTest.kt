package sh.invincible.bot.ui

import androidx.compose.runtime.Composer
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A page hands its bar what it offers (Keys' Add, the agents' Give a task, the chat's menu, a terminal's keys) as a
 * trailing lambda, and Kotlin gives a trailing lambda to a function's last parameter: so PageBar's last parameter is its
 * actions. 14fedfbe put the slot for a title drawn in more than words (an agent's glass beside its name) last, and those
 * four pages showed their actions where their title belongs, with no title. It compiled, since none of those actions
 * needs its row.
 *
 * (Compose compiles a composable lambda to a function that also takes the Composer and a mask: the actions, with the
 * bar's row as their receiver, are a Function3; a title's slot, with none, a Function2. The composable itself then ends
 * with the Composer and its masks, so the parameter before the Composer is the last one written.)
 */
class PageBarTest {
    @Test fun aPagesTrailingLambdaIsItsActionsNeverItsTitle() {
        val bar = Class.forName("sh.invincible.bot.ui.PartsKt").declaredMethods.single { it.name == "PageBar" }
        val parameters = bar.parameterTypes.toList()
        val composer = parameters.indexOf(Composer::class.java)
        assertEquals("PageBar's last parameter, the one a trailing lambda is given to, in $parameters", Function3::class.java, parameters[composer - 1])
    }
}
