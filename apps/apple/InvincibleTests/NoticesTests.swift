import Foundation
import Testing
@testable import Invincible

/// The node's notices in the Inbox (Core/Notices.swift): read as the node sends them, those still open, and each said
/// by how much it matters and where it came from.
struct NoticesTests {
    static let listed = #"""
    {"notices":[
      {"key":"rule:pushes:q-1","severity":"info","title":"Your rule pushes: a command it matches has run","body":"In one of its runs (q-1), and it succeeded:\n$ git push origin main","source":"rule:pushes","node":null,"at":1763380000000,"dismissed":false},
      {"key":"disk:n-abc","severity":"warn","title":"Disk nearly full","body":"","source":"heartbeat","node":"n-abc","at":1763370000000,"dismissed":true}
    ]}
    """#

    struct Listed: Decodable { let notices: [NoticeView] }

    @Test func aNoticeIsReadAsTheNodeSendsItAndOnlyThoseStillOpenAreShown() throws {
        let notices = try JSONDecoder().decode(Listed.self, from: Data(Self.listed.utf8)).notices
        #expect(notices.map(\.key) == ["rule:pushes:q-1", "disk:n-abc"])
        #expect(notices[1].node == "n-abc" && notices[0].node == nil)
        #expect(Notices.open(notices).map(\.key) == ["rule:pushes:q-1"])
    }

    @Test func aNoticeWithALoneSurrogateIsReadWithTheRestOfTheAnswer() throws {
        // What a node before the fourth fabric review's R4-5 may send: a notice naming an entry whose name wasn't UTF-8
        // (Python's surrogateescape), kept in the ledger and so in every answer that carries it. JSONDecoder alone refuses
        // the whole answer; the app's read takes it with the one character said as U+FFFD, a pair and an escaped
        // backslash as they were.
        let page = #"{"notices":[{"key":"fine","severity":"info","title":"Fine","body":"fine","source":"sandbox","node":null,"at":1,"dismissed":false},{"key":"layout:ada","severity":"info","title":"Ada's VM has a HOME of its own","body":"Moved to its HOME: .x\udcff (1 KB), and \ud83d\udee1 as it is, and \\udcff as text, and \ud83d alone","source":"sandbox","node":null,"at":2,"dismissed":false}]}"#
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Listed.self, from: Data(page.utf8)) }
        let notices = try NodeClient.decoded(Listed.self, from: Data(page.utf8)).notices
        #expect(notices.map(\.key) == ["fine", "layout:ada"])
        #expect(notices[1].body == "Moved to its HOME: .x\u{FFFD} (1 KB), and \u{1F6E1} as it is, and \\udcff as text, and \u{FFFD} alone")
        // An answer that is well-formed is read as it is, and one that isn't JSON at all is still refused.
        #expect(try NodeClient.decoded(Listed.self, from: Data(Self.listed.utf8)).notices.count == 2)
        #expect(throws: (any Error).self) { try NodeClient.decoded(Listed.self, from: Data(#"not json \udcff"#.utf8)) }
    }

    @Test func eachIsSaidByHowMuchItMattersAndWhereItCameFrom() throws {
        let notices = try JSONDecoder().decode(Listed.self, from: Data(Self.listed.utf8)).notices
        #expect(Notices.symbol(notices[0]) == "bell.fill")
        #expect(Notices.symbol(notices[1]) == "exclamationmark.triangle.fill")
        // Where it came from, in the PWA's own words (its lib/notices.ts, by the vectors).
        #expect(!Vectors.shared.notices.isEmpty)
        for vector in Vectors.shared.notices {
            #expect(Notices.from(vector.source) == vector.from, "\(vector.source)")
        }
    }
}
