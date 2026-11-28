import CoreGraphics
import CoreImage
import QuartzCore
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/*
 * An agent's glass, drawn (Core/Glass.swift's numbers, core's): its shape in its ramp, as one picture made once for each
 * shape, ramp, size, page and screen and kept (with its blur from 40 pt); its glow beside it, a pool of its light behind
 * it on a dark page and a tinted shadow under it on a light one; and its state's dot, cut out of whatever it sits on.
 * Only working moves: its light breathes, by opacity, while the app is in front and the device doesn't ask for reduced
 * motion, Core Animation turning it so the app does no work between frames. Nothing it draws lays anything out beyond its
 * own box.
 */

/// An agent's glass: its shape in its ramp, its glow, and its state's dot where its state is known; knocking while it
/// waits on you, where its knocks are given (AgentFace's `knock`).
struct GlassMarkView: View {
    let glass: AgentGlass
    let size: CGFloat
    var state: AgentGlass.State? = nil
    var knock: GlassKnock? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let theme: AgentMark.Theme = scheme == .dark ? .dark : .light
        GlassCut(size: size, state: state, theme: theme) {
            ZStack {
                GlassGlow(ramp: AgentGlass.ramps[glass.color], size: size, theme: theme, working: state == .working)
                GlassPicture(shape: glass.shape, ramp: glass.color, size: size, theme: theme, scale: displayScale)
            }
            .modifier(Knocking(knock: state == .needs ? knock : nil))
        }
    }
}

/// A knock armed for an agent's glass (Session.knocks): its agent, and how many were armed for it this session.
struct GlassKnock: Hashable, Sendable {
    let agent: String
    let armed: Int
}

/// Which knock each agent's glass has given, for the app's life: a glass drawn again (a face scrolled back, its chat's
/// bar) doesn't knock again for the same need.
@MainActor enum GlassKnocked {
    private static var given: [String: Int] = [:]

    /// Whether this glass gives the knock (the latest armed for its agent, not given yet), taking it if so.
    static func take(_ knock: GlassKnock) -> Bool {
        guard knock.armed > (given[knock.agent] ?? 0) else { return false }
        given[knock.agent] = knock.armed
        return true
    }
}

/// A glass that waits on you, knocking (core's GLASS_NUDGE; the lead's words of 28 November 2026: "the avatar's nudge is its
/// motion, not a colour", "knock three times, then rest"): for a knock armed for its agent, three knocks through its turns,
/// one at each multiple of Nudge.every of the clock so the glasses that wait on you knock together; then still, asking for
/// no frame. Where motion is reduced it is still, the knock taken all the same, so motion turned on later doesn't knock for
/// an old need.
private struct Knocking: ViewModifier {
    let knock: GlassKnock?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turned = 0.0

    func body(content: Content) -> some View {
        content
            .rotationEffect(.degrees(turned))
            .task(id: knock) {
                guard let knock, GlassKnocked.take(knock), !reduceMotion else { return }
                let turns = AgentGlass.Nudge.turns
                let step = AgentGlass.Nudge.ms / 1000 / Double(max(1, turns.count - 1))
                for _ in 0..<AgentGlass.Nudge.count {
                    let now = Date.now.timeIntervalSince1970 * 1000
                    let next = (floor(now / AgentGlass.Nudge.every) + 1) * AgentGlass.Nudge.every
                    try? await Task.sleep(for: .milliseconds(Int(next - now)))
                    for turn in turns.dropFirst() {
                        guard !Task.isCancelled else { turned = 0; return }
                        withAnimation(.linear(duration: step)) { turned = turn * AgentGlass.Nudge.turn }
                        try? await Task.sleep(for: .seconds(step))
                    }
                }
                turned = 0
            }
    }
}

/// Your agent's mark, in the box an orb takes: the bare I-beam in the page's ink, on nothing (the owner's word of 27 November
/// 2026: "the Logo is just the I beam, not the appicon squircle around it"; the squircle is the app's icon alone, on the
/// home screen, in the App Store and in Settings), or, where this device is set so (Settings), in pearl glass, lit as an
/// agent's glass is, on nothing on any page: on a light page the pearl inked (core's light stops), with no shadow under
/// it; on a dark one the pearl, glowing on its own (its pool from 24 pt); its blur from 40.
struct GuardianMark: View {
    let size: CGFloat
    @AppStorage("invincible.guardian-mark") private var style = "mono"
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let theme: AgentMark.Theme = scheme == .dark ? .dark : .light
        if style == "pearl" {
            ZStack {
                GlassGlow(ramp: AgentGlass.pearl, size: size, theme: theme, working: false, shadow: false)
                GlassPicture(shape: -1, ramp: -1, size: size, theme: theme, scale: displayScale)
            }
            .frame(width: size, height: size)
        } else {
            IBeam()
                .fill(.primary)
                .frame(width: size, height: size)
        }
    }
}

/// Its glow: a pool of its light behind it on a dark page (from 24 pt), a tinted shadow under it on a light one (from 20
/// pt). Still, it is drawn as any view is. While it works it breathes, and then it is a gradient layer of its own whose
/// opacity Core Animation turns: the render server's work, as a page's compositor runs the web's breath, so a screen of
/// working agents costs the app nothing from one frame to the next. Composited only: it lays out nothing past the box.
private struct GlassGlow: View {
    let ramp: AgentGlass.Ramp
    let size: CGFloat
    let theme: AgentMark.Theme
    let working: Bool
    /// Its tinted shadow on a light page: not for your agent's pearl, inked on nothing there (as core and the web have it).
    var shadow = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let stops = ramp.on(theme)
        let breathes = working && !reduceMotion && scenePhase == .active
        Color.clear
            .frame(width: size, height: size)
            .overlay {
                if theme == .dark, size >= AgentGlass.Glow.poolFrom {
                    let span = size * (1 + 2 * AgentGlass.Glow.poolSpread)
                    glow(AgentGlass.Glow.poolStops.map { .init(hex: $0.ofB ? stops.b : stops.a, opacity: $0.opacity, at: $0.at) }, still: AgentGlass.Glow.poolOpacity, breathe: breathes ? AgentGlass.Glow.poolBreathe : nil)
                        .frame(width: span, height: span)
                } else if shadow, theme == .light, size >= AgentGlass.Glow.shadowFrom {
                    let box = AgentGlass.Glow.shadowBox
                    glow(AgentGlass.Glow.shadowStops.map { .init(hex: stops.b, opacity: $0.opacity, at: $0.at) }, still: AgentGlass.Glow.shadowOpacity, breathe: breathes ? AgentGlass.Glow.shadowBreathe : nil)
                        .frame(width: size * (1 - box.left - box.right), height: size * (box.bottom - box.top))
                        .offset(y: size * ((box.top + box.bottom) / 2 - 0.5))
                }
            }
            .allowsHitTesting(false)
    }

    /// Its gradient, from the middle of its frame to its edge (an ellipse where the frame isn't square): still at `still`,
    /// or breathing from `breathe` to all of it and back.
    @ViewBuilder private func glow(_ stops: [BreathingGradient.Stop], still: Double, breathe: Double?) -> some View {
        if let breathe {
            BreathingGradient(stops: stops, from: breathe)
        } else {
            Ellipse()
                .fill(EllipticalGradient(stops: stops.map { .init(color: Color(hex: $0.hex).opacity($0.opacity), location: $0.at) }, center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
                .opacity(still)
        }
    }
}

/// A gradient from the middle of its frame out to its edge, breathing: its opacity from `from` to all of it and back every
/// Glow.period seconds, eased, as a Core Animation animation the render server runs on its own. Made again (and so begun
/// again) only when what it breathes from changes.
private struct BreathingGradient {
    struct Stop {
        let hex: String
        let opacity: Double
        let at: Double
    }

    let stops: [Stop]
    let from: Double

    func configure(_ layer: CAGradientLayer) {
        layer.type = .radial
        layer.startPoint = CGPoint(x: 0.5, y: 0.5)
        layer.endPoint = CGPoint(x: 1, y: 1)
        layer.colors = stops.map { stop in
            let value = Int(stop.hex.dropFirst(), radix: 16) ?? 0
            return CGColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: stop.opacity)
        }
        layer.locations = stops.map { NSNumber(value: $0.at) }
        if (layer.animation(forKey: "breath") as? CABasicAnimation)?.fromValue as? Double == from { return }
        let breath = CABasicAnimation(keyPath: "opacity")
        breath.fromValue = from
        breath.toValue = 1.0
        breath.duration = AgentGlass.Glow.period / 2
        breath.autoreverses = true
        breath.repeatCount = .infinity
        breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        breath.isRemovedOnCompletion = false
        layer.add(breath, forKey: "breath")
    }
}

#if os(iOS)
extension BreathingGradient: UIViewRepresentable {
    final class Layered: UIView {
        override class var layerClass: AnyClass { CAGradientLayer.self }
    }

    func makeUIView(context: Context) -> Layered {
        let view = Layered()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: Layered, context: Context) {
        if let layer = view.layer as? CAGradientLayer { configure(layer) }
    }
}
#else
extension BreathingGradient: NSViewRepresentable {
    final class Layered: NSView {
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
        }

        required init?(coder: NSCoder) {
            super.init(coder: coder)
            wantsLayer = true
        }

        override func makeBackingLayer() -> CALayer { CAGradientLayer() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Layered { Layered() }

    func updateNSView(_ view: Layered, context: Context) {
        if let layer = view.layer as? CAGradientLayer { configure(layer) }
    }
}
#endif

/// The shape in its ramp, with its blur from 40 pt: one picture for each shape, ramp, size, page and screen, made once and
/// kept. `shape` and `ramp` -1: the Guardian's I-beam in pearl (inked on a light page, as core's light stops are).
private struct GlassPicture: View, Equatable {
    let shape: Int
    let ramp: Int
    let size: CGFloat
    let theme: AgentMark.Theme
    let scale: CGFloat

    var body: some View {
        let picture = GlassPictures.picture(shape: shape, ramp: ramp, size: size, theme: theme, scale: scale)
        Color.clear
            .frame(width: size, height: size)
            .overlay {
                if let picture {
                    Image(decorative: picture.image, scale: scale)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: size * picture.span, height: size * picture.span)
                }
            }
            .allowsHitTesting(false)
    }
}

/// The pictures, kept: drawing one is the work (its paint's four layers and its blur), showing it is not.
@MainActor
enum GlassPictures {
    struct Key: Hashable {
        let shape: Int
        let ramp: Int
        let size: Int
        let dark: Bool
        let scale: Int
    }

    /// A picture spans this much of the avatar's box each way (with room round it for the blur).
    private static let pad: CGFloat = 0.3
    private static var kept: [Key: (image: CGImage, span: CGFloat)] = [:]
    private static let context = CIContext(options: [.cacheIntermediates: false])

    static func picture(shape: Int, ramp: Int, size: CGFloat, theme: AgentMark.Theme, scale: CGFloat) -> (image: CGImage, span: CGFloat)? {
        let key = Key(shape: shape, ramp: ramp, size: Int((size * 4).rounded()), dark: theme == .dark, scale: Int((scale * 4).rounded()))
        if let found = kept[key] { return found }
        let drawn = GlassDrawing.draw(shape: shape < 0 ? AgentGlass.ibeam : AgentGlass.shapes[shape], ramp: ramp < 0 ? AgentGlass.pearl : AgentGlass.ramps[ramp], size: size, theme: theme, scale: scale, pad: pad, blur: size >= AgentGlass.Glow.blurFrom ? context : nil)
        if let drawn { kept[key] = (drawn, 1 + 2 * pad) }
        return drawn.map { ($0, 1 + 2 * pad) }
    }
}
