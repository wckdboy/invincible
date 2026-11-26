import Foundation
import Testing
@testable import Invincible

/// The last team this device saw, kept on it (the owner's word, 21 November 2026), as Invincible for Android keeps it:
/// drawn again as the node drew it, with no more than the agents show, never for another node or another key, and
/// only ever looked at.
struct KeptTableTests {
    let node = PairedNode(origin: URL(string: "https://keep.example.test")!, device: "c_device-one", name: "Phone", fleet: "f_fleet", nodeName: "keep", fleetName: "homelab")
    let team = Data(#"""
        {"agents":[{"id":"ada","name":"Ada","role":"engineer","instructions":"Never push to main; my bank PIN is not yours to know.","memory":"Working notes: the staging password rotates on Fridays.",
                       "keys":[{"secret":"stripe-live","header":"authorization","write":false}],"harness":"acp","acp":"goose acp","models":["sensitive-model-x"],"sensitive":true,
                       "repository":"https://git.example.test/private-repo.git","enabled":true,"dailyTurns":40,"turnsToday":3,"createdBy":"owner","instructionsBy":"owner",
                       "avatar":{"look":"coder"},"workspace":{"node":"n_keep","id":"0123456789"}},
                      {"id":"tester","name":"Tester","role":"engineer","instructions":"","harness":"native","enabled":false,"dailyTurns":40,"turnsToday":0},
                      {"id":"writer","name":"Writer","role":"researcher","instructions":"Reads the papers first.\nThen the code.","harness":"native","enabled":true,"dailyTurns":20,"turnsToday":0}],
         "rooms":[{"id":"r1","name":"Release room","direct":false,"members":["ada","tester"],"updatedAt":1763700000000,"paused":false,"turnBudget":6}],
         "tasks":[{"id":"t1","title":"Sync survives a dropped connection","goal":"The whole brief, with the customer's address in it","assignee":"ada","status":"running","verified":false,
                   "updatedAt":1763700000000,"progress":"Running · bun test","changes":{"files":3,"artifact":"secret.patch"},"proposedBy":"operator","room":"r1","dependsOn":["t0"],
                   "gates":["bun test --secret-flag"],"output":"what the agent said of it"},
                  {"id":"t2","title":"The importer reads ISO dates","goal":"Another brief","assignee":"tester","status":"failed","verified":false,"updatedAt":1763690000000,
                   "progress":"","error":"gave up","room":"r1","dependsOn":[]}],
         "deliveries":[{"id":"d1","agent":"ada","status":"queued","updatedAt":1763700000000,"room":"r1","error":null,"text":"a message's words"}],
         "removed":[{"id":"gone","name":"Gone"}],
         "seen":{"agent:ada":1763690000000},"computer":{"node":"n_keep","id":"9999999999"},
         "outcomes":[{"id":"o1","goal":"Something the agents don't draw"}]}
        """#.utf8)
    let turns: [String?] = ["Release notes", nil]
    let unread = ["The importer"]
    let asks = [Ask(by: "arm:team.0123456789.ada", connector: "forge", tool: "post")]

    private func kept(at: Double = 1_763_700_123_000) throws -> KeptTable.Kept {
        let record = try #require(KeptTable.record(for: node, team: team, turns: turns, unread: unread, asks: asks, waiting: 3, at: at))
        return try #require(KeptTable.read(record, for: node))
    }

    @Test func itDrawsTheAgentsAgainAsTheNodeDrewIt() throws {
        let live = try JSONDecoder().decode(TeamSnapshot.self, from: team)
        let kept = try kept()
        let now = 1_763_700_200_000.0
        // Every agent's line, mark and state, and every room's, as the node's answer draws them; an agent with no task
        // yet says its role, as its job's first line was never kept.
        let drawn = Roster.rows(snapshot: kept.team, asks: kept.asks, now: now)
        let said = Roster.rows(snapshot: live, asks: asks, now: now)
        #expect(drawn.filter { $0.id != "writer" } == said.filter { $0.id != "writer" })
        #expect(said.first { $0.id == "writer" }?.line == "Reads the papers first.")
        #expect(drawn.first { $0.id == "writer" }?.line == "researcher")
        #expect(Roster.roomRows(snapshot: kept.team) == Roster.roomRows(snapshot: live))
        #expect(kept.team.agents.map(\.avatar) == live.agents.map(\.avatar))
        #expect(kept.turns == ["Release notes", nil])
        #expect(kept.unread == ["The importer"])
        #expect(kept.asks == asks)
        #expect(kept.waiting == 3)
        #expect(kept.at == 1_763_700_123_000)
    }

    @Test func itKeepsNoMoreThanTheAgentsDraws() throws {
        let record = try #require(KeptTable.record(for: node, team: team, turns: turns, unread: unread, asks: asks, waiting: 3, at: 1))
        let text = String(decoding: record, as: UTF8.self)
        // An agent's instructions and working notes, the keys it may use, its harness, agent, models and repository, a
        // task's brief, gates, output and patch, a message's words, what the team holds beyond the roster: none of it.
        for absent in ["instructions", "bank PIN", "memory", "staging password", "stripe-live", #""harness""#, "goose acp", "sensitive-model-x", "private-repo",
                       #""goal""#, "the customer's address", "secret.patch", "--secret-flag", "what the agent said", "a message's words", "turnBudget", 
                       "9999999999", "outcomes", "Something the agents"] {
            #expect(!text.contains(absent), "\(absent)")
        }
        let kept = try #require((try JSONSerialization.jsonObject(with: record) as? [String: Any])?["team"] as? [String: Any])
        #expect(Set(kept.keys) == ["agents", "rooms", "tasks", "deliveries", "removed", "seen"])
        #expect(try self.kept().team.agents.map(\.name) == ["Ada", "Tester", "Writer"])
    }

    @Test func itIsNeverDrawnForAnotherNodeAnotherKeyOrAnotherVersion() throws {
        let record = try #require(KeptTable.record(for: node, team: team, turns: [], unread: [], asks: [], waiting: 0, at: 1))
        var other = node
        other.origin = try #require(URL(string: "https://other.example.test"))
        #expect(KeptTable.read(record, for: other) == nil)
        other = node
        other.device = "c_device-two"
        #expect(KeptTable.read(record, for: other) == nil)
        var fields = try #require(try JSONSerialization.jsonObject(with: record) as? [String: Any])
        fields["v"] = 2
        #expect(KeptTable.read(try JSONSerialization.data(withJSONObject: fields), for: node) == nil)
        fields["v"] = 1
        fields["team"] = nil
        #expect(KeptTable.read(try JSONSerialization.data(withJSONObject: fields), for: node) == nil)
        #expect(KeptTable.read(Data("{}".utf8), for: node) == nil)
        #expect(KeptTable.read(Data("not a record".utf8), for: node) == nil)
    }

    @Test func itIsWrittenWhenItChangesOrTenMinutesOn() throws {
        let (store, folder) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 3, at: 1_000)
        store.settle()
        #expect(store.load(for: node)?.at == 1_000)
        // The same a minute on isn't written again (taken away here, to tell).
        try FileManager.default.removeItem(at: store.file)
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 3, at: 61_000)
        store.settle()
        #expect(!FileManager.default.fileExists(atPath: store.file.path()))
        // Changed, it is.
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 4, at: 62_000)
        store.settle()
        #expect(store.load(for: node)?.waiting == 4)
        // And the same ten minutes on, with its new time.
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 4, at: 662_000)
        store.settle()
        #expect(store.load(for: node)?.at == 662_000)
    }

    @Test func forgettingTakesItAwayAfterAnyWriteStillUnderWay() throws {
        let (store, folder) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 3, at: 1_000)
        store.forget()
        store.settle()
        #expect(!FileManager.default.fileExists(atPath: store.file.path()))
        #expect(store.load(for: node) == nil)
        // Kept again after, it is written again, though it is what was written before.
        store.keep(team: team, for: node, turns: turns, unread: unread, asks: asks, waiting: 3, at: 2_000)
        store.settle()
        #expect(store.load(for: node)?.at == 2_000)
    }

    @Test func anIPhoneKeepsItInItsCachesReadableOnlyWhileUnlocked() throws {
        // Caches are never in a backup, and the system may clear them.
        let caches = try #require(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
        let here = try #require(KeptTable.Store.here)
        #expect(here.file.deletingLastPathComponent().standardizedFileURL == caches.standardizedFileURL)
        // (A simulator keeps no file protection, so only the asking is seen here; a device holds the file to it.)
        #expect(KeptTable.Store.writing.contains(.completeFileProtection))
        #expect(KeptTable.Store.writing.contains(.atomic))
    }

    @MainActor @Test func aSessionDrawsItUntilTheNodeAnswersAndChangesNothingFromIt() async throws {
        let tag = "sh.invincible.bot.tests.kept"
        defer { try? DeviceKey.delete(tag: tag) }
        // A node that isn't there: nothing listens on this port of this machine.
        var away = node
        away.origin = try #require(URL(string: "http://127.0.0.1:9"))
        let record = try #require(KeptTable.record(for: away, team: team, turns: turns, unread: unread, asks: asks, waiting: 3, at: 1_763_700_123_000))
        let session = Session(key: try DeviceKey.create(tag: tag), node: away, kept: KeptTable.read(record, for: away))
        #expect(session.rows.map(\.id) == ["ada", "tester", "writer"])
        #expect(session.roomRows.map(\.id) == ["r1"])
        #expect(session.drawn("ada")?.name == "Ada")
        // Its line as it was: two chats under way, and what needed you, Home's count as it was kept (one count everywhere,
        // 26 November 2026: the agents' line no longer leaves out what the agents asked, which made Home say 6 and it 5).
        #expect(session.primary == PrimaryNow(PrimaryWork(turns: turns, needs: 3, unread: unread)))
        // Only looked at: an agent's page, and anything you change, wait for the node's word.
        #expect(session.team == nil)
        #expect(session.agent("ada") == nil)
        #expect(session.room("r1") == nil)
        // Said to be what the node last said once it has been a moment answering, and not before.
        #expect(session.keptSince == nil)
        try await Task.sleep(for: .seconds(1.6))
        #expect(session.keptSince == Date(timeIntervalSince1970: 1_763_700_123))
        // The node away, it is still what is drawn.
        await session.refresh()
        #expect(session.trouble != nil)
        #expect(session.rows.count == 3)
        #expect(session.keptSince != nil)
    }

    private func temporaryStore() throws -> (KeptTable.Store, URL) {
        let folder = FileManager.default.temporaryDirectory.appending(path: "kept-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return (KeptTable.Store(file: folder.appending(path: "agents.json")), folder)
    }
}
