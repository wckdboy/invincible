import SwiftUI

/*
 * The faces: an agent is its glass (Core/Glass.swift, UI/GlassView.swift; the owner's word of 27 November 2026 that the
 * Grille goes): a shape of our own in one of eight ramps, as its node gave them, the same on every device; its state a dot
 * beside the word, where its state is known. Only working moves, its light breathing. Your agent is the app's I-beam,
 * bare, in one ink (GuardianMark), or in pearl glass where this device is set so, on nothing on any page.
 */

/// The primary, as a face: the bare I-beam (GuardianMark), never moving; where it stands is said by the words
/// beside it. `tone`, `mood` and `key` are kept for the places that pass them; the I-beam wears none of them. Decorative
/// beside its name; named (`label`) where it stands alone.
struct PrimaryOrb: View {
    var size: CGFloat = 36
    var tone: Orb.Tone = .neutral
    var label: String? = nil
    var mood: Orb.Mood? = nil
    var key = "primary"

    var body: some View {
        GuardianMark(size: size)
            .markLabel(label)
    }
}

/// An agent's face: its glass (AgentGlass.of: the one its node gave it, or what an older node's avatar says, or its handle's),
/// the same on every device; its state a dot where a mood says it.
struct AgentFace: View {
    /// Its handle.
    let id: String
    /// Its saved avatar: its glass (`{v: 4, color, shape}`), a mark (`{v: 3, color, form}`) or a colour chosen for it
    /// before (`{v: 2, color}`).
    var profile: JSONValue? = nil
    var size: CGFloat = 40
    /// What it is doing: its dot shows it, its light breathing while it works; nil: no dot (a speaker in the history).
    var mood: Orb.Mood? = nil
    /// Kept for the places that pass it: a glass breathes wherever it works, as the web's does.
    var still = false
    var label: String? = nil
    /// Kept for the places that pass it.
    var key: String? = nil
    /// How many knocks were armed for it this session (Session.knocks), where its glass knocks while it waits on you: a
    /// face in focus (the drawer's, its chat's bar). nil: it never knocks here.
    var knock: Int? = nil

    var body: some View {
        GlassMarkView(glass: AgentGlass.of(id: id, profile: profile), size: size, state: mood.map { AgentGlass.state(MarkState($0)) }, knock: knock.map { GlassKnock(agent: id, armed: $0) })
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
