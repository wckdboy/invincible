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

/// An agent's glass: its shape in its ramp, its glow, and its state's dot where its state is known.
struct GlassMarkView: View {
    let glass: AgentGlass
    let size: CGFloat
    var state: AgentGlass.State? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let theme: AgentMark.Theme = scheme == .dark ? .dark : .light
        GlassCut(size: size, state: state, theme: theme) {
            ZStack {
                GlassGlow(ramp: AgentGlass.ramps[glass.color], size: size, theme: theme, working: state == .working)
                GlassPicture(shape: glass.shape, ramp: glass.color, size: size, theme: theme, scale: displayScale)
            }
        }
    }
}

/// Your agent's mark, in the box an orb takes: the app icon's I-beam on a tile of its own in one ink, or, where this
/// device is set so (Settings), in pearl glass: on a graphite tile on a light page, glowing on its own on a dark one.
struct GuardianMark: View {
    let size: CGFloat
    @AppStorage("invincible.guardian-mark") private var style = "mono"
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let theme: AgentMark.Theme = scheme == .dark ? .dark : .light
        if style == "pearl" {
            ZStack {
                if theme == .light { RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(Color(hex: AgentGlass.pearlTile.light)) }
                GlassPicture(shape: -1, ramp: -1, size: size, theme: theme, scale: displayScale)
            }
            .frame(width: size, height: size)
        } else {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(.primary)
                .overlay(IBeam().fill(.background))
                .frame(width: size, height: size)
        }
    }
}

/// The dot an avatar's state is shown by, cut out of what is under it: the content first, a ring the dot's cut wide
/// taken out of it where the dot goes, then the dot (idle: a ring in its colour round nothing).
private struct GlassCut<Content: View>: View {
    let size: CGFloat
    let state: AgentGlass.State?
    let theme: AgentMark.Theme
    @ViewBuilder let content: Content

    var body: some View {
        if let state {
            let dot = AgentGlass.Dot.size(for: size)
            let colour = Color(hex: AgentGlass.Dot.colors[state]!.on(theme))
            let at = CGPoint(x: size + dot.out - dot.size / 2, y: size + dot.out - dot.size / 2)
            ZStack(alignment: .topLeading) {
                content.frame(width: size, height: size)
                Circle()
                    .frame(width: dot.size + 2 * dot.cut, height: dot.size + 2 * dot.cut)
                    .position(at)
                    .blendMode(.destinationOut)
            }
            .compositingGroup()
            .overlay(alignment: .topLeading) {
                Group {
                    if state == .idle {
                        Circle().strokeBorder(colour, lineWidth: AgentGlass.Dot.idleRing)
                    } else {
                        Circle().fill(colour)
                    }
                }
                .frame(width: dot.size, height: dot.size)
                .position(at)
            }
            .frame(width: size, height: size)
        } else {
            content.frame(width: size, height: size)
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
                } else if theme == .light, size >= AgentGlass.Glow.shadowFrom {
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
/// kept. `shape` and `ramp` -1: the Guardian's I-beam in pearl.
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
