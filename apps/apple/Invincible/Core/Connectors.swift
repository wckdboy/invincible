import Foundation

/*
 * Connectors as the node lists them (`GET /api/connectors`, core's ConnectorView) and as the PWA says where each one's
 * key stands (apps/web/src/lib/connector-state.ts): a key's words for most, a sign-in's for one that signs in as you.
 */

/// A connector the node knows: installed, or in its catalog to add.
struct ConnectorView: Decodable, Sendable, Identifiable {
    struct Tool: Decodable, Sendable, Identifiable {
        let name: String
        let description: String
        /// read · create · modify · outward · delete
        let `class`: String
        /// Outward and delete ask you; the rest run freely.
        let asks: Bool
        var id: String { name }
    }

    /// The primary's alone, and the agents you let use it, by label.
    struct Access: Decodable, Sendable { let only: String; let allowed: [String] }
    /// Whose sign-in it uses, and whose account it is signed in to (nil until then).
    struct OAuth: Decodable, Sendable { let provider: String; let account: String? }

    let id: String
    let label: String
    let description: String?
    let kind: String
    /// An MCP server's address (nil for the others).
    let url: String?
    let origin: String?
    let installed: Bool
    /// none-needed · ready · missing · optional-missing · signed-out · wrong-origin
    let key: String
    /// The vault secret its key is sealed under.
    let secret: String?
    let keyHelp: String?
    let needsOrigin: Bool
    let problem: String?
    let tools: [Tool]
    let access: Access?
    let oauth: OAuth?
    /// What it reads stays in the answer that read it (mail), as the bank's data does.
    let `private`: Bool
}

enum Connectors {
    /// A key's state in words, and its tone (lib/connector-state.ts' KEY_STATE).
    static let keyState: [String: (label: String, tone: String, explain: String)] = [
        "none-needed": ("no key needed", "neutral", "It works without a key."),
        "ready": ("key sealed", "ok", "Its key is sealed in the vault and only ever sent to this origin."),
        "missing": ("needs a key", "warn", "It can't do anything until its key is in the vault."),
        "optional-missing": ("public only", "neutral", "Public reads work without a key, at a lower rate limit. Add one to reach your own data."),
        "signed-out": ("not signed in", "warn", "Its app is sealed: sign in as yourself to use it."),
        "wrong-origin": ("key pinned elsewhere", "danger", "The vault holds a key under this name, but it's pinned to another origin, so it's never sent here. Replace it with one entered for this connector."),
    ]

    /// A sign-in's state in words, for a connector that signs in as you (lib/connector-state.ts' OAUTH_STATE).
    static let oauthState: [String: (label: String, tone: String)] = [
        "missing": ("needs your app", "warn"),
        "signed-out": ("not signed in", "warn"),
        "ready": ("signed in", "ok"),
        "wrong-origin": ("pinned elsewhere", "danger"),
    ]

    /// A hosted MCP server's sign-in (lib/connector-state.ts' MCP_SIGN_IN_STATE): no app of yours, so until you sign in
    /// it is just not signed in.
    static let mcpState = oauthState.merging(["missing": ("not signed in", "warn")]) { $1 }

    /// A connector's badge (lib/connector-state.ts' `connectorState`): `signIn` is whose sign-in it uses (google,
    /// microsoft, mcp), or nil for one with a key.
    static func state(key: String, signIn: String?) -> (label: String, tone: String)? {
        if let signIn, let state = (signIn == "mcp" ? mcpState : oauthState)[key] { return state }
        return keyState[key].map { ($0.label, $0.tone) }
    }

    /// Where Google sends you back: the app's own address on the node, which is what you register as the app's
    /// redirect URI (views/sign-in.ts' `callbackUrl`).
    static func callback(origin: URL) -> String {
        let text = origin.absoluteString
        return "\(text.hasSuffix("/") ? String(text.dropLast()) : text)/oauth/callback"
    }

    /// The class of a tool, as a person reads it.
    static func classLine(_ tool: ConnectorView.Tool) -> String {
        tool.asks ? "\(tool.class) · asks you first" : tool.class
    }
}
