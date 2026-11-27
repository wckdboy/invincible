import SwiftUI

/*
 * An avatar's state, as its dot (Core/Glass.swift's AgentGlass.Dot, core's GLASS_DOT): cut out of whatever it sits on,
 * at the bottom-right corner, its size by the avatar's. Shared by the app's glass (UI/GlassView.swift) and a Live
 * Activity's (InvincibleWidgets), so both say a state the same way.
 */

/// The dot an avatar's state is shown by, cut out of what is under it: the content first, a ring the dot's cut wide
/// taken out of it where the dot goes, then the dot (idle: a ring in its colour round nothing).
struct GlassCut<Content: View>: View {
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
