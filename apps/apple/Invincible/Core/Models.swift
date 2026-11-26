import Foundation

/*
 * Keys and the providers they are for, as the PWA reads them (apps/web/src/lib/text.ts): which provider a pasted key is
 * from, a subscription's sign-in told apart from a key, what a coding plan is for, and what a provider needs once its
 * key is sealed. The node checks everything again.
 */

/// `GET /api/providers`: the providers your fleet uses, the presets the node knows (the coding plans among them), and the
/// subscription sign-ins it never takes for a key.
struct ProvidersView: Decodable, Sendable {
    struct Provider: Decodable, Sendable, Identifiable {
        let id: String
        let kind: String
        let baseUrl: String
        let secret: String?
        let label: String?
        let hasKey: Bool
        /// The address its key was added for, when that isn't `baseUrl` (it was pointed elsewhere since): the key isn't
        /// sent there. An older node says nothing.
        var keyElsewhere: String? = nil
    }

    struct Plan: Decodable, Sendable, Equatable {
        let name: String
        /// What its vendor's terms say of it, in a sentence.
        let says: String
        let terms: String
        let models: [String]
        /// What its vendor's terms let the primary do with it (an older node says nothing).
        var allows: Allows? = nil
    }

    /// `native`: the primary's own coding calls; `tools`: lent to an agent's coding tool ("unattended"), or only to one you
    /// run yourself ("interactive").
    struct Allows: Decodable, Sendable, Equatable {
        let native: Bool
        let tools: String
    }

    struct Preset: Decodable, Sendable, Identifiable {
        let id: String
        var kind: String? = nil
        var baseUrl: String? = nil
        var keyPrefixes: [String]? = nil
        var plan: Plan? = nil
        var note: String? = nil
    }

    struct SignInForm: Decodable, Sendable {
        let prefix: String
        let signIn: SignIn
    }

    /// A subscription's sign-in: whose, for which tool, and why it isn't taken as a key.
    struct SignIn: Decodable, Sendable, Equatable {
        let vendor: String
        let tool: String
        let why: String
    }

    var providers: [Provider]
    var presets: [Preset]
    /// An older node names none.
    var signIns: [SignInForm]? = nil
}

enum Models {
    /// A pasted value that is a subscription's sign-in, not a key (lib/text.ts' `detectSignIn`).
    static func signIn(_ key: String, in view: ProvidersView) -> ProvidersView.SignIn? {
        view.signIns?.first { key.hasPrefix($0.prefix) }?.signIn
    }

    /// The provider a key is from, by its prefix: the longest matching one wins (lib/text.ts' `detectProvider`).
    static func provider(of key: String, in view: ProvidersView) -> String? {
        if signIn(key, in: view) != nil { return nil }
        var best: (id: String, length: Int)?
        for preset in view.presets {
            for prefix in preset.keyPrefixes ?? [] where key.hasPrefix(prefix) && prefix.utf16.count > (best?.length ?? -1) {
                best = (preset.id, prefix.utf16.count)
            }
        }
        return best?.id
    }

    /// A coding plan in a line: who uses it, as its vendor's terms allow (lib/text.ts' `planLine`); nil for a preset that
    /// isn't one.
    static func planLine(_ preset: ProvidersView.Preset?) -> String? {
        guard let plan = preset?.plan else { return nil }
        guard let allows = plan.allows else { return "\(plan.name) is a coding plan: its key is for coding, and your agent's talk with you never uses it." }
        if allows.native { return "\(plan.name) is a coding plan: your agent and the other agents code on it, and their coding tools use it. Its talk with you never does." }
        if allows.tools == "unattended" { return "\(plan.name) is a coding plan its terms allow only inside the coding tools they name: an agent's coding tool runs on it, and so does one you run yourself (invincible run). Your agent never calls it itself." }
        return "\(plan.name) is a coding plan for interactive use only, by its terms: it is lent to a coding tool you run yourself (invincible run), and never to your agent or an agent's work."
    }

    /// `POST /api/providers`: a provider pointed at the key sealed under `secret`.
    struct ProviderRequest: Encodable, Sendable, Equatable {
        let id: String
        var kind: String? = nil
        var baseUrl: String? = nil
        let secret: String
    }

    /// What a provider needs once a key for it is sealed (lib/text.ts' `providerSetup`): the request that points it at
    /// the key (nil: nothing, or nothing this device may do), and what to say of it (nil: nothing to say). `baseUrl`: the
    /// address given with the key, for a preset with no address of its own (a Cloudflare AI Gateway), or another than its
    /// own (its plan's other region): it is set up there, where the key is pinned.
    static func setup(_ view: ProvidersView, provider: String, secret: String, mayConfigure: Bool, baseUrl: String? = nil) -> (request: ProviderRequest?, say: String?) {
        guard mayConfigure else { return (nil, nil) }
        let given = baseUrl.flatMap { $0.isEmpty ? nil : $0 }
        if let existing = view.providers.first(where: { $0.id == provider }) {
            let at = given ?? existing.baseUrl
            if existing.secret == secret, at == existing.baseUrl { return (nil, nil) }
            return (ProviderRequest(id: provider, kind: existing.kind, baseUrl: at, secret: secret), "\(provider) now uses this key.")
        }
        guard let preset = view.presets.first(where: { $0.id == provider }) else { return (nil, nil) }
        if preset.baseUrl?.isEmpty != false, let given { return (ProviderRequest(id: provider, baseUrl: given, secret: secret), planLine(preset) ?? "\(provider) is configured and ready.") }
        guard preset.baseUrl?.isEmpty == false else { return (nil, preset.note ?? "Add \(provider)'s base URL on the Models page to start using it.") }
        return (ProviderRequest(id: provider, baseUrl: given == preset.baseUrl ? nil : given, secret: secret), planLine(preset) ?? "\(provider) is configured and ready.")
    }
}
