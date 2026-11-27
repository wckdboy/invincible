package sh.invincible.bot.app

/**
 * Marks for the performance runner (apps/android/scripts/perf.ts), as the iPhone's PerfProbe has them: a line in the log
 * (tag InvinciblePerf) when Home is first usable, when the count of what needs you changes, and when the link is said lost
 * or back, so the runner times what the app shows from the log, to the millisecond, without reading the screen. Only in a
 * debuggable build: a release says nothing.
 */
object PerfProbe {
    @Volatile var on = false

    fun mark(what: String) {
        if (on) android.util.Log.i("InvinciblePerf", what)
    }
}
