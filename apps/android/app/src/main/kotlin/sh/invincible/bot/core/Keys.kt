package sh.invincible.bot.core

/*
 * Keys and the providers they are for, as the PWA reads them (apps/web/src/lib/text.ts) and the Apple app does
 * (Core/Models.swift): which provider a pasted key is from, a subscription's sign-in told apart from a key, what a coding
 * plan is for, and what a provider needs once its key is sealed. The node checks everything again; the parity vectors'
 * `keys` hold this answer for answer.
 */

/** `GET /api/providers`: the providers your fleet uses, the presets the node knows (coding plans among them), and the sign-ins it never takes for a key. */
class Providers(val providers: List<Provider>, val presets: List<Preset>, val signIns: List<SignInForm>) {
    data class Provider(val id: String, val kind: String, val baseUrl: String, val secret: String?, val label: String?, val hasKey: Boolean, val keyElsewhere: String?)

    /** A coding plan: its name, what its vendor's terms say, and what they let the primary do (an older node says nothing). */
    data class Plan(val name: String, val says: String, val terms: String, val models: List<String>, val allows: Allows?)

    /** `native`: the primary's own coding calls; `tools`: lent to an agent's coding tool ("unattended"), or only to one you run ("interactive"). */
    data class Allows(val native: Boolean, val tools: String)

    data class Preset(val id: String, val kind: String?, val baseUrl: String?, val keyPrefixes: List<String>, val plan: Plan?, val note: String?)

    data class SignInForm(val prefix: String, val signIn: SignIn)

    /** A subscription's sign-in: whose, for which tool, and why it isn't taken as a key. */
    data class SignIn(val vendor: String, val tool: String, val why: String)

    companion object {
        fun of(j: Json?): Providers = Providers(
            j["providers"].list.map { p ->
                Provider(p["id"].string ?: "", p["kind"].string ?: "", p["baseUrl"].string ?: "", p["secret"].string, p["label"].string, p["hasKey"].bool ?: false, p["keyElsewhere"].string)
            },
            j["presets"].list.map { p ->
                val plan = p["plan"].takeIf { it is Json.Obj }?.let { plan ->
                    val allows = plan["allows"].takeIf { it is Json.Obj }?.let { Allows(it["native"].bool ?: false, it["tools"].string ?: "") }
                    Plan(plan["name"].string ?: "", plan["says"].string ?: "", plan["terms"].string ?: "", plan["models"].list.mapNotNull { it.string }, allows)
                }
                Preset(p["id"].string ?: "", p["kind"].string, p["baseUrl"].string, p["keyPrefixes"].list.mapNotNull { it.string }, plan, p["note"].string)
            },
            j["signIns"].list.mapNotNull { f ->
                val s = f["signIn"]
                SignInForm(f["prefix"].string ?: return@mapNotNull null, SignIn(s["vendor"].string ?: "", s["tool"].string ?: "", s["why"].string ?: ""))
            },
        )
    }
}

object Keys {
    /** A pasted value that is a subscription's sign-in, not a key (text.ts' `detectSignIn`). */
    fun signIn(key: String, view: Providers): Providers.SignIn? = view.signIns.firstOrNull { key.startsWith(it.prefix) }?.signIn

    /** The provider a key is from, by its prefix: the longest that matches wins (text.ts' `detectProvider`). */
    fun providerOf(key: String, view: Providers): String? {
        if (signIn(key, view) != null) return null
        var best: Pair<String, Int>? = null
        for (preset in view.presets) {
            for (prefix in preset.keyPrefixes) if (key.startsWith(prefix) && prefix.length > (best?.second ?: -1)) best = preset.id to prefix.length
        }
        return best?.first
    }

    /** A coding plan in a line: who uses it, as its vendor's terms allow (text.ts' `planLine`); null for a preset that isn't one. */
    fun planLine(preset: Providers.Preset?): String? {
        val plan = preset?.plan ?: return null
        val allows = plan.allows ?: return "${plan.name} is a coding plan: its key is for coding, and your agent's talk with you never uses it."
        if (allows.native) return "${plan.name} is a coding plan: your agent and the other agents code on it, and their coding tools use it. Its talk with you never does."
        if (allows.tools == "unattended") return "${plan.name} is a coding plan its terms allow only inside the coding tools they name: an agent's coding tool runs on it, and so does one you run yourself (invincible run). Your agent never calls it itself."
        return "${plan.name} is a coding plan for interactive use only, by its terms: it is lent to a coding tool you run yourself (invincible run), and never to your agent or an agent's work."
    }

    /** `POST /api/providers`: a provider pointed at the key sealed under `secret`. */
    data class ProviderRequest(val id: String, val kind: String? = null, val baseUrl: String? = null, val secret: String) {
        fun json(): Json = Json.obj("id" to id, "kind" to kind, "baseUrl" to baseUrl, "secret" to secret)
    }

    /**
     * What a provider needs once a key for it is sealed (text.ts' `providerSetup`): the request that points it at the key
     * (null: nothing, or nothing this device may do), and what to say of it (null: nothing). `baseUrl`: the address given
     * with the key, for a preset with no address of its own, or another than its own: it is set up there, where the key is pinned.
     */
    fun setup(view: Providers, provider: String, secret: String, mayConfigure: Boolean, baseUrl: String? = null): Pair<ProviderRequest?, String?> {
        if (!mayConfigure) return null to null
        val given = baseUrl?.takeIf { it.isNotEmpty() }
        view.providers.firstOrNull { it.id == provider }?.let { existing ->
            val at = given ?: existing.baseUrl
            if (existing.secret == secret && at == existing.baseUrl) return null to null
            return ProviderRequest(provider, existing.kind, at, secret) to "$provider now uses this key."
        }
        val preset = view.presets.firstOrNull { it.id == provider } ?: return null to null
        val ready = planLine(preset) ?: "$provider is configured and ready."
        if (preset.baseUrl.isNullOrEmpty() && given != null) return ProviderRequest(provider, baseUrl = given, secret = secret) to ready
        if (preset.baseUrl.isNullOrEmpty()) return null to (preset.note ?: "Add $provider's base URL on the Models page to start using it.")
        return ProviderRequest(provider, baseUrl = if (given == preset.baseUrl) null else given, secret = secret) to ready
    }

    /** A key's name, as the vault takes one. */
    fun nameOk(name: String): Boolean = Regex("^[A-Za-z0-9._:-]{1,128}$").matches(name)
}
