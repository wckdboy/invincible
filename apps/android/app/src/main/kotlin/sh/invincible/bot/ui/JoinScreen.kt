@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package sh.invincible.bot.ui

import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.URI
import kotlinx.coroutines.launch
import sh.invincible.bot.app.AppModel
import sh.invincible.bot.app.PairedNode
import sh.invincible.bot.core.DeviceKey
import sh.invincible.bot.core.HttpPairTransport
import sh.invincible.bot.core.Invite
import sh.invincible.bot.core.Joining
import sh.invincible.bot.core.NodeClient
import sh.invincible.bot.core.NodeError
import sh.invincible.bot.core.NodeProof
import sh.invincible.bot.core.string
import sh.invincible.bot.core.get

private sealed interface Stage {
    data object Ready : Stage
    data object Asking : Stage
    data class Waiting(val code: String, val retrying: Boolean = false) : Stage
    data class Failed(val why: String, val forgetKey: Boolean = false) : Stage
}

/** An address this phone may reach without TLS: itself (or, on an emulator, the computer it runs on). */
private fun local(origin: String): Boolean = runCatching { URI(origin).host }.getOrNull() in setOf("127.0.0.1", "localhost", "10.0.2.2", "::1", "[::1]")

/**
 * Joining your the primary, as the PWA's pairing page and the Apple app do it: paste (or open) the invite your node made,
 * compare the six-digit code here with the one your node shows, and approve it there. The invite's secret never leaves
 * this phone, and an approval is trusted only with the proof that only the invite's holder can make.
 */
@Composable
fun JoinScreen(app: AppModel) {
    val handed by app.handed.collectAsState()
    var link by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("Invincible app on ${Build.MODEL}".take(64)) }
    var stage by remember { mutableStateOf<Stage>(Stage.Ready) }
    val scope = rememberCoroutineScope()
    val brand = LocalBrand.current

    LaunchedEffect(handed) {
        handed?.let {
            link = it
            app.handed.value = null
        }
    }

    fun join() {
        stage = Stage.Asking
        scope.launch {
            stage = try {
                val node = joined(link, name.trim().ifEmpty { "Invincible app on Android" }) { stage = it }
                app.paired(node)
                Stage.Ready
            } catch (e: Joining.Stop.AlreadyEnrolled) {
                Stage.Failed("This phone's key is in the fleet already, but its node doesn't know it now. Forget the key here and ask again with a fresh invite.", forgetKey = true)
            } catch (e: Invite.Refused) {
                Stage.Failed(e.message ?: "That isn't an Invincible invite.")
            } catch (e: Joining.Stop) {
                Stage.Failed(e.message ?: "Joining stopped.")
            } catch (e: NodeError) {
                Stage.Failed(e.message ?: "The node couldn't be asked.")
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(Space.s6),
        verticalArrangement = Arrangement.spacedBy(Space.s4),
    ) {
        Spacer(Modifier.height(Space.s10))
        AppMark(56.dp)
        Text("Join your node", style = MaterialTheme.typography.headlineLargeEmphasized)
        Text(
            "On your node, run invincible invite --client, or choose Join a device in the app there. Paste the link it gives you, or open it on this phone.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        when (val s = stage) {
            is Stage.Waiting -> {
                Text("Compare this code with the one your node shows, then approve it there.", style = MaterialTheme.typography.bodyLarge)
                Text(
                    s.code,
                    fontSize = 44.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.semantics { contentDescription = "The code: ${s.code.replace(" ", "")}" },
                )
                Text(
                    if (s.retrying) "The node isn't answering. Asking again…" else "Waiting for your approval on the node.",
                    color = if (s.retrying) brand.needs else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            else -> {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    label = { Text("Invite link") },
                    placeholder = { Text("https://…/#pair=gi1.…") },
                    minLines = 2,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(64) },
                    label = { Text("This phone's name, as your devices list it") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (s is Stage.Failed) {
                    Problem(s.why)
                    if (s.forgetKey) {
                        OutlinedButton(onClick = { runCatching { DeviceKey.forget() }; stage = Stage.Ready }) { Text("Forget this phone's key") }
                    }
                }
                Button(
                    onClick = ::join,
                    enabled = link.isNotBlank() && s != Stage.Asking,
                    modifier = Modifier.fillMaxWidth().height(Space.touch),
                ) { Text(if (s == Stage.Asking) "Asking…" else "Ask to join") }
            }
        }
        Spacer(Modifier.height(Space.s4))
        Text(
            "This phone makes a key of its own, kept in its secure hardware and never sent anywhere. Every request it makes is signed with it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.Start),
        )
    }
}

/** The whole join: the invite read, this phone's key, the ask (or the ask it made before), your approval, then who it is. */
private suspend fun joined(link: String, name: String, stage: (Stage) -> Unit): PairedNode {
    val invite = Invite.decode(link)
    if (invite.k != "client") throw Invite.Refused("That invite is for a node, not a phone: on your node, run invincible invite --client.")
    val origin = Joining.origin(link, invite) ?: throw Invite.Refused("That invite gives no address this phone can reach.")
    if (origin.startsWith("http://") && !local(origin)) {
        throw Invite.Refused("This phone joins over HTTPS: open the invite as the https:// link your node gave (its tailscale serve address) rather than the bare invite.")
    }
    val key = DeviceKey.loadOrCreate()
    val joining = Joining(invite, key.device, HttpPairTransport(origin))
    // Asked before (the app closed while it waited)? The status proof tells: approved, still pending, or never asked.
    val asked = try {
        joining.approved()
    } catch (_: Joining.Stop) {
        null
    }
    if (asked == null) {
        try {
            joining.ask(name)
        } catch (_: Joining.Stop.AlreadyUsed) {
            // (Approved while away, or not: waiting tells.)
        } catch (e: Joining.Stop.AlreadyEnrolled) {
            // Enrolled already: if the node answers this phone's signature, it's paired.
            if (runCatching { NodeClient(origin, key).get("/api/whoami") }.isFailure) throw e
        }
    }
    if (asked != true) {
        stage(Stage.Waiting(joining.code))
        joining.approval(onRetry = { stage(Stage.Waiting(joining.code, it)) })
    }
    // Approved: what the node says this phone is, and which node it is, proven: pinned from the pairing, and named in what
    // this phone signs from then on (the slice 8 note's item 11). A node from before proves nothing: pinned at the first
    // proof it gives.
    val challenge = NodeProof.challenge()
    val who = NodeClient(origin, key).provenWhoami(challenge)
    val proven = NodeProof.judge(null, who["node"].string, who["proof"].string, challenge)
    if (proven == NodeProof.Proven.Failed) throw Joining.Stop.Ended("The node's proof of which node it is didn't hold: this phone isn't paired with it.")
    return PairedNode(origin, key.device, name, invite.f, who["nodeName"].string, who["fleetName"].string, (proven as? NodeProof.Proven.Pin)?.node)
}
