package sh.invincible.bot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import sh.invincible.bot.MainActivity
import sh.invincible.bot.R
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeClient
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.NotifyPayload
import sh.invincible.bot.core.Reach
import sh.invincible.bot.core.bool
import sh.invincible.bot.core.get
import sh.invincible.bot.core.list
import sh.invincible.bot.core.string
import sh.invincible.bot.core.Primary

/**
 * Notifications with no push service (no Google, nobody in between): the node keeps what it would tell this phone, by
 * its own rules (the kinds you chose, quiet hours, the day's limit), and the phone collects it over its own signed
 * connection (core's `notifyCollect`): every fifteen minutes or so on Android's own schedule, which waits longer while
 * the phone sleeps, and each time the app comes to the front. Or at once, through UnifiedPush (UnifiedPush.kt), with
 * collecting kept on beside it as a backstop: what the distributor's server refuses is kept on the node and collected
 * (26 November 2026: Android wouldn't let ntfy connect from the background, and everything was lost). Each is
 * read strictly (core/NotifyPayload.kt) and shown as the node told it: a title, one line, where it opens (the very task
 * among them); what needs you on the Needs you channel, news (a quiet kind) on News, and so is one about what the app
 * shows that moment (as the iPhone's goes only to the list). An approval told alone carries Approve…, which opens that
 * approval's card with the whole request in front of you (never a yes from the lock screen: your word, 25 November
 * 2026), and Decline, answered where it's told; a task's work that can be shipped carries Ship it…, which opens the task
 * with its ship asked. Each button works only behind the phone's own unlock. What was answered, dismissed, cleared or
 * lapsed on any device is taken down here (the node's `withdrawn`).
 */
object Notices {
    private const val JOB = 1
    /** Something waits for you: an approval, a question, a finding. It may sound. */
    private const val NEEDS = "needs-you"
    /** Work that ended, a rule of yours that told you. */
    private const val NEWS = "news"
    const val OPEN = "sh.invincible.bot.open"
    const val CONVERSATION = "sh.invincible.bot.conversation"
    /** The task a notification opens (its own thread), and whether its Ship it… was pressed. */
    const val TASK = "sh.invincible.bot.task"
    const val SHIP = "sh.invincible.bot.ship"
    /** The approval whose card Approve… opens. */
    const val APPROVAL = "sh.invincible.bot.approval"
    private const val ACTION = "sh.invincible.bot.action"
    private const val APPROVE = "sh.invincible.bot.approve"
    private const val TAG = "sh.invincible.bot.tag"

    private fun jobs(context: Context) = context.getSystemService(JobScheduler::class.java)

    /** On here: Android collects them on its schedule, or they come at once through UnifiedPush. */
    fun on(context: Context): Boolean = jobs(context).getPendingJob(JOB) != null || instant(context) != null

    /** The distributor they come through at once (UnifiedPush), by its name; null while they're collected. */
    fun instant(context: Context): String? = UnifiedPush.registration(context)?.takeIf { it.endpoint != null }?.let { UnifiedPush.label(context, it.distributor) }

    private fun prefs(context: Context) = context.getSharedPreferences("notices", Context.MODE_PRIVATE)

    /** What went wrong making them instant, for More → Notifications to say (null: nothing). */
    fun trouble(context: Context): String? = prefs(context).getString("trouble", null)

    internal fun trouble(context: Context, why: String?) = prefs(context).edit().putString("trouble", why).apply()

    /** Shown at all: Android's permission (13 and later) and the app's switch in Settings. */
    fun allowed(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /** The node keeps them for this phone from now on, and Android asks for them. */
    suspend fun turnOn(context: Context, client: NodeClient) {
        client.post("/api/notify/collect/on", Json.obj())
        channels(context)
        val job = JobInfo.Builder(JOB, ComponentName(context, CollectJob::class.java))
            .setPeriodic(15 * 60_000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build()
        jobs(context).schedule(job)
    }

    /**
     * Instant from now on, through [distributor] (UnifiedPush): it gives an endpoint, which the node is told of (the
     * receiver's work); until then, and if that fails, they are collected.
     */
    suspend fun makeInstant(context: Context, client: NodeClient, distributor: String) {
        val vapid = client.get("/api/notify")["key"].string ?: throw NodeError(0, "Your node has no notification key.")
        trouble(context, null)
        UnifiedPush.register(context, distributor, vapid)
    }

    /**
     * Instant through another distributor than the one they come through now: collected meanwhile (so nothing is lost
     * while the new one gives its endpoint), the old one told this phone is gone, the new one asked.
     */
    suspend fun switchTo(context: Context, client: NodeClient, distributor: String) {
        turnOn(context, client)
        UnifiedPush.unregister(context)
        makeInstant(context, client, distributor)
    }

    /** Off here, and on the node: it keeps and sends nothing more for this phone. */
    suspend fun turnOff(context: Context, client: NodeClient?) {
        stop(context)
        UnifiedPush.unregister(context)
        client?.post("/api/notify/unsubscribe", Json.obj())
    }

    /** This phone stops asking (the node already said they're off, or this phone forgot its node). */
    fun stop(context: Context) = jobs(context).cancel(JOB)

    private fun channels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "An approval, a question, something that needs you." })
        manager.createNotificationChannel(NotificationChannel(NEWS, "News", NotificationManager.IMPORTANCE_LOW).apply { description = "Work that ended, what your rules and loops tell you, the day's digest: quietly." })
    }

    /**
     * What the node kept for this phone, shown ([show] false: taken and dropped, as when the app is in front and shows
     * it all itself). False: the node says they're off for this phone (turned off somewhere else).
     */
    suspend fun collect(context: Context, client: NodeClient, show: Boolean = true): Boolean {
        val answer = client.post("/api/notify/collect", Json.obj())
        if (show && allowed(context)) for (n in answer["notifications"].list) present(context, NotifyPayload.read(n) ?: NotifyPayload.GENERIC)
        takeDown(context, answer["withdrawn"].list.mapNotNull { it.string })
        return answer["on"].bool == true
    }

    /** The notifications still shown whose matter was answered, dismissed, cleared or lapsed on any device: taken down. */
    fun takeDown(context: Context, tags: List<String>) {
        if (tags.isEmpty()) return
        val manager = context.getSystemService(NotificationManager::class.java)
        for (tag in tags) if (NotifyPayload.isTag(tag)) manager.cancel(tag, 0)
    }

    /**
     * One that came through UnifiedPush, read as strictly as the web app's service worker reads one (core's
     * readNotifyPayload): one that isn't a payload of ours is shown only as "something needs you", never as what it says.
     */
    fun showPushed(context: Context, payload: Json?) {
        if (allowed(context)) present(context, NotifyPayload.read(payload) ?: NotifyPayload.GENERIC)
    }

    /** Shown; quietly (no sound, no pop-up: the shade alone) while the app is in front showing that very thing. */
    private fun present(context: Context, n: NotifyPayload.Notice) {
        val app = AppModel.of(context)
        show(context, n, quiet = app.front.value && NotifyPayload.aboutWhatShows(n, app.showing.value))
    }

    /** The app, opened at a place: what a tap or a button hands it (read again there, `opening`). */
    private fun app(context: Context) = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    /** A button that opens the app, behind the phone's own unlock. */
    private fun opener(context: Context, label: String, code: Int, intent: Intent): Notification.Action =
        Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_notify), label, PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAuthenticationRequired(true)
            .build()

    private fun show(context: Context, n: NotifyPayload.Notice, quiet: Boolean) {
        val tag = n.tag
        val open = app(context)
            .putExtra(OPEN, n.open)
            .apply {
                n.conversation?.let { putExtra(CONVERSATION, it) }
                n.task?.let { putExtra(TASK, it) }
            }
        val note = Notification.Builder(context, if (quiet || Reach.quiet(n.kind)) NEWS else NEEDS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(n.title)
            .setContentText(n.body)
            .setStyle(Notification.BigTextStyle().bigText(n.body))
            .setContentIntent(PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
        // Its buttons work only behind the phone's unlock, which Android 12 and later can ask for.
        if (Build.VERSION.SDK_INT >= 31) {
            val action = n.action
            if (action != null && n.kind == "approval") {
                // Approve… opens that approval's card, the whole request in front of you (a yes is never given from the lock
                // screen); a delete is approved only where its name is typed, in the app, all the same.
                if (n.approvable) note.addAction(opener(context, "Approve…", (tag + "approve").hashCode(), app(context).putExtra(OPEN, "inbox").putExtra(APPROVAL, action)))
                note.addAction(
                    Notification.Action.Builder(
                        Icon.createWithResource(context, R.drawable.ic_notify),
                        "Decline",
                        PendingIntent.getBroadcast(
                            context,
                            (tag + false).hashCode(),
                            Intent(context, NoticeAnswer::class.java).putExtra(ACTION, action).putExtra(APPROVE, false).putExtra(TAG, tag),
                            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                        ),
                    ).setAuthenticationRequired(true).build(),
                )
            }
            // A task's work that can be shipped: Ship it… opens the task with its ship asked (as the iPhone's, behind Face ID).
            val task = n.task
            if (task != null && n.ship) note.addAction(opener(context, "Ship it…", (tag + "ship").hashCode(), app(context).putExtra(OPEN, "task").putExtra(TASK, task).putExtra(SHIP, true)))
        }
        context.getSystemService(NotificationManager::class.java).notify(tag, 0, note.build())
    }

    /** Where a tapped notification, or one of its buttons, opens the app: read again here, as the app's own places only. */
    fun opening(intent: Intent): AppModel.Opening? {
        val open = intent.getStringExtra(OPEN) ?: return null
        val address = NotifyPayload.addressOf(open, intent.getStringExtra(TASK))
        return AppModel.Opening(
            address,
            conversation = intent.getStringExtra(CONVERSATION)?.takeIf { address == "chat" && NotifyPayload.isConversationId(it) },
            approval = intent.getStringExtra(APPROVAL)?.takeIf { address == "inbox" && NotifyPayload.isActionId(it) },
            ship = address.startsWith("task:") && intent.getBooleanExtra(SHIP, false),
        )
    }

    /** After an answer from the notification: a word of how it went, in its place. */
    fun said(context: Context, tag: String, title: String, body: String, passes: Boolean) {
        val note = Notification.Builder(context, NEEDS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(PendingIntent.getActivity(context, tag.hashCode(), Intent(context, MainActivity::class.java).putExtra(OPEN, "inbox"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
        // An answer that went through is said and goes; one that didn't stays until you look.
        if (passes) note.setTimeoutAfter(8_000)
        context.getSystemService(NotificationManager::class.java).notify(tag, 0, note.build())
    }

    internal fun answerOf(intent: Intent): Triple<String, Boolean, String>? {
        val action = intent.getStringExtra(ACTION) ?: return null
        return Triple(action, intent.getBooleanExtra(APPROVE, false), intent.getStringExtra(TAG) ?: "primary")
    }
}

/** Android's periodic ask: what the node kept for this phone, collected and shown. */
class CollectJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onStartJob(params: JobParameters): Boolean {
        val client = AppModel.of(this).client ?: run {
            Notices.stop(this)
            return false
        }
        scope.launch {
            // Turned off elsewhere (the web app, the terminal): this phone stops asking. A node out of reach is asked again next time.
            if (runCatching { Notices.collect(this@CollectJob, client) }.getOrNull() == false) Notices.stop(this@CollectJob)
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}

/**
 * Decline, from an approval's notification: signed by this phone, as the Inbox's answer is. Never a yes: Approve opens the
 * Inbox (a notification shown before that was so still asks for one here, and is told to open the app instead).
 */
class NoticeAnswer : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val (action, approve, tag) = Notices.answerOf(intent) ?: return
        if (approve) {
            Notices.said(context, tag, "Open Invincible to approve it", "A yes is given in the app, with the request in front of you.", passes = false)
            return
        }
        val client = AppModel.of(context).client ?: return
        val done = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                client.post("/api/actions/decide", Json.obj("id" to action, "approve" to approve))
                Notices.said(context, tag, if (approve) "Approved" else "Declined", "${Primary.name} goes on from there.", passes = true)
            } catch (e: NodeError) {
                Notices.said(context, tag, "Still in Needs you", e.message ?: "The answer didn't reach your node.", passes = false)
            } finally {
                done.finish()
            }
        }
    }
}
