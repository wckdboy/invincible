import SwiftUI

/// `GET /api/secrets`: a key sealed in the vault, as far as anyone ever sees it: its name, where it may go, its last
/// four characters. Never its value.
struct SecretView: Decodable, Sendable, Identifiable, Equatable {
    let name: String
    let provider: String?
    let hint: String?
    /// The only origin this key is ever sent to (nil: pinned nowhere, so never used).
    let origin: String?
    let label: String?
    /// An HLC.
    let updatedAt: String
    let updatedBy: String
    var id: String { name }
}

/**
 * The vault, as this device may see it: every key sealed for your full nodes, each pinned to the one address it may
 * ever be sent to, its value never shown again and never seen by a model (the PWA's Vault). Add one (a provider's or a
 * coding plan's is recognised and its provider set up), replace one (it stays pinned where it was), or delete one by
 * typing its name. Copies you chose to keep on this iPhone are listed too, to seal again where a node lost them.
 */
struct KeysView: View {
    let session: Session
    @State private var keys: [SecretView]?
    @State private var providers: ProvidersView?
    @State private var kept: [PhoneKeys.Kept] = []
    @State private var unlocked = true
    @State private var problem: String?
    /// What the last seal did beyond sealing: a provider set up, a plan explained.
    @State private var notice: String?
    @State private var adding = false
    @State private var replacing: SecretView?
    @State private var deleting: SecretView?
    @State private var typed = ""

    var body: some View {
        GroupedList {
            // What a key here is, in a line under the title: no card round it.
            Section {
                PageNote("Sealed for your full nodes: never shown again, never seen by a model. The node adds a key to a call itself, and only to the address it's pinned to.\(PhoneKeys.offered ? " A copy stays on this iPhone only when you choose to keep one." : "")")
                    .listRowSeparator(.hidden)
                if !unlocked {
                    Label("This node holds no vault grant yet, so it can't use these keys. Another full node can.", systemImage: "lock.trianglebadge.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.primary)
                        .listRowSeparator(.hidden)
                }
            }
            if let notice {
                Section { Label(notice, systemImage: "checkmark.seal").font(.footnote) }
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
            if let keys, !keys.isEmpty {
                Section {
                    ForEach(keys) { key in
                        KeyRow(key: key, plan: plan(of: key.provider))
                            .swipeActions(edge: .trailing) {
                                if session.can("vault:write") {
                                    Button(role: .destructive) {
                                        typed = ""
                                        deleting = key
                                    } label: { Label("Delete", systemImage: "trash") }
                                    Button { replacing = key } label: { Label("Replace", systemImage: "arrow.triangle.2.circlepath") }
                                        .tint(.ink)
                                }
                            }
                            .contextMenu {
                                if session.can("vault:write") {
                                    Button { replacing = key } label: { Label("Replace its key", systemImage: "arrow.triangle.2.circlepath") }
                                    Button(role: .destructive) {
                                        typed = ""
                                        deleting = key
                                    } label: { Label("Delete…", systemImage: "trash") }
                                }
                            }
                    }
                } header: {
                    SectionHead(title: "Sealed", count: keys.count)
                }
            }
            if !kept.isEmpty {
                Section {
                    ForEach(kept) { copy in
                        VStack(alignment: .leading, spacing: Space.line) {
                            Text(copy.name).font(.body.monospaced())
                            Text([copy.provider.map { "For \($0)" }, copy.label].compactMap { $0 }.joined(separator: " · ").ifEmpty("A key of your own"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("Kept \(copy.keptAt.formatted(.relative(presentation: .named)))").font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, Space.s1)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { forget(copy) } label: { Label("Delete copy", systemImage: "trash") }
                            if session.can("vault:write") {
                                Button { Task { await sealAgain(copy) } } label: { Label("Seal again", systemImage: "arrow.up.doc") }.tint(.ink)
                            }
                        }
                        .contextMenu {
                            if session.can("vault:write") {
                                Button { Task { await sealAgain(copy) } } label: { Label("Seal it on your nodes again", systemImage: "arrow.up.doc") }
                            }
                            Button(role: .destructive) { forget(copy) } label: { Label("Delete this iPhone's copy", systemImage: "trash") }
                        }
                    }
                } header: {
                    SectionHead("On this iPhone")
                } footer: {
                    PageNote("In this iPhone's Keychain, for this device alone, read back only with Face ID or your passcode. Swipe one to seal it on your nodes again.")
                }
            }
            if let providers, !providers.providers.isEmpty {
                Section {
                    ForEach(providers.providers) { provider in
                        HStack {
                            VStack(alignment: .leading, spacing: Space.line) {
                                Text(provider.id).font(.body.monospaced())
                                if let plan = plan(of: provider.id) { Text(plan.name).font(.caption).foregroundStyle(.secondary) }
                                // Pointed elsewhere since its key was added: the key stays where it was, and this says so.
                                if let elsewhere = provider.keyElsewhere {
                                    Text("Its key was added for \(elsewhere). Add it again with \(provider.baseUrl) as its other address.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: Space.s2)
                            // Where its key stands, a dot and its word: nothing here went wrong, so nothing is red.
                            StateLabel(word: provider.hasKey ? "Key sealed" : provider.keyElsewhere != nil ? "Key for another address" : "No key yet", tone: provider.hasKey ? .quiet : .active)
                                .font(.caption)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    SectionHead("Providers")
                }
            }
        }
        .hairlinePage()
        .screen("keys.screen")
        .placeTitle("Keys")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Label("Add a key", systemImage: "plus") }
                    .disabled(!session.can("vault:write"))
            }
        }
        .overlay {
            if keys == nil, problem == nil {
                ProgressView()
            } else if keys?.isEmpty == true, kept.isEmpty {
                ContentUnavailableView("No keys yet", systemImage: "key", description: Text("Add a provider's key, a coding plan's or a service's, and it's sealed for every full node. \(Primary.name) asks for one it needs in Needs you."))
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $adding) { AddKeySheet(session: session, providers: providers, replacing: nil) { said in notice = said; await load() } }
        .sheet(item: $replacing) { key in AddKeySheet(session: session, providers: providers, replacing: key) { said in notice = said; await load() } }
        .alert("Delete \(deleting?.name ?? "")?", isPresented: .init(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            TextField(deleting?.name ?? "", text: $typed)
                .capitals(.never)
                .autocorrectionDisabled()
            Button("Delete key", role: .destructive) { if let key = deleting { Task { await delete(key) } } }
                .disabled(typed != deleting?.name)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It's removed from the vault on every node, and what uses it stops working until you add a key again. This doesn't revoke it at its provider: do that there if it may have leaked. \(PhoneKeys.offered ? "A copy on this iPhone stays until you delete it. " : "")Type its name to delete it.")
        }
    }

    private func plan(of provider: String?) -> ProvidersView.Plan? {
        providers?.presets.first { $0.id == provider }?.plan
    }

    private func load() async {
        struct Listed: Decodable { let secrets: [SecretView]; let unlocked: Bool }
        kept = PhoneKeys.list()
        // Both read before either is shown: the providers shown first had the sealed keys come in above them.
        let found = try? await session.client.get("/api/providers", as: ProvidersView.self)
        do {
            let listed = try await session.client.get("/api/secrets", as: Listed.self)
            if let found { providers = found }
            (keys, unlocked, problem) = (listed.secrets.sorted { $0.name < $1.name }, listed.unlocked, nil)
        } catch {
            if let found { providers = found }
            problem = "The vault couldn't be read: \(error.localizedDescription)"
            if keys == nil { keys = [] }
        }
    }

    private func delete(_ key: SecretView) async {
        struct Delete: Encodable { let name: String }
        do {
            _ = try await session.client.post("/api/secrets/delete", Delete(name: key.name), as: JSONValue.self)
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }

    private func forget(_ copy: PhoneKeys.Kept) {
        do {
            try PhoneKeys.forget(name: copy.name)
            kept = PhoneKeys.list()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// This iPhone's copy sealed on your nodes again, once you have shown it is you.
    private func sealAgain(_ copy: PhoneKeys.Kept) async {
        do {
            let value = try await PhoneKeys.value(of: copy.name, reason: "Seal \(copy.name) on your nodes again")
            notice = try await Sealing.seal(session: session, providers: providers, name: copy.name, value: value, provider: copy.provider, label: copy.label, baseUrl: nil) ?? "\(copy.name) is sealed on your nodes again."
            problem = nil
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

extension String {
    /// This, or `other` when it is empty.
    func ifEmpty(_ other: String) -> String { isEmpty ? other : self }
}

/// Sealing a key, and setting up the provider it is for (the PWA's `sealSecret`): what that did beyond sealing, in words.
@MainActor enum Sealing {
    struct Secret: Encodable { let name: String; let value: String; var provider: String?; var label: String?; var baseUrl: String? }

    static func seal(session: Session, providers: ProvidersView?, name: String, value: String, provider: String?, label: String?, baseUrl: String?) async throws -> String? {
        _ = try await session.client.post("/api/secrets", Secret(name: name, value: value, provider: provider, label: label, baseUrl: baseUrl), as: JSONValue.self)
        guard let provider, let providers else { return nil }
        let setup = Models.setup(providers, provider: provider, secret: name, mayConfigure: session.can("brain:write"), baseUrl: baseUrl)
        if let request = setup.request {
            do {
                _ = try await session.client.post("/api/providers", request, as: JSONValue.self)
            } catch {
                return "The key is sealed, but setting up \(provider) failed: \(error.localizedDescription)"
            }
        }
        return setup.say
    }
}

/// A sealed key: its name, what it's for, and where it may ever go.
private struct KeyRow: View {
    let key: SecretView
    /// The coding plan it is the key of, when it is one.
    var plan: ProvidersView.Plan? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Space.line) {
            HStack(alignment: .firstTextBaseline) {
                Text(key.name).font(.body.monospaced())
                if let hint = key.hint { Text(hint).font(.caption.monospaced()).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
            }
            if let label = key.label, !label.isEmpty { Text(label).font(.subheadline) }
            if let plan { Label(plan.name, systemImage: "hammer").font(.caption).foregroundStyle(.secondary) }
            // Keys are pinned: shown so you can see exactly where this one may ever go.
            if let origin = key.origin {
                Text("only to \(origin.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            } else {
                Text("pinned nowhere: never used").font(.caption.weight(.semibold)).foregroundStyle(.primary)
            }
            if let at = hlcDate(key.updatedAt) {
                Text("Sealed \(at.formatted(.relative(presentation: .named)))").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, Space.s1)
        .accessibilityElement(children: .combine)
    }
}

/// Sealing a key: the key first, in a secure field cleared before anything is sent; then what it's for (a provider's
/// or a coding plan's is recognised from its prefix, the PWA's way, and a subscription's sign-in is never taken for one),
/// its name, and whether this iPhone keeps a copy. Replacing one keeps its name, what it's for and where it's pinned.
private struct AddKeySheet: View {
    let session: Session
    let providers: ProvidersView?
    let replacing: SecretView?
    /// Called once it is sealed, with what that did beyond sealing.
    let done: (String?) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var provider = ""
    /// A provider you chose yourself is never changed by what the key looks like.
    @State private var chosen = false
    @State private var address = ""
    /// Another address than a provider's own was asked for (its plan's other region).
    @State private var another = false
    @State private var label = ""
    @State private var value = ""
    @State private var keepCopy = true
    @State private var sealing = false
    @State private var problem: String?

    /// "A key of your own": no provider, pinned to the address you give.
    private static let own = "__own"
    private var nameOK: Bool { name.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil }
    private var presets: [ProvidersView.Preset] { providers?.presets ?? [] }
    private var preset: ProvidersView.Preset? { presets.first { $0.id == provider } }
    /// A preset with no address of its own (a Cloudflare AI Gateway): its key goes only to the address you give with it.
    private var needsAddress: Bool { preset.map { $0.baseUrl?.isEmpty != false } ?? false }
    /// Another address than its own, for a provider chosen: only one you type, here, next to the key (never one read
    /// back from its configuration).
    private var mayGiveAnother: Bool { !provider.isEmpty && provider != Self.own && !needsAddress }
    private var addressShown: Bool { provider == Self.own || needsAddress || (another && mayGiveAnother) }
    private var signIn: ProvidersView.SignIn? { providers.flatMap { Models.signIn(value.trimmingCharacters(in: .whitespacesAndNewlines), in: $0) } }
    /// Your own providers that aren't one of the node's presets.
    private var yours: [ProvidersView.Provider] { (providers?.providers ?? []).filter { mine in !presets.contains { $0.id == mine.id } } }

    var body: some View {
        NavigationStack {
            Form {
                // The key first: it's what you came with, and it stays above the keyboard.
                Section {
                    // (No password content type: an API key is no password of yours for AutoFill to keep.)
                    FormField("Paste the key", text: $value, secure: true)
                        .capitals(.never)
                        .autocorrectionDisabled()
                        .onChange(of: value) { _, _ in recognise() }
                        .accessibilityIdentifier("key-value")
                } header: {
                    Text("Key")
                } footer: {
                    Text("Recognised from how it begins, where it can be. Never shown again, never seen by a model.")
                }
                if let signIn {
                    Section {
                        Label {
                            VStack(alignment: .leading, spacing: Space.s2) {
                                Text(signIn.why)
                                Text("To work on your \(signIn.vendor) subscription, sign \(signIn.tool) in inside an agent's VM, with \(signIn.vendor)'s own sign-in.")
                            }
                            .font(.footnote)
                        } icon: {
                            Image(systemName: "person.badge.key").foregroundStyle(Color.danger)
                        }
                    } header: {
                        Text("A \(signIn.tool) sign-in, not a key")
                    }
                }
                if let replacing {
                    Section {
                        LabeledContent("Name") { Text(replacing.name).font(.body.monospaced()) }
                        if let origin = replacing.origin { LabeledContent("Only to") { Text(origin).font(.footnote.monospaced()) } }
                    } footer: {
                        Text("The new key takes its place, pinned where the old one was.")
                    }
                } else {
                    Section {
                        Picker("For", selection: Binding(get: { provider }, set: { pick($0) })) {
                            Text("Choose…").tag("")
                            let plans = presets.filter { $0.plan != nil }
                            if !plans.isEmpty {
                                Section("Coding plans") { ForEach(plans) { Text($0.plan?.name ?? $0.id).tag($0.id) } }
                            }
                            Section("Providers") { ForEach(presets.filter { $0.plan == nil }) { Text($0.id).tag($0.id) } }
                            if !yours.isEmpty {
                                Section("Yours") { ForEach(yours) { Text($0.id).tag($0.id) } }
                            }
                            Text("A key of your own").tag(Self.own)
                        }
                        .accessibilityIdentifier("key-provider")
                        if addressShown {
                            FormField((needsAddress ? "Its address, https://…" : provider == Self.own ? "Only sent to, e.g. https://api.example.com" : "Another address, https://…") as String, text: $address)
                                .keyboard(.url)
                                .capitals(.never)
                                .autocorrectionDisabled()
                        } else if mayGiveAnother {
                            Button("Another address") { another = true }
                        }
                    } header: {
                        Text("What it's for")
                    } footer: {
                        if another, mayGiveAnother {
                            Text("Its own is \(preset?.baseUrl ?? "the one it has"). Give another only where its page shows one (another region's): the key is only ever sent to the address you give.")
                        } else if let line = Models.planLine(preset), let plan = preset?.plan {
                            Text("\(line) \(plan.says)")
                        } else if let note = preset?.note, preset?.baseUrl?.isEmpty != false {
                            Text(note)
                        } else if provider == Self.own {
                            Text("A key of your own is sent only to the address you give, and never used without one.")
                        } else {
                            Text("A provider or a coding plan pins it to its own address.")
                        }
                    }
                    Section {
                        FormField("e.g. anthropic", text: $name).font(.body.monospaced()).capitals(.never).autocorrectionDisabled()
                    } header: {
                        Text("Name")
                    } footer: {
                        Text("Letters, digits and . _ : - (a provider's own name ties the key to it).")
                    }
                    Section("Label") { FormField("e.g. personal account", text: $label) }
                }
                if PhoneKeys.offered {
                    Section {
                        Toggle("Keep a copy on this \(ThisDevice.kind)", isOn: $keepCopy)
                    } footer: {
                        Text("In this \(ThisDevice.kind)'s Keychain, for this device alone, read back only with Face ID or your passcode: to seal it again where a node lost it.")
                    }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
                }
            }
            .navigationTitle(replacing.map { "Replace \($0.name)" } ?? "Add a key")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Seal") { Task { await seal() } }
                        .disabled(value.isEmpty || sealing || (replacing == nil && !nameOK) || (signIn != nil && provider != Self.own))
                }
            }
        }
        .sheetSize(width: 560, height: 640)
    }

    /// What the key looks like chooses its provider, and its name, until you choose them.
    private func recognise() {
        guard replacing == nil, !chosen, let providers else { return }
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // A sign-in is no provider's key: what an earlier part of it looked like is not kept (typed, `sk-ant-` came first).
        if Models.signIn(key, in: providers) != nil {
            if presets.contains(where: { $0.id == name }) { name = "" }
            provider = ""
            return
        }
        guard let found = Models.provider(of: key, in: providers) else { return }
        provider = found
        if name.isEmpty || presets.contains(where: { $0.id == name }) { name = found }
    }

    private func pick(_ id: String) {
        provider = id
        chosen = true
        if id != Self.own, name.isEmpty || presets.contains(where: { $0.id == name }) || yours.contains(where: { $0.id == name }) { name = id }
    }

    private func seal() async {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // The field is cleared before anything is sent: the key is never shown back.
        value = ""
        guard !key.isEmpty, !sealing else { return }
        let trimmed = { (text: String) -> String? in
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        let (keyName, keyProvider, keyLabel, keyAddress): (String, String?, String?, String?) = if let replacing {
            // Pinned where it was: the address it was entered with is given again, so the node pins it there.
            (replacing.name, replacing.provider, replacing.label, replacing.origin)
        } else {
            (name, provider == Self.own ? nil : trimmed(provider), trimmed(label), addressShown ? trimmed(address) : nil)
        }
        sealing = true
        defer { sealing = false }
        do {
            let said = try await Sealing.seal(session: session, providers: replacing == nil ? providers : nil, name: keyName, value: key, provider: keyProvider, label: keyLabel, baseUrl: keyAddress)
            var kept: String?
            if keepCopy {
                do {
                    try PhoneKeys.keep(name: keyName, value: key, provider: keyProvider, label: keyLabel)
                } catch {
                    kept = "It is sealed on your nodes, but this iPhone couldn't keep a copy: \(error.localizedDescription)"
                }
            }
            let message = [said, kept].compactMap { $0 }.joined(separator: " ")
            await done(message.isEmpty ? nil : message)
            dismiss()
        } catch {
            problem = "\(error.localizedDescription). Paste it again."
        }
    }
}
