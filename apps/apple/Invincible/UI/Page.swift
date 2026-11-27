import SwiftUI

/*
 * What every screen beyond Home shares with it (the owner's bar, 26 November 2026: "the iOS app need some serious work";
 * X2's rules, held on every screen): one type scale, SF Pro Display bold for titles; a state as a still dot with its word;
 * sections named in small capitals over rows split by hairlines, never boxed in cards; one prominent action a screen.
 */

/// The app's one type scale. Every size is one of Dynamic Type's, so all of it grows to the accessibility sizes; SF Pro
/// is SF Pro Display from 20 points up, so a title is Display and everything under it Text.
enum Typeset {
    /// A screen's title where the screen says it itself (Home's name, a task's title, the drawer's head): 22 points, SF
    /// Pro Display, bold. (A place's title in its bar is the system's large title: 34 points, Display, bold.)
    static let title = Font.title2.bold()
    /// A row's name, what a decision asks, a verdict.
    static let row = Font.subheadline.weight(.semibold)
    /// What is read: a brief, an agent's words, a page's own explanation.
    static let body = Font.callout
    /// A row's second line, a note, a step.
    static let detail = Font.footnote
    /// A time, a count, what stands beside.
    static let caption = Font.caption
    /// A section's name, in small capitals (SectionHead).
    static let section = Font.caption.weight(.bold)
}

/// A state as a still dot and its word (never a colour alone, never a pill): the ink at work and for what needs you, the
/// system's grey for the rest, red only for what went wrong.
struct StateLabel: View {
    enum Tone { case active, quiet, failed }

    let word: String
    var tone: Tone = .quiet
    /// What needs you is said in the ink's full weight.
    var strong = false

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(ink).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(word).fontWeight(strong ? .semibold : .regular)
        }
        .foregroundStyle(ink)
    }

    private var ink: Color {
        switch tone {
        case .active: .primary
        case .quiet: .secondary
        case .failed: .danger
        }
    }

    /// A tone of the PWA's (Standing.tone, a badge's): at work and what needs you are active, a failure is failed.
    static func tone(_ tone: String) -> Tone {
        switch tone {
        case "work", "needs", "warn", "accent": .active
        case "failed", "danger": .failed
        default: .quiet
        }
    }
}

extension Standing {
    /// Its word where a screen shows it beside a name: the chip's (a task that ended verified is "New" to you until you
    /// open it, never "Verified" over a verdict that may say it wasn't proven).
    var shown: String? { word }
}

/// A section's name as Home has it: small capitals, tracked, in the secondary ink (the ink where it needs you, red where
/// it failed), and how many where that says something.
extension SectionHead {
    init(_ title: String, strong: Bool = false) {
        self.init(title: title, count: nil, strong: strong)
    }
}

/// A place's own words of what it is, under its title: quiet, and no card round them.
struct PageNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typeset.detail)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

extension View {
    /// A page of rows split by hairlines on the page's own ground, as Home is (an iPhone's and an iPad's list; a Mac keeps
    /// its grouped form, GroupedList).
    func hairlinePage() -> some View {
        #if os(iOS)
        listStyle(.plain)
        #else
        self
        #endif
    }

    /// A place's title in its bar, large, as a page of rows has it on an iPhone (SF Pro Display bold), inline elsewhere.
    func placeTitle(_ title: String) -> some View {
        #if os(iOS)
        navigationTitle(title).navigationBarTitleDisplayMode(.large)
        #else
        navigationTitle(title)
        #endif
    }
}

extension Section where Parent == SectionHead, Footer == EmptyView, Content: View {
    /// A section under its name in small capitals (SectionHead), as Home's are. (On the main actor, as SectionHead is.)
    @MainActor init(head title: String, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { SectionHead(title) })
    }
}
