import SwiftUI

/*
 * The faces (O2, 26 November 2026): an agent is its mark, the Grille (AgentMark.swift's numbers, core's), a disc in its own
 * colour cut into slats at its own angle; the primary is the I-beam in the page's ink, never a Grille. Where a mark is one
 * of many (a row, a conversation's history) it is still: drawn once, and not again until what it shows changes. Where it
 * is the one you are looking at, it moves as its state does (working: its slats slide, calmly; asking you: its top slat
 * beats; done and failed: once, as they arrive), only while the app is in front, never where the device asks for reduced
 * motion, and not at all at rest. Its state is in its shape (the top slat in ink when it asks you, the bottom one red and
 * knocked loose when its work failed, pale while queued, grey while paused), never in colour alone.
 */

/// The primary, as a face: the I-beam in the page's ink (the owner's word, 26 November 2026: "the primary shown by the
/// I-beam in one ink"), never a mark and never moving; where it stands is said by the words beside it. `tone`, `mood` and
/// `key` are kept for the places that pass them; the I-beam wears none of them. Decorative beside its name; named
/// (`label`) where it stands alone.
struct PrimaryOrb: View {
    var size: CGFloat = 36
    var tone: Orb.Tone = .neutral
    var label: String? = nil
    var mood: Orb.Mood? = nil
    var key = "primary"

    var body: some View {
        IBeam()
            .fill(.primary)
            .frame(width: size, height: size)
            .markLabel(label)
    }
}

/// An agent's face: its mark (AgentMark.of: the one its node gave it, or what an older node's avatar says, or its
/// handle's), the same on every device.
struct AgentFace: View {
    /// Its handle.
    let id: String
    /// Its saved avatar: its mark (`{v: 3, color, form}`), or a colour chosen for it before the marks (`{v: 2, color}`).
    var profile: JSONValue? = nil
    var size: CGFloat = 40
    /// What it is doing, its mark moving as it does where it may; nil: idle, still.
    var mood: Orb.Mood? = nil
    /// Its state shown still, as a row shows it ("rows are always still"): the shape without the motion.
    var still = false
    var label: String? = nil
    /// Kept for the places that pass it: a mark moves on the page's clock, the same wherever it is drawn.
    var key: String? = nil

    var body: some View {
        AgentMarkView(mark: AgentMark.of(id: id, profile: profile), seed: AgentMark.seed(id), state: MarkState(mood ?? .idle), size: size, moves: mood != nil && !still)
            .markLabel(label)
    }
}

extension View {
    /// A face's name for VoiceOver, where it stands alone; beside its name it is decorative.
    fileprivate func markLabel(_ label: String?) -> some View {
        accessibilityElement()
            .accessibilityLabel(label ?? "")
            .accessibilityAddTraits(.isImage)
            .accessibilityHidden(label == nil)
    }
}

/// A mark drawn: still (a row, reduced motion, the app not in front, or a state with nothing to move), or moving as its
/// state does: a frame at a time while it works (20 a second) or asks you, and while it arrives at done or failed (30 a
/// second, for a second and a half at most); nothing at all at rest.
struct AgentMarkView: View {
    let mark: AgentMark
    /// Its handle's seed: its slats' phase as they slide.
    let seed: UInt32
    var state: MarkState = .idle
    let size: CGFloat
    /// Whether it may move: where it is the one you are looking at. A row's never does.
    var moves = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// The state it came to while you were looking, and when (done settling, failed knocked loose); nil: long ago.
    @State private var arrival: Arrival?

    private struct Arrival: Equatable {
        let state: MarkState
        let at: Date
    }

    /// The page's clock, in seconds: every mark's motion is read from it, so two of one agent move as one.
    private static let epoch = Date()

    var body: some View {
        let theme: AgentMark.Theme = scheme == .dark ? .dark : .light
        let live = moves && !reduceMotion && scenePhase == .active
        let arriving = arrival?.state == state ? arrival : nil
        Group {
            if live, arriving != nil || state == .working || state == .needs {
                TimelineView(.animation(minimumInterval: arriving != nil ? 1.0 / 30 : 1.0 / 20)) { timeline in
                    MarkPicture(mark: mark, seed: seed, state: state, size: size, theme: theme, t: timeline.date.timeIntervalSince(Self.epoch), since: arriving.map { timeline.date.timeIntervalSince($0.at) })
                }
            } else {
                MarkPicture(mark: mark, seed: seed, state: state, size: size, theme: theme, t: nil, since: nil)
                    .equatable()
            }
        }
        .frame(width: size, height: size)
        // (Only where it may move: a row's state is drawn still, and comes with no arrival to time.)
        .onChange(of: state) { _, new in if moves { arrival = new == .done || new == .failed ? Arrival(state: new, at: .now) : nil } }
        .task(id: arrival) {
            guard let arrival else { return }
            try? await Task.sleep(for: .seconds(arrival.state == .done ? AgentMark.Timing.doneSettle : AgentMark.Timing.failDrop))
            if !Task.isCancelled, self.arrival == arrival { self.arrival = nil }
        }
    }
}

/// A mark as it stands at a moment (`t` and `since` nil: still): its slats, each filled as its body or its key. Compared
/// by what it is drawn from, so a row drawn again draws nothing.
private struct MarkPicture: View, Equatable {
    let mark: AgentMark
    let seed: UInt32
    let state: MarkState
    let size: CGFloat
    let theme: AgentMark.Theme
    let t: Double?
    let since: Double?

    var body: some View {
        let geometry = AgentMark.geometry(mark, seed: seed, state: state, size: Double(size), t: t, since: since)
        let colors = AgentMark.colors(mark.color, state: state, theme: theme)
        let fill = Color(hex: colors.body), keyFill = Color(hex: colors.key)
        Canvas { context, canvas in
            for slat in AgentMark.paths(geometry, side: min(canvas.width, canvas.height)) {
                context.fill(Path(slat.path), with: .color(slat.key ? keyFill : fill))
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
    }
}
