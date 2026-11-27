import SwiftUI

/*
 * The work's rows (the PWA's views/work-rows.ts), as every list of them draws them, an iPhone's Home and a wide window's
 * sidebar alike: a task in three lines, as T3 Code's sidebar has it (your word, 26 November 2026: "project/tasks/coding
 * t3code style for the agents"): its project's badge and name, with how it stands in a word in its state's colour and
 * how long ago it moved; its title; its agent's orb, still, with its name and what it is doing or what it came to. What
 * the rows say is Work.swift's; this only draws them.
 */

extension Color {
    /// A state's ink by its tone (Standing.tone): the ink at work and for what needs you (the word and its weight say
    /// which), red for a failure, the secondary ink otherwise (Brand.swift: monochrome).
    static func tone(_ tone: String) -> Color {
        switch tone {
        case "work": .working
        case "needs", "warn": .needs
        case "failed", "danger": .failed
        case "ok": .done
        default: .secondary
        }
    }
}

/// A project's badge: its letter on a small tile, in the ink; other work's is an empty, dashed one.
struct ProjectBadge: View {
    let project: WorkProject
    var size: CGFloat = 14
    @ScaledMetric(relativeTo: .caption) private var scaled: CGFloat = 1

    var body: some View {
        let side = size * min(scaled, 1.6)
        Group {
            if project.badge.isEmpty {
                RoundedRectangle(cornerRadius: side * 0.28, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                    .foregroundStyle(.tertiary)
            } else {
                Text(project.badge)
                    .font(.system(size: side * 0.64, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.onAccent)
                    .frame(width: side, height: side)
                    .background(Color.ink, in: .rect(cornerRadius: side * 0.28, style: .continuous))
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

/// How a task stands, as its row's first line ends: its word, or once it has ended its verdict as its proof allows
/// (Proven with a tick, Reviewed, not proven in grey, Failed · gate 2 in red), never colour alone.
struct StateWord: View {
    let row: WorkRow

    var body: some View {
        HStack(spacing: 3) {
            if row.verdict?.kind == .proven { Image(systemName: "checkmark").font(.caption2.weight(.bold)) }
            Text(row.word)
        }
        .fontWeight(.semibold)
        .foregroundStyle(ink)
    }

    private var ink: Color {
        switch row.verdict?.kind {
        case .proven: .primary
        case .failed, .rejected, .gaveUp: .danger
        case .reviewed, .stopped, .unverified: .secondary
        case nil: Color.tone(row.tone)
        }
    }
}

/// A task as a row of three lines. `face`: its agent's orb's size (still: only the orb in focus moves). `current`: it is
/// the task open now. Working rows are quieter: their title in the secondary ink and their orb faded, as T3's are.
struct WorkRowView: View {
    let row: WorkRow
    var face: CGFloat = 16
    var current = false
    /// In a sidebar: closer together, as T3's are.
    var dense = false
    /// Working rows quieter than the rest (a list of every kind); Home's sections say what each is, and keep them whole.
    var quietWhenWorking = true
    @Environment(\.backgroundProminence) private var prominence
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let quiet = quietWhenWorking && row.attention == .working && !current
        let selected = prominence == .increased
        let projected = row.project.key != "other"
        // At the accessibility sizes how it stands takes a line of its own, under the title, which it would squeeze to a
        // word a line beside it.
        let stacked = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: dense ? 2 : 3) {
            // A project's name where there is one, with how it stands; where there is none, the title carries that, and
            // the row is two lines (X2: no "Other work" on every row).
            if projected {
                HStack(spacing: 6) {
                    ProjectBadge(project: row.project)
                    Text(row.project.name).lineLimit(stacked ? 2 : 1)
                    if !stacked {
                        Spacer(minLength: Space.s2)
                        standing
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Text(row.title)
                    .font(.subheadline.weight(quiet ? .regular : .semibold))
                    .foregroundStyle(quiet && !selected ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .lineLimit(stacked ? 4 : 2)
                if !projected, !stacked {
                    Spacer(minLength: Space.s2)
                    standing.font(.footnote).foregroundStyle(.secondary)
                }
            }
            if stacked { standing.font(.footnote).foregroundStyle(.secondary) }
            HStack(spacing: 6) {
                AgentFace(id: row.agent.id, profile: row.agent.avatar, size: face)
                    .opacity(quiet ? 0.62 : 1)
                Text(row.agent.name).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
                // (Not what its word says already: "Gave up", then "gave up".)
                if !row.detail.isEmpty, row.detail.lowercased() != row.word.lowercased() {
                    Text(row.detail)
                        .font(row.mono ? .caption.monospaced() : .footnote)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .font(.footnote)
        }
        .padding(.vertical, dense ? 0 : Space.s2)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.label(row))
        .accessibilityAddTraits(.isButton)
        .help(Self.label(row))
    }

    /// How it stands, and how long ago it moved.
    private var standing: some View {
        HStack(spacing: 6) {
            StateWord(row: row).layoutPriority(1)
            if let age = row.age { Text(age).monospacedDigit().layoutPriority(1) }
        }
    }

    /// A row's words for VoiceOver and a tooltip: what it is, where, how it stands and who is on it.
    static func label(_ row: WorkRow) -> String {
        [row.title, row.project.name, row.word, "\(row.agent.name)\(row.detail.isEmpty ? "" : ": \(row.detail)")", row.age.map { "\($0) ago" }].compactMap(\.self).joined(separator: ", ")
    }
}

/// A folded section's head: its name, how many, and a chevron that turns as it opens.
struct FoldHead: View {
    let title: String
    let count: Int
    @Binding var open: Bool

    var body: some View {
        Button {
            withAnimation(.snappy) { open.toggle() }
        } label: {
            HStack(spacing: Space.s2) {
                Text(title).fontWeight(.semibold)
                Spacer(minLength: Space.s2)
                Text("\(count)").monospacedDigit()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(minHeight: Metrics.touch)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityValue(open ? "Shown" : "Folded")
        .accessibilityHint(open ? "Folds them" : "Shows them")
    }
}
