import SwiftUI

/*
 * The primary's accents, and nothing more: its red for what needs you and for its seat, the cream ink and the black tile
 * (scripts/brand.ts writes them from apps/web/src/brand.ts), the team's mark, and a face as it stands alone (an
 * orb: OrbView.swift); and the one scale every screen is spaced on. Everything else is the system's own.
 */

/// The app's one spacing scale: the PWA's (`--sp-*` in apps/web/src/index.html; each step named as there), in points.
/// Every gap, margin and padding is one of these, so the same thing is spaced the same way wherever it is.
enum Space {
    /// Between the lines of one thing: a name and the line under it.
    static let line: CGFloat = 2
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s6: CGFloat = 24
    static let s10: CGFloat = 40
}

/// What the screens share beyond the scale: a page's margins, the faces' sizes, and the corners of what sits on a page.
enum Metrics {
    /// A page's side margins, and the space between the items of a timeline.
    static let margin = Space.s4
    /// A face in a row of the agents: the primary's, an agent's, a room's members'.
    static let rowFace: CGFloat = 56
    /// What the ring round a face among the agents takes of each side, its stroke and the gap inside it: in a row, and
    /// on a card.
    static let rowRing = Space.s1
    static let cardRing = Space.s2
    /// The column the faces of the team's rows stand in, ring and all, so every name starts at one edge.
    static let rowSeat = rowFace + 2 * rowRing
    /// A face on a card of the agents: large enough for its sphere's glyphs to be read, and its arcs round it.
    static let cardFace: CGFloat = 104
    /// The narrowest a card of the agents is: its face in its ring, and room either side.
    static let cardWidth = cardFace + 2 * cardRing + 2 * Space.s4
    /// A speaker's face beside what it said.
    static let speakerFace: CGFloat = 32
    /// What your bubble leaves free at its side: a speaker's face and its gap, and the room a reply leaves at the other
    /// side, so a bubble of yours is never wider than one of theirs.
    static let yoursInset = speakerFace + Space.s2 + Space.s6
    /// The face that welcomes you to a timeline with nothing in it yet.
    static let welcomeFace: CGFloat = 120
    /// The column an icon stands in beside its words, so the words start at one edge whatever the icon.
    static let iconColumn: CGFloat = 28
    /// The smallest a thing to tap is, and the height of a field beside a button (Apple's 44 points).
    static let touch: CGFloat = 44
    /// The corners of a bubble and of a card in a timeline.
    static let cardRadius: CGFloat = 20
    /// The corners of what sits inside one (code, figures, a page, a screen), and of a field.
    static let innerRadius: CGFloat = 12
    /// What a bubble's words keep from its edges (Messages' own); a card keeps `Space.s3` all round, so the words of
    /// both start the same distance in.
    static let bubblePadding = EdgeInsets(top: Space.s2, leading: Space.s3, bottom: Space.s2, trailing: Space.s3)
}

extension Color {
    /// The ink, the app's accent: the black tile on light, the cream on dark. Set as the tint at the root, since the
    /// system's controls took system blue from the asset catalog's accent alone (seen on iOS 26.1).
    static let ink = Color(.accent)
    /// The red: what went wrong, and what can't be undone.
    static let danger = Color(.danger)

    // What is going on among the agents, one colour each and the PWA's too (its --work, --needs, --failed, --ok; lib/
    // agent-state.ts): blue at work, amber for what waits on you, red for a failure, green for what ended and is new to
    // you (verified work among it). No pair can be mistaken with full colour vision, light or dark (each at least 15
    // apart in OKLab); under red-green colour blindness the words beside them tell them apart.
    static let working = Color(light: "#0a5fcc", dark: "#58a6ff")
    static let needs = Color(light: "#946200", dark: "#f0b549")
    static let failed = Color(light: "#c4141b", dark: "#ff6b6b")
    static let done = Color(light: "#137a43", dark: "#4cc38a")
    /// What is written on the ink (the accent): cream on the black tile, black on the cream.
    static let onAccent = Color(.onAccent)
    static let tile = Color(.tile)
    static let cream = Color(.cream)
}

/// A face as it stands alone, beside its words, in a header or a pick list (the PWA's workerAvatar; your word, 25 November
/// 2026: "drop the agent avatars, and just use custom/procedurally generated colored particle orbs"): an agent's orb
/// (AgentFace), or the primary's own (`primary`), moving as what it is doing does (`expression`, as AgentOrb.expression
/// says it), on its own course (`face:<handle>`, its `primary:face`). Without an expression it is still: a speaker in a
/// conversation's history keeps no state of its own. Decorative beside its name; named (`label`) where it stands alone.
struct WorkerFace: View {
    /// An agent's handle, or `primary` for Invincible itself (a handle no agent can have).
    let id: String
    /// Its saved avatar: a colour you chose for it (core's OrbProfile); anything else is its handle's colour.
    var profile: JSONValue? = nil
    var size: CGFloat = 40
    /// What it is doing (AgentOrb.expression); nil: still.
    var expression: String? = nil
    var label: String? = nil

    var body: some View {
        let mood = expression.map { Orb.Mood(expression: $0) }
        if id == "primary" {
            PrimaryOrb(size: size, label: label, mood: mood, key: "primary:face")
        } else {
            AgentFace(id: id, profile: profile, size: size, mood: mood, label: label, key: "face:\(id)")
        }
    }
}

extension Color {
    /// A colour from its six hex digits (an orb's: a colour from a profile is checked to be six hex digits first).
    init(hex: String) {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }

    /// One colour on light, another on dark (the PWA's `light-dark()`), by six hex digits each.
    init(light: String, dark: String) {
        func rgb(_ hex: String) -> (Double, Double, Double) {
            let value = Int(hex.dropFirst(), radix: 16) ?? 0
            return (Double((value >> 16) & 0xff) / 255, Double((value >> 8) & 0xff) / 255, Double(value & 0xff) / 255)
        }
        let (l, d) = (rgb(light), rgb(dark))
        #if os(iOS)
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: d.0, green: d.1, blue: d.2, alpha: 1) : UIColor(red: l.0, green: l.1, blue: l.2, alpha: 1) })
        #else
        self.init(NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: d.0, green: d.1, blue: d.2, alpha: 1) : NSColor(red: l.0, green: l.1, blue: l.2, alpha: 1) })
        #endif
    }
}

extension Highlight.Tone {
    /// Its colour, light and dark (the PWA's .tok-* and --code-*): a language's words in the cross's red, quiet blues for
    /// what code holds, comments receding; a diff's lines in green and red.
    var color: Color {
        switch self {
        case .keyword: Color(light: "#b3261e", dark: "#ff8a80")
        case .string: Color(light: "#0a3069", dark: "#a5d6ff")
        case .number: Color(light: "#0550ae", dark: "#79c0ff")
        case .comment: Color(light: "#6e7781", dark: "#8b949e")
        case .added: Color(light: "#116329", dark: "#7ee2a8")
        case .removed: Color(light: "#82071e", dark: "#ffa198")
        case .meta: .secondary
        }
    }

    /// A diff's line, under its words.
    var shade: Color? {
        switch self {
        case .added: Color(light: "#dafbe1", dark: "#1d3a26")
        case .removed: Color(light: "#ffebe9", dark: "#3d1f20")
        default: nil
        }
    }
}

extension Highlight {
    /// Code as one attributed string in its colours (the PWA's ui/markdown.ts codeBlock).
    static func attributed(_ code: String, lang: String) -> AttributedString {
        var out = AttributedString()
        for piece in pieces(code, lang: lang) {
            var part = AttributedString(piece.text)
            if let tone = piece.tone {
                part.foregroundColor = tone.color
                if let shade = tone.shade { part.backgroundColor = shade }
                if tone == .comment { part.inlinePresentationIntent = .emphasized }
                if tone == .meta { part.inlinePresentationIntent = .stronglyEmphasized }
            }
            out += part
        }
        return out
    }
}

/// The app's name as its wordmark, beside its mark (AppMark) at the head of a sidebar, as the web's `.wordmark-text` and
/// Android's sidebar have it (docs/DESIGN.md): INVINCIBLE in the system's sans, capitals at semibold, tracked 0.2 em. No
/// lettering of its own; the spacing does the work. VoiceOver reads the name.
struct Wordmark: View {
    var body: some View {
        Text(verbatim: "INVINCIBLE")
            .font(.caption.weight(.semibold))
            .tracking(2.4)
            .accessibilityLabel("Invincible")
    }
}

/// The agents' mark: the system's people, as the Agents place shows them everywhere else (Home's "…", the sidebar), in the
/// ink; on a row chosen with a fill of the ink (a Mac's sidebar, its window in front), where the ink would vanish, white as
/// the row's words are.
struct AgentsMark: View {
    var size: CGFloat = 28
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        Image(systemName: "person.3")
            .resizable()
            .scaledToFit()
            .foregroundStyle(prominence == .increased ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.ink))
            .frame(width: size, height: size)
            .accessibilityLabel("The agents")
    }
}

extension View {
    /// A field outside a form (a key to seal, text for an agent's screen): the system's quiet fill, the corners of what
    /// sits inside a card, and a thumb's height. Beside a button, the row is made as tall as its tallest, so the two match.
    func quietField() -> some View {
        plainField()
            .padding(.horizontal, Space.s3)
            .frame(minHeight: Metrics.touch)
            .background(.fill.tertiary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
    }
}

/// The mark on what needs you: an amber orb, calling with a wave of its light.
struct NeedsMark: View {
    var body: some View {
        OrbPip(color: .needs, size: 10, waves: true).accessibilityLabel("Needs you")
    }
}

/// The mark on what is new to you (a room where something ended since you looked), until you open it: a green orb.
struct NewMark: View {
    var body: some View {
        OrbPip(color: .done, size: 10).accessibilityLabel("Something new")
    }
}

/// Something at work (the PWA's "live" dot): a small orb in its colour with a soft halo, sending out a wave of its light
/// (your word, 24 November 2026: "pulsing/moving when doing a task"). The words beside it say what is going on.
struct LiveDot: View {
    var color: Color = .ink

    var body: some View {
        OrbPip(color: color, size: 6, waves: true)
            .padding(Space.line)
            .background(color.opacity(0.22), in: .circle)
            .accessibilityHidden(true)
    }
}

/// A state's dot as a small orb of its colour, lit from above (the PWA's `.dot`; your word, 24 November 2026: everything
/// orbs). With `waves`, for something going on, it sends out a wave of its light every 2.2 seconds, growing to nearly
/// three times its size as it fades, unless the device asks for reduced motion. The wave takes nothing of the layout.
struct OrbPip: View {
    let color: Color
    var size: CGFloat = 8
    var waves = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            // (As the PWA's radial-gradient(circle at 34% 30%, …): out to its farthest corner, 0.96 of its width.)
            .fill(RadialGradient(stops: [
                .init(color: color.mix(with: .white, by: 0.55), location: 0),
                .init(color: color, location: 0.55),
                .init(color: color.mix(with: .black, by: 0.28), location: 1),
            ], center: UnitPoint(x: 0.34, y: 0.3), startRadius: 0, endRadius: size * 0.96))
            .frame(width: size, height: size)
            .background {
                if waves && !reduceMotion {
                    TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
                        // Fast, then slowing, as the PWA's ease-out has it.
                        let gone = 1 - pow(1 - (OrbCourses.seconds(timeline.date) / 2.2).truncatingRemainder(dividingBy: 1), 4)
                        Circle().fill(color)
                            .frame(width: size, height: size)
                            .scaleEffect(1 + 1.9 * gone)
                            .opacity(0.55 * (1 - gone))
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
    }
}
