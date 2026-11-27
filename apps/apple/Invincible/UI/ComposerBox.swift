import SwiftUI

/// The message box (the owner's word of 27 November 2026, "something like t3code on desktop, and openmausbot/grokbot on
/// mobile"; the web's): one rounded box, its words across its whole width, its buttons on a line under them, attach on the
/// left and what sends on the right. No button shares the words' line, so nothing squeezes them: Queue, Steer and Stop
/// beside the field had left a phone's box a few words wide while an answer was written. A tap anywhere on it that is no
/// button puts the keys in it.
struct ComposerBox<Field: View, Leading: View, Trailing: View>: View {
    var composing: FocusState<Bool>.Binding
    @ViewBuilder let field: Field
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            field
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s3)
                .padding(.bottom, Space.s1)
            HStack(spacing: Space.s2) {
                leading
                Spacer(minLength: Space.s2)
                trailing
            }
            .padding(.horizontal, Space.s2)
            .padding(.bottom, Space.s2)
        }
        .contentShape(.rect(cornerRadius: ComposerBoxMetrics.radius, style: .continuous))
        .onTapGesture { composing.wrappedValue = true }
        .glassEffect(.regular, in: .rect(cornerRadius: ComposerBoxMetrics.radius, style: .continuous))
    }
}

enum ComposerBoxMetrics {
    /// Its corners: a thumb's round, as the web's box.
    static let radius: CGFloat = 24
    /// A button's disc in it (send, stop): drawn this size, touched at a thumb's.
    static let disc: CGFloat = 32
}

/// Send, in the box: a disc in the ink while there is something to send (the one filled thing on the screen then), quiet
/// otherwise, the same size either way so nothing moves.
struct ComposerSend: View {
    let ready: Bool
    let label: String
    let send: () -> Void

    var body: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.body.weight(.bold))
                .foregroundStyle(ready ? AnyShapeStyle(Color.onAccent) : AnyShapeStyle(.tertiary))
                .frame(width: ComposerBoxMetrics.disc, height: ComposerBoxMetrics.disc)
                .background(ready ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.fill.tertiary), in: .circle)
                .frame(minWidth: Metrics.touch, minHeight: Metrics.touch)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(!ready)
        .accessibilityLabel(label)
        .accessibilityIdentifier("send")
    }
}

/// Stop, in the box while it works: a disc in the ink.
struct ComposerStop: View {
    let label: String
    let stop: () -> Void

    var body: some View {
        Button(action: stop) {
            Image(systemName: "stop.fill")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Color.onAccent)
                .frame(width: ComposerBoxMetrics.disc, height: ComposerBoxMetrics.disc)
                .background(Color.ink, in: .circle)
                .frame(minWidth: Metrics.touch, minHeight: Metrics.touch)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// One way a message goes while it works (Queue, Steer): a capsule in the ink for the one Return does once there is
/// something to send, quiet for the other, and off while there is nothing to send.
struct ComposerChoice: View {
    let title: String
    let filled: Bool
    let ready: Bool
    let hint: String
    let send: () -> Void

    var body: some View {
        Button(action: send) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(filled ? AnyShapeStyle(Color.onAccent) : ready ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                .padding(.horizontal, Space.s3)
                .frame(minHeight: ComposerBoxMetrics.disc)
                .background(filled ? AnyShapeStyle(Color.ink) : AnyShapeStyle(.fill.tertiary), in: .capsule)
                .frame(minHeight: Metrics.touch)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(!ready)
        .accessibilityHint(hint)
    }
}
