import Foundation

/*
 * How a face stands, in two words the places that draw one pass it: a tone (its line's, or where it stands among the
 * agents) and a mood (what it is doing). An agent's mark shows its mood as a state in its shape (MarkState: AgentMark.swift);
 * the primary's I-beam wears neither. (Until 26 November 2026 these were the orbs', which drew them in light: O2 made every
 * agent a Grille and the primary an I-beam, and the orbs went.)
 */
enum Orb {
    /// Its line's tone (PrimaryNow.Tone), and red for a failure.
    enum Tone: String, CaseIterable, Sendable { case neutral, accent, warn, ok, danger }
    /// What it is doing: at rest, at work, waiting on you, queued, paused, done or failed.
    enum Mood: String, CaseIterable, Sendable { case idle, working, waiting, queued, paused, done, failed }
}

extension Orb.Tone {
    /// Its line's tone.
    init(_ tone: PrimaryNow.Tone) { self = Orb.Tone(rawValue: tone.rawValue) ?? .neutral }

    /// Where it stands among the agents, as a tone: at work, needing you, failed, new to you, or calm.
    init(_ standing: Standing) {
        switch standing {
        case .working: self = .accent
        case .needs: self = .warn
        case .failed: self = .danger
        case .verified, .unread: self = .ok
        case .paused, .queued, .resting: self = .neutral
        }
    }
}

extension Orb.Mood {
    /// Where someone stands among the agents, as a mood (lib/orb-motion.ts' orbMoodOfState): work is working, needing you
    /// is waiting, verified and new are done, failed, paused and queued are their own, at rest is idle.
    init(_ standing: Standing) {
        switch standing {
        case .working: self = .working
        case .needs: self = .waiting
        case .failed: self = .failed
        case .paused: self = .paused
        case .queued: self = .queued
        case .verified, .unread: self = .done
        case .resting: self = .idle
        }
    }

    /// A state as the node and the PWA name it; one it doesn't know is idle.
    init(state: String?) { self = Standing(rawValue: state ?? "").map(Orb.Mood.init) ?? .idle }

    /// How a task stands, as its agent's face in its thread shows it (the web's taskState, as its mark takes it): at work
    /// while it runs; waiting on you while it is proposed, or cut short for you to look at; queued; failed; stopped is
    /// paused; done is done where it was verified, and at rest where it wasn't.
    init(task status: String, verified: Bool) {
        switch status {
        case "running": self = .working
        case "proposed", "interrupted": self = .waiting
        case "queued": self = .queued
        case "failed": self = .failed
        case "stopped": self = .paused
        case "done": self = verified ? .done : .idle
        default: self = .idle
        }
    }

    /// What an agent is doing where only that is known (AgentOrb.expression), as a mood (lib/orb-motion.ts'
    /// orbMoodOfExpression): thinking, at work, reading, browsing and checking are work; waiting is queued; asking your
    /// leave waits on you; pleased is done; concerned is failed; resting is paused; idle, and anything else, is idle.
    init(expression: String?) {
        switch expression {
        case "thinking", "working", "reading", "browsing", "checking": self = .working
        case "waiting": self = .queued
        case "asking": self = .waiting
        case "pleased": self = .done
        case "concerned": self = .failed
        case "resting": self = .paused
        default: self = .idle
        }
    }
}

extension MarkState {
    /// A mood as an agent's mark shows it (core's markState of the same expression): waiting on you is its `needs`.
    init(_ mood: Orb.Mood) {
        switch mood {
        case .idle: self = .idle
        case .working: self = .working
        case .waiting: self = .needs
        case .queued: self = .queued
        case .paused: self = .paused
        case .done: self = .done
        case .failed: self = .failed
        }
    }
}
