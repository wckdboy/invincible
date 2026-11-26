import Foundation
import Testing
@testable import Invincible

extension Vectors {
    /// The work by attention (the PWA's own lib/work.ts): every task a row of three lines in four sections, with read
    /// marks and without, filtered by project; the spans, badges and keys; what a task is doing; the at-a-glance line;
    /// what waits beyond the rows; what opening a task marks as read; and what an agent's tasks cost.
    struct WorkCases: Decodable {
        struct Snapshot: Decodable { let agents: [Agent]; let tasks: [TeamTask]; let seen: [String: Double]? }
        struct Row: Decodable {
            struct Agent: Decodable { let id: String; let name: String }
            let id: String
            let room: String
            let title: String
            let project: WorkProject
            let agent: Agent
            let state: String
            let attention: String
            let word: String
            let tone: String
            let age: String?
            let detail: String
            let mono: Bool
            let at: Double
        }
        struct Shown: Decodable {
            let needs: [Row]
            let active: [Row]
            let working: [Row]
            let done: [Row]
            let projects: [Attended.Project]
        }
        struct Only: Decodable { let key: String; let ids: [String] }
        struct Span: Decodable { let ms: Double; let span: String }
        struct Badge: Decodable { let name: String; let badge: String }
        struct Key: Decodable { let repo: String; let key: String? }
        struct Doing: Decodable { let progress: String; let text: String; let mono: Bool }
        struct FailedGate: Decodable { let progress: String; let gate: Int? }
        struct Glance: Decodable { let count: Int; let its: String; let working: Bool; let text: String; let needs: Bool }
        struct Beyond: Decodable { let inbox: Int; let beyond: Int }
        struct Opened: Decodable { struct Marks: Decodable { let agent: String }; let id: String; let marks: Marks? }
        struct Spent: Decodable { struct Sum: Decodable { let usd: Double; let complete: Bool }; let agent: String; let since: Double; let spent: Sum? }
        let now: Double
        let newForMs: Double
        let snapshot: Snapshot
        let projects: [Work.Named]
        let asks: [Ask]
        let attended: Shown
        let unmarked: Shown
        let order: [String]
        let only: [Only]
        let spans: [Span]
        let badges: [Badge]
        let keys: [Key]
        let doing: [Doing]
        let failedGates: [FailedGate]
        let glances: [Glance]
        let beyond: [Beyond]
        let opened: [Opened]
        let prices: [String: Price]
        let spent: [Spent]
    }
}

/// The work by attention, as the PWA lays it out (lib/work.ts; your word, 26 November 2026: "project/tasks/coding t3code
/// style for the agents"): each row's three lines and its section, the order, the project filters, and the lines and
/// counts around them, checked against the PWA's own output.
struct WorkTests {
    let work = Vectors.shared.work

    private func attended(_ seen: [String: Double]?, tasks: [TeamTask]? = nil, asks: [Ask]? = nil) -> Attended {
        Work.attended(agents: work.snapshot.agents, tasks: tasks ?? work.snapshot.tasks, seen: seen, projects: work.projects, asks: asks ?? work.asks, now: work.now)
    }

    private func check(_ mine: Attended, _ theirs: Vectors.WorkCases.Shown, _ label: String) {
        for section in Attention.allCases {
            let rows = mine[section]
            let expected: [Vectors.WorkCases.Row] = switch section {
            case .needs: theirs.needs
            case .active: theirs.active
            case .working: theirs.working
            case .done: theirs.done
            }
            #expect(rows.map(\.id) == expected.map(\.id), "\(label) \(section)")
            for (row, want) in zip(rows, expected) {
                let where_ = "\(label) \(row.id)"
                #expect(row.room == want.room && row.title == want.title, "\(where_)")
                #expect(row.project == want.project, "\(where_)")
                #expect(row.agent.id == want.agent.id && row.agent.name == want.agent.name, "\(where_)")
                #expect(row.state.rawValue == want.state && row.attention.rawValue == want.attention, "\(where_)")
                #expect(row.word == want.word && row.tone == want.tone, "\(where_)")
                #expect(row.age == want.age, "\(where_)")
                #expect(row.detail == want.detail && row.mono == want.mono, "\(where_)")
                #expect(row.at == want.at, "\(where_)")
            }
        }
        #expect(mine.projects == theirs.projects, "\(label) projects")
    }

    @Test func everyTaskIsARowInItsSectionAsThePWAsWithReadMarks() {
        check(attended(work.snapshot.seen), work.attended, "read")
        #expect(Work.newForMs == work.newForMs)
    }

    @Test func aNodeThatKeepsNoMarksShowsResultsNewForHalfADay() {
        check(attended(nil), work.unmarked, "unmarked")
    }

    @Test func theRowsComeInTheOrderOfAttention() {
        #expect(attended(work.snapshot.seen).byAttention.map(\.id) == work.order)
    }

    @Test func aProjectsFilterKeepsItsOwnRows() {
        let all = attended(work.snapshot.seen)
        for item in work.only {
            #expect(all.only(item.key).byAttention.map(\.id) == item.ids, "\(item.key)")
        }
        #expect(all.only(nil) == all)
    }

    @Test func spansBadgesAndKeysAreThePWAs() {
        for item in work.spans { #expect(Work.shortSpan(item.ms) == item.span, "\(item.ms)") }
        for item in work.badges { #expect(Work.badge(item.name) == item.badge, "\(item.name)") }
        for item in work.keys { #expect(Work.projectKey(item.repo) == item.key, "\(item.repo)") }
    }

    @Test func whatATaskIsDoingIsThePWAs() {
        for item in work.doing {
            let doing = Work.doingNow(item.progress)
            #expect(doing.text == item.text && doing.mono == item.mono, "\(item.progress)")
        }
        for item in work.failedGates { #expect(Work.failedGate(item.progress) == item.gate, "\(item.progress)") }
    }

    @Test func theLineUnderHisNameIsThePWAs() {
        let all = attended(work.snapshot.seen)
        let none = attended(work.snapshot.seen, tasks: [], asks: [])
        for item in work.glances {
            let glance = Work.atAGlance(item.working ? all : none, needs: item.count, its: item.its)
            #expect(glance.text == item.text && glance.needs == item.needs, "\(item.count) \(item.working)")
        }
    }

    @Test func whatWaitsBeyondTheRowsIsThePWAs() {
        let needs = attended(work.snapshot.seen).needs
        for item in work.beyond { #expect(Work.inboxBeyond(item.inbox, asks: work.asks, needs: needs) == item.beyond, "\(item.inbox)") }
    }

    @Test func openingATaskMarksWhatThePWAMarks() {
        #expect(work.opened.count == work.snapshot.tasks.count + 1)
        for item in work.opened {
            #expect(Work.seenOnOpen(item.id, tasks: work.snapshot.tasks, seen: work.snapshot.seen) == item.marks?.agent, "\(item.id)")
        }
        // A node that keeps no marks: nothing to mark.
        #expect(work.snapshot.tasks.allSatisfy { Work.seenOnOpen($0.id, tasks: work.snapshot.tasks, seen: nil) == nil })
    }

    @Test func whatAnAgentsTasksCostIsThePWAs() throws {
        // (The vectors keep only the sums: these are the records they were made from, as apps/apple/scripts/vectors.ts
        // makes them.)
        let at = { (minutesAgo: Double) in work.now - minutesAgo * 60_000 }
        let usage = { (model: String, calls: Int, input: Int, output: Int, cached: Int, unknown: Int) in
            UsageLine(role: "engineer", model: model, calls: calls, unknown: unknown, input: input, output: output, cached: cached, reasoning: 0)
        }
        func task(_ agent: String, _ started: Double, _ ended: Double, _ spent: [UsageLine]?) throws -> TeamTask {
            var json: [String: Any] = ["id": "task-\(agent)", "room": "dm-\(agent)", "assignee": agent, "title": "", "goal": "", "dependsOn": [String](), "status": "done", "verified": false, "progress": "", "error": NSNull(), "updatedAt": at(ended)]
            if let spent {
                json["record"] = ["startedAt": at(started), "endedAt": at(ended), "ended": "done", "commands": 12, "revisions": 1, "spent": try spent.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }]
            }
            return try JSONDecoder().decode(TeamTask.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let tasks = [
            try task("ada", 300, 200, [usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000, 40_000, 0)]),
            try task("ada", 60, 30, [usage("mistral/mistral-large", 2, 30_000, 2_000, 0, 0)]),
            try task("bea", 60, 30, [usage("unknown/model", 3, 10_000, 1_000, 0, 0)]),
            try task("cy", 60, 30, [usage("deepseek/deepseek-v4-pro", 2, 0, 0, 0, 2)]),
            try task("dee", 60, 30, [usage("deepseek/deepseek-v4-pro", 3, 9_000, 900, 0, 1)]),
            try task("eli", 0, 0, nil),
        ]
        #expect(work.spent.count == 11)
        for item in work.spent {
            let spent = Work.spentSince(tasks, agent: item.agent, since: item.since, prices: work.prices)
            #expect((spent == nil) == (item.spent == nil), "\(item.agent) \(item.since)")
            if let spent, let theirs = item.spent {
                #expect(abs(spent.usd - theirs.usd) <= 1e-9 && spent.complete == theirs.complete, "\(item.agent) \(item.since)")
            }
        }
    }
}
