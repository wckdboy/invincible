import ActivityKit
import SwiftUI
import WidgetKit

/*
 * Invincible's widgets: a task's proof on the Lock Screen and in the Dynamic Island (I10, 26 November 2026; the X2
 * study's seventh item: no rival shows proof there). The agent's orb is the only colour, as in the app; red only where
 * it went wrong. What it says is the activity's state alone (TaskActivityState: where it is, each gate, the reviewer,
 * the verdict), and its title, which the app gave it on the device.
 */
@main
struct InvincibleWidgets: WidgetBundle {
    var body: some Widget {
        TaskActivityWidget()
    }
}

struct TaskActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TaskActivityAttributes.self) { context in
            LockScreenActivity(attributes: context.attributes, state: context.state)
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(Self.url(context.attributes))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentDisc(colour: context.attributes.colour, size: 40).padding(.leading, 4)
                }
                // (First call on the width: the title beside it takes whatever is left, and broke "Review" in two.)
                DynamicIslandExpandedRegion(.trailing, priority: 1) {
                    StandingWord(state: context.state).font(.subheadline.weight(.semibold)).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Text(context.attributes.agentName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 8) {
                        GateMarks(state: context.state)
                        Spacer(minLength: 4)
                        Text(context.state.line).font(.caption).foregroundStyle(context.state.failed ? AnyShapeStyle(Danger.red) : AnyShapeStyle(.secondary)).lineLimit(1)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                AgentDisc(colour: context.attributes.colour, size: 18)
            } compactTrailing: {
                StandingWord(state: context.state).font(.caption.weight(.semibold)).monospacedDigit()
            } minimal: {
                if context.state.ended { VerdictMark(state: context.state, size: 18) } else { AgentDisc(colour: context.attributes.colour, size: 18) }
            }
            .widgetURL(Self.url(context.attributes))
            .keylineTint(Color(hex: context.attributes.colour))
        }
    }

    /// A tap opens the task's thread (the app's invincible://task/<id>).
    static func url(_ attributes: TaskActivityAttributes) -> URL? { URL(string: "invincible://task/\(attributes.task)") }
}

/// The Lock Screen's: the agent's orb, the task's title, who has it and how it stands in a line, each gate, and once it
/// has ended its verdict's mark.
struct LockScreenActivity: View {
    let attributes: TaskActivityAttributes
    let state: TaskActivityState

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentDisc(colour: attributes.colour, size: 36)
            VStack(alignment: .leading, spacing: 6) {
                Text(attributes.title).font(.headline).lineLimit(2)
                Text("\(Text(attributes.agentName).fontWeight(.semibold)) · \(Text(state.line).foregroundStyle(state.failed ? AnyShapeStyle(Danger.red) : AnyShapeStyle(.secondary)))")
                    .font(.subheadline)
                    .lineLimit(2)
                GateMarks(state: state)
            }
            Spacer(minLength: 0)
            if state.ended { VerdictMark(state: state, size: 28) }
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }
}

/// How far through its gates, or its verdict, in a word: red only where it went wrong.
struct StandingWord: View {
    let state: TaskActivityState

    var body: some View {
        Text(state.short)
            .foregroundStyle(state.failed ? AnyShapeStyle(Danger.red) : AnyShapeStyle(.primary))
            .lineLimit(1)
            .fixedSize()
    }
}

/// Each gate as it stands, and the reviewer: passed in ink, failed in red, running ringed, waiting in grey.
struct GateMarks: View {
    let state: TaskActivityState

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(state.gates.enumerated()), id: \.offset) { _, gate in
                Image(systemName: Self.symbol(gate))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(gate == "failed" ? AnyShapeStyle(Danger.red) : gate == "waiting" ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.primary))
            }
            if let review = state.review {
                Image(systemName: review == "passed" ? "person.badge.shield.checkmark.fill" : review == "sent-back" ? "arrow.uturn.backward.circle" : review == "reading" ? "eye.circle" : "person.circle")
                    .font(.footnote)
                    .foregroundStyle(review == "waits" ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.primary))
                    .padding(.leading, 4)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(state.gates.filter { $0 == "passed" }.count) of \(state.gates.count) gates passed")
    }

    static func symbol(_ gate: String) -> String {
        switch gate {
        case "passed": "checkmark.circle.fill"
        case "failed": "xmark.circle.fill"
        case "running": "circle.dotted.circle"
        default: "circle"
        }
    }
}

/// Its verdict's mark once it has ended: a tick in ink where it was proven, a cross in red where it went wrong, a dash
/// otherwise.
struct VerdictMark: View {
    let state: TaskActivityState
    let size: CGFloat

    var body: some View {
        Image(systemName: state.verdict == "proven" ? "checkmark.circle.fill" : state.failed ? "xmark.circle.fill" : "minus.circle.fill")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(state.failed ? AnyShapeStyle(Danger.red) : state.verdict == "proven" ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .accessibilityLabel(state.line)
    }
}

/// The agent's orb, as the app draws one before its field is ready: a soft disc of its own colour round a dark core.
struct AgentDisc: View {
    let colour: String
    let size: CGFloat

    var body: some View {
        let tint = Color(hex: colour)
        ZStack {
            Circle().fill(RadialGradient(colors: [tint, tint.opacity(0.55), tint.opacity(0.15)], center: .center, startRadius: 0, endRadius: size / 2))
            Circle().fill(Color.black.opacity(0.55)).frame(width: size * 0.28, height: size * 0.28)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The app's red (its Danger colour, scripts/brand.ts): for what went wrong, nothing else.
enum Danger {
    static let red = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0xee / 255, green: 0x2c / 255, blue: 0x36 / 255, alpha: 1) : UIColor(red: 0xc4 / 255, green: 0x14 / 255, blue: 0x1b / 255, alpha: 1) })
}

extension Color {
    /// A colour from "#rrggbb" (an agent's orb's); grey where it isn't one.
    init(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = Int(digits, radix: 16) else { self = .gray; return }
        self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
}
