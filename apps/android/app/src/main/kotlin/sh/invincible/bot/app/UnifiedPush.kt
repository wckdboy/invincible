package sh.invincible.bot.app

import android.app.BroadcastOptions
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import sh.invincible.bot.core.Base64Url
import sh.invincible.bot.core.Json
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.WebPush

/**
 * Instant notifications through UnifiedPush (the owner's word, 21 Nov; spec AND_3.1.0, unifiedpush.org): a distributor
 * app on this phone (Sunup, on Mozilla's push service; ntfy; or another) keeps one connection to its push server for
 * every app that uses it. This app
 * registers with it and is given an endpoint, a URL on that server; the endpoint, with this phone's own Web Push key and
 * secret, is subscribed on the node as a browser's subscription is. The node encrypts each notification to that key (RFC
 * 8291), so the push server carries bytes it can't read; the distributor hands them here, and they're read and shown as
 * collected ones are. Until the node has the endpoint, and whenever the distributor goes, the phone collects them.
 */
object UnifiedPush {
    private const val REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    private const val UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
    private const val ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK"
    const val NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
    const val FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
    const val UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
    const val MESSAGE = "org.unifiedpush.android.connector.MESSAGE"

    /** A registration: the distributor, its token (ours alone), this phone's keys, and the endpoint once given. */
    class Registration(val distributor: String, val token: String, val keys: WebPush.Keys, val endpoint: String?)

    private fun prefs(context: Context) = context.getSharedPreferences("unifiedpush", Context.MODE_PRIVATE)

    /** The distributors on this phone: apps that take a registration. */
    fun distributors(context: Context): List<String> =
        context.packageManager.queryBroadcastReceivers(Intent(REGISTER), 0).mapNotNull { it.activityInfo?.packageName }.distinct().filter { it != context.packageName }

    /** A distributor's name, as its app calls itself. */
    fun label(context: Context, distributor: String): String =
        runCatching { context.packageManager.run { getApplicationLabel(getApplicationInfo(distributor, 0)).toString() } }.getOrDefault(distributor)

    fun registration(context: Context): Registration? {
        val p = prefs(context)
        val keys = WebPush.Keys(
            Base64Url.decode(p.getString("private", null) ?: return null) ?: return null,
            Base64Url.decode(p.getString("public", null) ?: return null) ?: return null,
            Base64Url.decode(p.getString("auth", null) ?: return null) ?: return null,
        )
        return Registration(p.getString("distributor", null) ?: return null, p.getString("token", null) ?: return null, keys, p.getString("endpoint", null))
    }

    /** Asks [distributor] for an endpoint, with fresh keys and a fresh token; the node's VAPID key goes with it. */
    fun register(context: Context, distributor: String, vapid: String) {
        val keys = WebPush.newKeys()
        val token = UUID.randomUUID().toString()
        prefs(context).edit()
            .putString("distributor", distributor)
            .putString("token", token)
            .putString("private", Base64Url.encode(keys.privateScalar))
            .putString("public", Base64Url.encode(keys.publicPoint))
            .putString("auth", Base64Url.encode(keys.auth))
            .remove("endpoint")
            .apply()
        send(context, distributor, Intent(REGISTER).putExtra("token", token).putExtra("vapid", vapid).putExtra("message", "Invincible's notifications"))
    }

    /** Off: the distributor forgets this app, and so does this phone. */
    fun unregister(context: Context) {
        registration(context)?.let { send(context, it.distributor, Intent(UNREGISTER).putExtra("token", it.token)) }
        prefs(context).edit().clear().apply()
    }

    internal fun ended(context: Context) = prefs(context).edit().clear().apply()

    internal fun keep(context: Context, endpoint: String) = prefs(context).edit().putString("endpoint", endpoint).apply()

    internal fun ack(context: Context, registration: Registration, id: String) =
        context.sendBroadcast(Intent(ACK).setPackage(registration.distributor).putExtra("token", registration.token).putExtra("id", id))

    private fun send(context: Context, distributor: String, intent: Intent) {
        intent.setPackage(distributor)
        // Who is asking: below Android 14, a PendingIntent the distributor reads this app's package from; from 14, the
        // broadcast shares this app's identity.
        intent.putExtra("pi", PendingIntent.getBroadcast(context, 0, Intent("org.unifiedpush.dummy_app").setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE))
        if (Build.VERSION.SDK_INT >= 34) context.sendBroadcast(intent, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
        else context.sendBroadcast(intent)
    }
}

/**
 * What a distributor says: an endpoint (subscribed on the node; collecting goes on as a backstop), a registration that failed or ended
 * (back to collecting), and messages (read, shown, acknowledged). A broadcast without this registration's token is
 * ignored: the token is the spec's gate, and a message that isn't for this phone's key doesn't decrypt anyway.
 */
class PushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val registration = UnifiedPush.registration(context) ?: return
        if (intent.getStringExtra("token") != registration.token) return
        when (intent.action) {
            UnifiedPush.NEW_ENDPOINT -> {
                val endpoint = intent.getStringExtra("endpoint")?.takeIf { it.startsWith("https://") } ?: return
                val client = AppModel.of(context).client ?: return
                val done = goAsync()
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        client.post(
                            "/api/notify/subscribe",
                            Json.obj("endpoint" to endpoint, "keys" to Json.obj("p256dh" to Base64Url.encode(registration.keys.publicPoint), "auth" to Base64Url.encode(registration.keys.auth))),
                        )
                        UnifiedPush.keep(context, endpoint)
                        // The node sends to the endpoint now. Collecting goes on beside it, seldom, as a backstop: what the
                        // distributor's server refuses (Android may not let it connect from the background, and ntfy's then
                        // answers 507) is kept on the node for this phone, and collected.
                    } catch (e: NodeError) {
                        // The node refused the push server (a self-hosted one it doesn't know): the phone goes on collecting.
                        Notices.trouble(context, e.message ?: "Your node refused that push server.")
                    } finally {
                        done.finish()
                    }
                }
            }
            UnifiedPush.FAILED, UnifiedPush.UNREGISTERED -> {
                UnifiedPush.ended(context)
                // A distributor that hands this phone on to another (`useDistributor`, as the spec has it) is followed,
                // if that one is here; otherwise back to collecting, if notifications are still on here.
                val next = intent.getStringExtra("useDistributor")?.takeIf { intent.action == UnifiedPush.UNREGISTERED && it in UnifiedPush.distributors(context) }
                val client = AppModel.of(context).client ?: return
                val done = goAsync()
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        runCatching { Notices.turnOn(context, client) }
                        if (next != null) runCatching { Notices.makeInstant(context, client, next) }
                    } finally {
                        done.finish()
                    }
                }
            }
            UnifiedPush.MESSAGE -> {
                val bytes = intent.getByteArrayExtra("bytesMessage") ?: return
                val payload = runCatching { Json.parse(String(WebPush.decrypt(bytes, registration.keys), Charsets.UTF_8)) }.getOrNull()
                Notices.showPushed(context, payload)
                intent.getStringExtra("id")?.let { UnifiedPush.ack(context, registration, it) }
            }
        }
    }
}
