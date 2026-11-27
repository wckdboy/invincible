import CoreGraphics
import Foundation
import SwiftUI
import Testing
@testable import Invincible

/// What the Grille (O2, 26 November 2026) leaves an agent's glass, as core makes it (`agent-mark.ts`, through the vectors'
/// `marks`): its palette, each expression's state, a handle's seed, the snap of a colour you pick, and a saved mark read
/// strictly; and a task's Live Activity, as its state and as an app from before the glass wrote it.
struct AgentMarkTests {
    let marks = Vectors.shared.marks

    @Test func itsPaletteAndItsStatesAreCores() {
        #expect(AgentMark.palette.map(\.name) == marks.palette.map(\.name))
        #expect(AgentMark.palette.map(\.forms.light) == marks.palette.map(\.light))
        #expect(AgentMark.palette.map(\.forms.dark) == marks.palette.map(\.dark))
        #expect(AgentMark.grey == marks.grey)
        #expect(MarkState.allCases.map(\.rawValue) == marks.states)
    }

    @Test func whatAnAgentIsDoingIsItsMarksStateAsCores() {
        #expect(marks.stateOf.count == 11)
        for item in marks.stateOf {
            #expect(MarkState(expression: item.expression).rawValue == item.state, "\(item.expression)")
            // A face given its mood shows the same: waiting on you is its `needs`.
            #expect(MarkState(Orb.Mood(expression: item.expression)).rawValue == item.state, "\(item.expression)")
        }
        #expect(MarkState(expression: "dancing") == .idle && MarkState(expression: nil) == .idle)
    }

    @Test func aHandlesSeedIsFNV1aOverItsUTF16AsCoresIs() {
        // (core's handleSeed of each, as the vectors' agentOrbs.seeds have them: two quotes, a backslash and an emoji with
        // its variation selector among them, each counted in UTF-16 code units.)
        let seeds: [(String, UInt32)] = [("", 2_166_136_261), ("a", 3_826_002_220), ("foobar", 3_214_735_720), ("coder", 3_469_596_402), ("Will\u{2019}s \u{201C}iPad\u{201D} \\ \u{1F6E1}\u{FE0F}", 3_419_317_483)]
        for (id, seed) in seeds { #expect(AgentMark.seed(id) == seed, "\(id)") }
    }

    @Test func aColourYouPickSnapsAsCoresToTheLastBit() {
        // sRGB's levels in linear light, to the last bit: the snap raises nothing to a power.
        #expect(AgentMark.linear.count == 256)
        #expect(AgentMark.linear == marks.linear)
        for item in marks.snaps { #expect(AgentMark.snap(item.hex) == item.color, "\(item.hex)") }
        // Every colour of the grid core snapped: 18 levels a channel, red slowest.
        var grid = ""
        for r in stride(from: 0, to: 256, by: 15) {
            for g in stride(from: 0, to: 256, by: 15) {
                for b in stride(from: 0, to: 256, by: 15) { grid += String(AgentMark.snap("#" + [r, g, b].map { $0 < 16 ? "0" + String($0, radix: 16) : String($0, radix: 16) }.joined())) }
            }
        }
        #expect(grid == marks.snapGrid)
        // A pale mint is Teal's, never Violet's; red, which isn't among the eight, is Amber's; each of the eight is its own.
        #expect(AgentMark.palette[AgentMark.snap("#b9dfd4")].name == "Teal")
        #expect(AgentMark.palette[AgentMark.snap("#ff0000")].name == "Amber")
        for (n, hue) in AgentMark.palette.enumerated() {
            #expect(AgentMark.snap(hue.forms.light) == n && AgentMark.snap(hue.forms.dark) == n, "\(hue.name)")
        }
        // What isn't six hex digits is the first, as core's arithmetic comes to.
        #expect(AgentMark.snap("blue") == 0 && AgentMark.snap("#12345g") == 0)
    }

    @Test func aSavedMarkIsReadStrictlyAsCoresIs() throws {
        #expect(marks.profiles.count == 6)
        for item in marks.profiles {
            #expect((AgentMark.read(item.profile) != nil) == item.saved, "\(item.id) \(String(describing: item.profile))")
            let mark = item.mark.map { AgentMark(color: $0.color, form: $0.form) }
            #expect(AgentMark.read(item.profile) == mark, "\(item.id) \(String(describing: item.profile))")
        }
        // As the node sends it, read by the app's own decoding: every form, 0 and 1 among them, is a number, never a yes or no.
        for form in 0..<AgentMark.forms {
            let sent = try JSONDecoder().decode(JSONValue.self, from: Data(##"{"v":3,"color":"#0084ba","form":\##(form)}"##.utf8))
            #expect(AgentMark.read(sent) == AgentMark(color: 4, form: form), "\(form)")
        }
        // Not a mark: half a form, a form in words, a colour not among the eight's light forms.
        for text in [##"{"v":3,"color":"#0084ba","form":1.5}"##, ##"{"v":3,"color":"#0084ba","form":"1"}"##, ##"{"v":3,"color":"#0084BA","form":1}"##, ##"{"v":"3","color":"#0084ba","form":1}"##] {
            #expect(AgentMark.read(try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) == nil, "\(text)")
        }
        // A colour chosen before the marks: lowercased, which its glass then snaps (AgentGlass.of).
        let chosen = try JSONDecoder().decode(JSONValue.self, from: Data(##"{"v":2,"color":"#3ABEFF"}"##.utf8))
        #expect(AgentMark.chosenColor(chosen) == "#3abeff")
    }

    @Test func aTasksLiveActivityShowsHowItStandsInItsAgentsMark() {
        let at = 1_764_000_000_000.0
        let of = { (phase: String, verdict: String?) in TaskActivityState(phase: phase, gates: [], review: nil, verdict: verdict, gate: nil, at: at).markState }
        #expect(of("queued", nil) == .queued)
        #expect(of("running", nil) == .working && of("review", nil) == .working)
        #expect(of("interrupted", nil) == .needs)
        for verdict in ["failed", "rejected", "gave-up"] { #expect(of("ended", verdict) == .failed, "\(verdict)") }
        for verdict in ["proven", "reviewed", "stopped", "unverified"] { #expect(of("ended", verdict) == .done, "\(verdict)") }
    }

    #if os(iOS)
    @Test func aLiveActivityAnAppFromBeforeTheGlassStartedStillReads() throws {
        // Its attributes as the app before the marks wrote them: no form, its colour its orb's (drawn as a disc of it).
        let old = try JSONDecoder().decode(TaskActivityAttributes.self, from: Data(##"{"task":"task-1","title":"Ship it","agentName":"Ada","colour":"#3abeff"}"##.utf8))
        #expect(old.form == nil && old.shape == nil && old.colour == "#3abeff")
        // As the Grille's app wrote them: a form, no shape (drawn as a disc of its colour too).
        let grille = try JSONDecoder().decode(TaskActivityAttributes.self, from: Data(##"{"task":"task-1","title":"Ship it","agentName":"Ada","colour":"#0084ba","form":4}"##.utf8))
        #expect(grille.form == 4 && grille.shape == nil)
        // As this app writes them: its glass's colour (its light form) and its shape, read back the same.
        let glass = AgentGlass.of(id: "ada", profile: nil)
        let now = TaskActivityAttributes(task: "task-1", title: "Ship it", agentName: "Ada", colour: AgentMark.palette[glass.color].forms.light, shape: glass.shape)
        let again = try JSONDecoder().decode(TaskActivityAttributes.self, from: JSONEncoder().encode(now))
        #expect(again.shape == glass.shape && again.colour == now.colour)
    }
    #endif
}
