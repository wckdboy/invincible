import Foundation
import Testing
@testable import Invincible

/// The iPhone app's notifications as data: which of Apple's services this build answers to, the token's form, and where
/// a tap leads (the node's side: packages/node/test/apns-send.test.ts).
struct PushTests {
    /// A provisioning profile as Apple signs one: the plist inside a CMS envelope (here, bytes around it).
    private func profile(_ aps: String?) -> Data {
        let entitlements = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Name</key><string>\(Primary.name)</string><key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
        """
        return Data([0x30, 0x82, 0x01, 0x00]) + Data(plist.utf8) + Data([0xa0, 0x00, 0x31, 0x02])
    }

    @Test func theServiceIsTheOneTheProfileNames() {
        for simulator in [false, true] {
            #expect(Push.environment(profile: profile("production"), simulator: simulator) == "production")
            #expect(Push.environment(profile: profile("development"), simulator: simulator) == "development")
            // One without push, or one that can't be read: Apple's development service.
            #expect(Push.environment(profile: profile(nil), simulator: simulator) == "development")
            #expect(Push.environment(profile: Data("not a profile".utf8), simulator: simulator) == "development")
        }
    }

    @Test func withNoProfileATestFlightBuildIsProductionsAndTheSimulatorDevelopments() {
        // TestFlight and the App Store take the profile out: their tokens are Apple's own service's.
        #expect(Push.environment(profile: nil, simulator: false) == "production")
        #expect(Push.environment(profile: nil, simulator: true) == "development")
    }

    @Test func theTokenIsLowercaseHex() {
        #expect(Push.hex(Data([0x00, 0xab, 0x10, 0xff])) == "00ab10ff")
        #expect(Push.hex(Data(repeating: 0xcd, count: 32)).count == 64)
    }

    @Test func aTapOpensOnlyWhatTheNodesListNames() {
        let conversation = "cv_" + String(repeating: "A", count: 22)
        #expect(Push.destination(["invincible": ["v": 1, "open": "inbox"]]) == .inbox)
        #expect(Push.destination(["invincible": ["v": 1, "open": "chat", "conversation": conversation]]) == .chat(conversation))
        #expect(Push.destination(["invincible": ["v": 1, "open": "chat", "conversation": "../../etc"]]) == .chat(nil))
        #expect(Push.destination(["invincible": ["v": 1, "open": "overview"]]) == .overview)
        #expect(Push.destination(["invincible": ["v": 1, "open": "settings"]]) == .settings)
        // Not ours, another version, or a place the list doesn't have: the Inbox.
        #expect(Push.destination(["aps": ["alert": "hi"]]) == .inbox)
        #expect(Push.destination(["invincible": ["v": 2, "open": "chat"]]) == .inbox)
        #expect(Push.destination(["invincible": ["v": 1, "open": "https://example.com"]]) == .inbox)
    }

    @Test func aButtonAnswersOnlyTheActionItsApprovalNames() {
        let id = "a_1234567890123456789012"
        #expect(Push.action(["invincible": ["v": 1, "kind": "approval", "action": id]]) == id)
        // Read as strictly as the node writes it: an approval's own, an action id's shape, nothing else.
        #expect(Push.action(["invincible": ["v": 1, "kind": "finished", "action": id]]) == nil)
        #expect(Push.action(["invincible": ["v": 1, "kind": "approval", "action": "../../actions"]]) == nil)
        #expect(Push.action(["invincible": ["v": 2, "kind": "approval", "action": id]]) == nil)
        #expect(Push.action(["aps": ["category": "approval"]]) == nil)
    }

    @Test func whatTheAppDoesWhenItOpensIsCoresOwnWord() throws {
        let cases = Vectors.shared.notifyReach
        #expect(cases.count == 36)
        for c in cases {
            let step = Push.reach(permission: try #require(Push.Permission(rawValue: c.permission)), subscribed: c.subscribed, lost: c.lost, reachable: c.reachable, localOn: c.localOn)
            #expect(step.rawValue == c.step, "\(c)")
        }
    }

    @Test func approveOnANotificationOpensItsCardNeverAYesFromTheLockScreen() {
        // The destination an Approve leads to carries the approval's own id; a tap elsewhere goes where the node said.
        #expect(Push.Destination.approval("a_1234567890123456789012") != .inbox)
        #expect(Push.destination(["invincible": ["v": 1, "kind": "approval", "open": "inbox", "action": "a_1234567890123456789012"]]) == .inbox)
    }

    @Test func whatWasAnsweredElsewhereIsTakenDownByItsTagAlone() {
        let ours: (String) -> [AnyHashable: Any] = { ["invincible": ["v": 1, "kind": "approval", "open": "inbox", "tag": $0]] }
        let shown: [(id: String, userInfo: [AnyHashable: Any])] = [("one", ours("t-a")), ("two", ours("t-b")), ("three", ["aps": ["alert": "hi"]]), ("four", ours("bad tag!"))]
        #expect(Push.withdrawn(shown, tags: ["t-a", "t-z"]) == ["one"])
        #expect(Push.withdrawn(shown, tags: []) == [])
        #expect(Push.tag(ours("t-a")) == "t-a")
        #expect(Push.tag(["invincible": ["v": 2, "tag": "t-a"]]) == nil)
    }

    @Test func aLostSubscriptionIsSaidAsTheWebAppSaysIt() {
        // 18 November 2026, noon UTC.
        #expect(Push.lostLine(at: 1_795_003_200_000, service: "Apple") == "They were on until 18 Nov: Apple's push service stopped taking them.")
        #expect(Push.lostLine(at: 1_795_003_200_000, service: "a push service you allowed") == "They were on until 18 Nov: the push service you allowed stopped taking them.")
    }

    @Test func aTaskNotificationOpensItsTaskAndOneItCantNameOpensTheAgents() {
        let task: [AnyHashable: Any] = ["invincible": ["v": 1, "kind": "finished", "open": "task", "task": "task-abcdefghijkl", "tag": "t"]]
        #expect(Push.destination(task) == .task("task-abcdefghijkl"))
        let bad: [AnyHashable: Any] = ["invincible": ["v": 1, "kind": "finished", "open": "task", "task": "../../x", "tag": "t"]]
        #expect(Push.destination(bad) == .overview)
        #expect(Push.kind(task) == "finished")
    }

    @Test func shipItShipsOnlyTheTaskItNamesAndOnlyWhereTheNodeSaidItCan() {
        #expect(Push.shipTask(["invincible": ["v": 1, "open": "task", "task": "task-abcdefghijkl", "ship": true]]) == "task-abcdefghijkl")
        #expect(Push.shipTask(["invincible": ["v": 1, "open": "task", "task": "task-abcdefghijkl"]]) == nil)
        #expect(Push.shipTask(["invincible": ["v": 1, "open": "chat", "task": "task-abcdefghijkl", "ship": true]]) == nil)
        #expect(Push.shipTask(["invincible": ["v": 2, "open": "task", "task": "task-abcdefghijkl", "ship": true]]) == nil)
    }

    @Test func invincibleLinksOpenATaskAnAgentAnApprovalOrAChatAndNothingElse() throws {
        let link = { (text: String) in Push.link(try #require(URL(string: text))) }
        #expect(try link("invincible://task/task-abcdefghijkl") == .task("task-abcdefghijkl"))
        #expect(try link("invincible://agent/writer") == .agent("writer"))
        #expect(try link("invincible://approval/a_1234567890123456789012") == .approval("a_1234567890123456789012"))
        #expect(try link("invincible://chat/cv_1234567890123456789012") == .chat("cv_1234567890123456789012"))
        for bad in ["invincible://task/../etc", "invincible://agent/Writer", "invincible://settings/x", "https://task/task-abcdefghijkl", "invincible://task/task-abcdefghijkl/more", "invincible://pair#pair=gi1.x"] {
            #expect(try link(bad) == nil, "\(bad)")
        }
    }

    @Test func whatTheScreenShowsIsToldOnlyInTheListAndNewsNeverSounds() {
        let quiet = Push.presentation(.task("task-abcdefghijkl"), kind: "finished", showing: .task("task-abcdefghijkl"))
        #expect(quiet.banner == false && quiet.sound == false)
        #expect(Push.presentation(.ship("task-abcdefghijkl"), kind: "finished", showing: .task("task-abcdefghijkl")).banner == false)
        #expect(Push.presentation(.chat("cv_1234567890123456789012"), kind: "question", showing: .chat("cv_1234567890123456789012")).banner == false)
        #expect(Push.presentation(.approval("a_1234567890123456789012"), kind: "approval", showing: .inbox).banner == false)
        // Something else on screen: a banner; a sound only for what is told now, never for news.
        let other = Push.presentation(.task("task-abcdefghijkl"), kind: "finished", showing: .task("task-bbbbbbbbbbbb"))
        #expect(other.banner && !other.sound)
        let ask = Push.presentation(.approval("a_1234567890123456789012"), kind: "approval", showing: nil)
        #expect(ask.banner && ask.sound)
    }
}
