import SwiftUI

/// An agent, new or changed (the PWA's agent form): its mark's colour, its name and handle, its job, its repository, the
/// harness and model role it works with, and its day's allowance. The node checks it all again when it is saved.
struct AgentEditor: View {
    let session: Session
    var existing: Agent?
    /// Called with the agent as the node saved it.
    var saved: (Agent) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var handle: String
    /// A handle you typed yourself stops following the name.
    @State private var handleTyped: Bool
    /// The colour you chose here for its mark (one of the eight, as its light form); nil: what it has, or (touched) its
    /// node's choice again.
    @State private var chosenColor: String?
    /// Whether its colour was chosen here: untouched, what is saved stays as it is (the PWA's avatarEditor).
    @State private var colorTouched = false
    @State private var instructions: String
    @State private var repository: String
    @State private var harness: String
    /// The command that starts its ACP agent in its VM (harness `acp`).
    @State private var acp: String
    @State private var role: String
    @State private var dailyTurns: Int
    @State private var enabled: Bool
    @State private var roles: [String: Agents.RoleInfo]?
    /// Its own models, in the order they are tried; the toggles offered, in an order kept while you edit (nil: none offered).
    @State private var own: [String]
    @State private var offered: [Agents.ModelChoice]?
    /// Sensitive mode: these models alone, for every call of its work (core's heldModels).
    @State private var sensitive: Bool
    /// Keys of yours it may use but never see (PLAN #17); the secrets it may be given, once read (nil: not read).
    @State private var keys: [Agent.KeyGrant]
    @State private var givable: [SecretView]?
    @State private var working = false
    @State private var problem: String?

    init(session: Session, existing: Agent? = nil, saved: @escaping (Agent) -> Void = { _ in }) {
        self.session = session
        self.existing = existing
        self.saved = saved
        _name = State(initialValue: existing?.name ?? "")
        _handle = State(initialValue: existing?.id ?? "")
        _handleTyped = State(initialValue: existing != nil)
        _instructions = State(initialValue: existing?.instructions ?? "")
        _repository = State(initialValue: existing?.repository ?? "")
        _harness = State(initialValue: existing?.harness ?? "native")
        _acp = State(initialValue: existing?.acp ?? "")
        _role = State(initialValue: existing?.role ?? "engineer")
        _own = State(initialValue: existing?.models ?? [])
        _sensitive = State(initialValue: existing?.sensitive ?? false)
        _keys = State(initialValue: existing?.keys ?? [])
        _dailyTurns = State(initialValue: existing?.dailyTurns ?? 40)
        _enabled = State(initialValue: existing?.enabled ?? true)
    }

    private var taken: [String] { (session.team?.agents.map(\.id) ?? []) + (session.team?.removed?.map(\.id) ?? []) }

    /// Its mark as it will be once saved, as its node gives one (AgentMark.assign: after the marks the others wear, which
    /// is all that counts): untouched, the one it has (a new agent, the one its node will give it); a colour you chose,
    /// that colour in its own form; its node's choice again, the one its node gives it now.
    private var mark: AgentMark {
        let id = handle.isEmpty ? "agent" : handle
        let others = (session.team?.agents ?? []).filter { $0.id != id }.map { AgentMark.of(id: $0.id, profile: $0.avatar) }
        if let existing {
            let now = AgentMark.of(id: existing.id, profile: existing.avatar)
            if !colorTouched { return now }
            if let chosenColor { return AgentMark(color: AgentMark.snap(chosenColor), form: now.form) }
        }
        return AgentMark.assign(id, after: others, chosen: colorTouched ? chosenColor : nil)
    }

    /// What its mark's colour is, in words.
    private var colorNote: String {
        if colorTouched, chosenColor != nil { return "The colour you chose. Its form stays its own." }
        if existing != nil, !colorTouched { return "The colour its node gave it. Choose another and its form stays its own." }
        return "Its node gives it a colour no other agent has, while one is free, and a form of its own."
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What stops it being saved, in words; nil: nothing.
    private var invalid: String? {
        if trimmedName.isEmpty { return "Give it a name." }
        if !Agents.isHandle(handle) { return "A handle is a lowercase letter, then at most 31 lowercase letters, digits or hyphens." }
        if existing == nil, taken.contains(handle) { return "The handle \(handle) is taken. Choose another." }
        if sensitive, own.isEmpty { return "Sensitive mode holds an agent to models of its own: choose them first." }
        if harness == "acp", acp.trimmingCharacters(in: .whitespaces).isEmpty { return "Name the command that starts its ACP agent, e.g. goose acp." }
        return nil
    }

    /// Whose words its job is, when they aren't yours.
    private var author: String? {
        guard let by = existing?.instructionsBy, by != "owner" else { return nil }
        return by == "primary" ? Primary.name : session.agent(by)?.name ?? by
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    MarkColorPicker(handle: handle, mark: mark, note: colorNote) { color in
                        chosenColor = color
                        colorTouched = true
                    }
                    .listRowBackground(Color.clear)
                } header: {
                    Text("Colour")
                }

                Section {
                    FormField("e.g. Ada", text: $name)
                        .capitals(.words)
                        .onChange(of: name) { _, new in if !handleTyped { handle = Agents.handle(name: new, taken: taken) } }
                        .accessibilityIdentifier("agent-name")
                    if existing == nil {
                        FormField("handle", text: Binding(get: { handle }, set: { handle = $0; handleTyped = true }))
                            .font(.body.monospaced())
                            .capitals(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("agent-handle")
                    } else {
                        LabeledContent("Handle") { Text(handle).font(.body.monospaced()) }
                    }
                } header: {
                    Text("Name")
                } footer: {
                    Text("The handle addresses this agent, and stays the same when it is renamed.")
                }

                Section {
                    if let author, let existing {
                        Label("\(author) wrote this job when making \(existing.name), and it is told to \(existing.name) as \(author)'s brief. Change its words here and they are yours.", systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    FormField("Their job, how they work, and when to ask you.", text: $instructions, axis: .vertical)
                        .lineLimit(5...14)
                        .accessibilityIdentifier("agent-job")
                } header: {
                    Text("Job and instructions")
                } footer: {
                    Text("No keys or passwords: those belong in Keys.")
                }

                Section {
                    FormField("https://github.com/owner/repository" as String, text: $repository)
                        .keyboard(.url)
                        .capitals(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Repository (optional)")
                } footer: {
                    Text("An HTTPS GitHub repository. Each task gets its own worktree of it in the agent's VM.")
                }

                Section {
                    Picker("Harness", selection: $harness) {
                        ForEach(Agents.harnesses, id: \.id) { each in Text(each.name).tag(each.id) }
                    }
                    if harness == "acp" {
                        // Any agent that speaks the Agent Client Protocol: what starts it in its ACP mode, in the VM.
                        FormField("Its ACP agent's command, e.g. goose acp", text: $acp)
                            .font(.body.monospaced())
                            .capitals(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("agent-acp")
                    }
                    Picker("Model role", selection: $role) {
                        ForEach(Agents.roles(roster: roles ?? [:], current: existing?.role), id: \.self) { each in
                            Text(roles?[each]?.models.isEmpty == true ? "\(each) · no model yet" : each).tag(each)
                        }
                    }
                } header: {
                    Text("How it works")
                } footer: {
                    // (A device that may not read the roster is told only where the role's models come from.)
                    Text("Choosing a harness doesn't install it or sign it in: that is done in the agent's VM.\(harness == "acp" ? " An ACP agent runs as you set it up there, with the role's model offered through the gateway as OPENAI_BASE_URL." : "") \(roles.map { Agents.roleLine(role: role, spec: $0[role]) + "." } ?? "The role picks its models from your Models settings.")")
                }

                if let offered, !offered.isEmpty {
                    Section {
                        ForEach(offered) { choice in
                            Toggle(isOn: Binding(get: { own.contains(choice.ref) }, set: { own = Agents.toggle(own, choice.ref, on: $0) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(choice.ref).font(.callout.monospaced())
                                    Text(choice.on.isEmpty ? "Through its provider" : "Runs on \(choice.on.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Toggle("Sensitive mode: only these models, for everything it does", isOn: $sensitive)
                    } header: {
                        Text("Models")
                    } footer: {
                        Text("\(Agents.modelsLine(own: own, role: role, spec: roles?[role], sensitive: sensitive)). A local model runs on the node that serves it, for an agent on \(Primary.name)'s own harness: a vendor's coding tool can't use one.")
                    }
                }

                if let givable, !givable.isEmpty || !keys.isEmpty {
                    Section {
                        ForEach(givable) { secret in
                            let given = keys.first { $0.secret == secret.name }
                            VStack(alignment: .leading, spacing: Space.s1) {
                                Toggle(isOn: Binding(get: { given != nil }, set: { on in
                                    keys.removeAll { $0.secret == secret.name }
                                    if on { keys.append(.init(secret: secret.name, header: "authorization", write: false)) }
                                })) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(secret.name).font(.callout.monospaced())
                                        Text(secret.origin ?? "").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                if let given {
                                    Picker("Its header", selection: Binding(get: { given.header }, set: { header in update(secret.name) { $0.header = header } })) {
                                        ForEach(Array(Set(["authorization", "x-api-key", "api-key", given.header])).sorted(), id: \.self) { header in
                                            Text(header == "authorization" ? "Authorization: Bearer" : header).tag(header)
                                        }
                                    }
                                    Toggle("Writes too", isOn: Binding(get: { given.write }, set: { write in update(secret.name) { $0.write = write } }))
                                }
                            }
                        }
                    } header: {
                        Text("Keys it may use")
                    } footer: {
                        Text("Its scripts call $INVINCIBLE_KEYS/<name>/… with $INVINCIBLE_TOKEN where the key would go: the gateway puts the key in, at its own address alone, and the key never enters its VM. Reads only, unless Writes too. A secret of yours is offered once it is pinned to its API's https address; a model's or a connector's key never is.")
                    }
                }

                Section {
                    Stepper(value: $dailyTurns, in: 0...1000, step: 5) {
                        LabeledContent("A day") { Text("\(dailyTurns) turns and jobs").monospacedDigit() }
                    }
                    Toggle("At work", isOn: $enabled)
                } footer: {
                    Text("Replies and jobs a day, not a money limit. Zero holds new work; off pauses it.")
                }

                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
                }
            }
            .navigationTitle(existing.map { "Edit \($0.name)" } ?? "New agent")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Create" : "Save") { Task { await save() } }
                        .disabled(working || trimmedName.isEmpty)
                }
            }
            .task {
                roles = await session.roles()
                // (The order is kept while you edit: what you turn on goes last, and nothing moves under your finger.)
                if let choices = await session.agentModels() { offered = Agents.modelChoices(choices, own: own) }
                // (Yours alone to give: a secret pinned to an https address, nobody else's purpose.)
                struct Listed: Decodable { let secrets: [SecretView] }
                if let listed = try? await session.client.get("/api/secrets", as: Listed.self) {
                    givable = listed.secrets.filter { $0.provider == nil && ($0.origin ?? "").hasPrefix("https://") }.sorted { $0.name < $1.name }
                }
            }
        }
        .sheetSize(width: 600, height: 720)
    }

    /// One of its keys, changed in place.
    private func update(_ secret: String, _ change: (inout Agent.KeyGrant) -> Void) {
        guard let at = keys.firstIndex(where: { $0.secret == secret }) else { return }
        change(&keys[at])
    }

    private func save() async {
        if let invalid { problem = invalid; return }
        working = true
        defer { working = false }
        let address = repository.trimmingCharacters(in: .whitespacesAndNewlines)
        var input = AgentInput(
            id: handle, name: trimmedName, instructions: instructions, repository: address.isEmpty ? nil : address,
            harness: harness, role: role, enabled: enabled, dailyTurns: dailyTurns,
            // Its colour, when you chose here: the one you chose, or its node's choice again. Untouched, it is left as it is.
            avatar: colorTouched ? (chosenColor.map(AgentInput.OrbColor.chosen) ?? .handle) : nil
        )
        // Its own models, to a node that knows them: none is its role's again.
        input.models = own.isEmpty ? nil : own
        input.sendModels = offered != nil || !(existing?.models ?? []).isEmpty
        // (Sent when it is on, or was: to a node that doesn't know it, nothing is said of it.)
        if sensitive || existing?.sensitive == true { input.sensitive = sensitive }
        if harness == "acp" { input.acp = acp.trimmingCharacters(in: .whitespaces) }
        // Its keys, to a node that knows them: said when they could be chosen here, or it had some.
        if givable != nil || !(existing?.keys ?? []).isEmpty {
            input.keys = keys.isEmpty ? nil : keys
            input.sendKeys = true
        }
        let agent: Agent
        do {
            agent = try await session.save(agent: input)
        } catch {
            problem = error.localizedDescription
            return
        }
        saved(agent)
        dismiss()
    }
}

/// An agent's colour as you choose it (the PWA's avatarEditor): its mark as it will be, the palette's eight colours to
/// choose from, each named, the one it will wear ringed in the ink, and its node's choice.
struct MarkColorPicker: View {
    /// Its handle: its mark's seed.
    let handle: String
    /// Its mark as it will be once saved.
    let mark: AgentMark
    /// What its colour is, in words.
    let note: String
    /// A colour chosen (one of the eight, as its light form), or (nil) its node's choice again.
    let choose: (String?) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: Space.s3) {
            HStack(spacing: Space.s4) {
                AgentMarkView(mark: mark, seed: AgentMark.seed(handle.isEmpty ? "agent" : handle), size: 96)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.s2) {
                    Text(note).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Its node's choice") { choose(nil) }
                        .buttonStyle(.borderless)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.touch), spacing: Space.s1)], spacing: Space.s1) {
                ForEach(AgentMark.palette.indices, id: \.self) { n in
                    let hue = AgentMark.palette[n]
                    Button { choose(hue.forms.light) } label: {
                        Circle()
                            .fill(Color(hex: hue.forms.on(scheme == .dark ? .dark : .light)))
                            .frame(width: 30, height: 30)
                            .padding(Space.s1)
                            .overlay(Circle().strokeBorder(mark.color == n ? Color.ink : .clear, lineWidth: 2))
                            .frame(width: Metrics.touch, height: Metrics.touch)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(hue.name)
                    .accessibilityAddTraits(mark.color == n ? .isSelected : [])
                    .help(hue.name)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// A room of several agents, new or changed (the PWA's room form): its name, who is in it, and how many replies one
/// thing you say may set off between them.
struct RoomEditor: View {
    let session: Session
    var existing: TeamRoom?
    var saved: (TeamRoom) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var members: Set<String>
    @State private var budget: Int
    @State private var working = false
    @State private var problem: String?

    init(session: Session, existing: TeamRoom? = nil, saved: @escaping (TeamRoom) -> Void = { _ in }) {
        self.session = session
        self.existing = existing
        self.saved = saved
        _name = State(initialValue: existing?.name ?? "")
        _members = State(initialValue: Set(existing?.members ?? []))
        _budget = State(initialValue: existing?.turnBudget ?? 8)
    }

    private var agents: [Agent] { session.team?.agents ?? [] }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    FormField("e.g. Product studio", text: $name).accessibilityIdentifier("room-name")
                }
                Section {
                    ForEach(agents) { agent in
                        Button {
                            if members.contains(agent.id) { members.remove(agent.id) } else { members.insert(agent.id) }
                        } label: {
                            HStack(spacing: 12) {
                                WorkerFace(id: agent.id, profile: agent.avatar, size: 36)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(agent.name).foregroundStyle(.primary)
                                    Text(agent.role).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: members.contains(agent.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(members.contains(agent.id) ? Color.ink : Color.secondary)
                            }
                        }
                        .listRowButton()
                        .accessibilityAddTraits(members.contains(agent.id) ? .isSelected : [])
                    }
                } header: {
                    Text("Agents")
                } footer: {
                    Text(agents.isEmpty ? "Add an agent first: a room is where agents talk with you and each other." : "They share this conversation and work things out between them.")
                }
                Section {
                    Stepper(value: $budget, in: 1...64) {
                        LabeledContent("Replies") { Text("\(budget) per message of yours").monospacedDigit() }
                    }
                } footer: {
                    Text("Every reply counts, their handoffs to each other too; each new message from you starts again.")
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
                }
            }
            .navigationTitle(existing == nil ? "New room" : "Room settings")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Create" : "Save") { Task { await save() } }
                        .disabled(working || trimmedName.isEmpty || members.isEmpty)
                }
            }
        }
        .sheetSize(width: 520, height: 600)
    }

    private func save() async {
        working = true
        defer { working = false }
        // In the team's order, so a room reads the same on every device.
        let ordered = agents.map(\.id).filter(members.contains) + members.filter { id in !agents.contains { $0.id == id } }.sorted()
        do {
            let room = try await session.save(room: RoomInput(id: existing?.id, name: trimmedName, members: ordered, direct: existing?.direct, turnBudget: budget))
            saved(room)
            dismiss()
        } catch {
            problem = error.localizedDescription
        }
    }
}
