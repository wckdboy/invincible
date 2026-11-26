import SwiftUI

/// The node's answer to a task given to the agents (the PWA's `Given`): who took it and why, and how each of the
/// others stood.
struct Given: Decodable, Sendable {
    struct Task: Decodable, Sendable { let id: String; let room: String }
    struct Choice: Decodable, Sendable { let id: String; let name: String; let reasons: [String] }
    struct Considered: Decodable, Sendable { let id: String; let name: String; let eligible: Bool; let why: [String] }
    let task: Task
    let choice: Choice
    let considered: [Considered]
}

/// A task given to the agents rather than to an agent: the agent best suited to it takes it, and the sheet then
/// says who, why, and how each of the others stood (the PWA's give).
struct GiveSheet: View {
    let session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var goal = ""
    @State private var title = ""
    @State private var gates = ""
    @State private var budget = ""
    @State private var desktop = false
    @State private var repository = ""
    @State private var working = false
    @State private var problem: String?
    @State private var given: Given?

    var body: some View {
        NavigationStack {
            Group {
                if let given { taken(given) } else { form }
            }
            // The PWA's title: the bar of a sheet cut the longer one ("Give the agents a…").
            .navigationTitle(given == nil ? "Give a task" : "Given")
            .inlineTitle()
            .toolbar {
                if given == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Give") { Task { await give() } }
                            .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
        }
        .sheetSize(width: 560, height: 640)
    }

    private var form: some View {
        Form {
            Section {
                FormField("What should be built or investigated, and what proves it is complete?", text: $goal, axis: .vertical).lineLimit(4...12)
            } header: {
                Text("Goal")
            } footer: {
                Text("The agent best suited to it takes it: one that's free, with what the work needs.")
            }
            Section("Title") { FormField("A concrete result (from the goal, if left empty)", text: $title) }
            Section {
                FormField("bun run check", text: $gates, axis: .vertical)
                    .lineLimit(2...8)
                    .font(.body.monospaced())
                    .capitals(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Done when these pass")
            } footer: {
                Text("One shell command a line, up to 16. They run in the agent's workspace.")
            }
            Section {
                FormField("0.50", text: $budget).keyboard(.decimal).monospacedDigit()
            } header: {
                Text("Budget in US dollars (optional)")
            } footer: {
                Text("What its model calls may spend, at your prices. It is told what it has spent, and stops with what it has when it is spent.")
            }
            Section("It needs") {
                Toggle("A desktop (a browser, an app with windows)", isOn: $desktop)
                FormField("A repository (owner/name or a URL)", text: $repository)
                    .capitals(.never)
                    .autocorrectionDisabled()
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
        }
    }

    private func taken(_ given: Given) -> some View {
        GroupedList {
            Section {
                HStack(spacing: Space.s3) {
                    WorkerFace(id: given.choice.id, profile: session.agent(given.choice.id)?.avatar, size: Metrics.rowFace)
                    VStack(alignment: .leading, spacing: Space.s1) {
                        Text("\(given.choice.name) took it").font(.headline)
                        Text(given.choice.reasons.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, Space.s1)
            } footer: {
                Text("It's in \(given.choice.name)'s timeline now, where it was given.")
            }
            let others = given.considered.filter { $0.id != given.choice.id }
            if !others.isEmpty {
                Section("The others") {
                    ForEach(others, id: \.id) { agent in
                        VStack(alignment: .leading, spacing: Space.line) {
                            Text(agent.name).font(.subheadline.weight(.semibold))
                            Text("\(agent.eligible ? "" : "can't take it: ")\(agent.why.joined(separator: " · "))")
                                .font(.caption)
                                .foregroundStyle(agent.eligible ? Color.secondary : Color.danger)
                        }
                    }
                }
            }
        }
    }

    private func give() async {
        let money: Double?
        switch AgentRoom.budget(from: budget) {
        case .failure(let error):
            problem = error.message
            return
        case .success(let usd): money = usd
        }
        let commands: [String]
        switch AgentRoom.gates(from: gates) {
        case .failure(let error):
            problem = error.message
            return
        case .success(let list): commands = list
        }
        struct Needs: Encodable { var desktop: Bool?; var repository: String? }
        struct Give: Encodable { let goal: String; var title: String?; var gates: [String]?; var needs: Needs?; var budgetUsd: Double? }
        let repo = repository.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let needs = Needs(desktop: desktop ? true : nil, repository: repo.isEmpty ? nil : repo)
        let input = Give(
            goal: goal.trimmingCharacters(in: .whitespacesAndNewlines),
            title: named.isEmpty ? nil : named,
            gates: commands.isEmpty ? nil : commands,
            needs: needs.desktop == nil && needs.repository == nil ? nil : needs,
            budgetUsd: money
        )
        working = true
        defer { working = false }
        do {
            given = try await session.client.post("/api/team/give", input, as: Given.self)
            problem = nil
            await session.refresh()
        } catch {
            problem = error.localizedDescription
        }
    }
}
